"""Durable structural corrections and their replay across census snapshots.

A correction is materialized onto the ``Employee`` rows of the active snapshot
at commit time, and journalled in ``StructureCorrection`` so it can be reverted
and re-applied to future snapshots.

Design note — why materialize instead of overlaying at read time: an overlay
would have to be applied by every consumer of Employee (tree_builder, api_org_tree,
trends, quality_report, exports). Materializing touches one code path. The source
values are never lost: ``Employee.raw_data`` holds the original imported row, and
each correction records its own ``before``.
"""
from __future__ import annotations

import logging

from django.db import transaction

from ..models import CensusSnapshot, CorrectionReplayLog, Employee, StructureCorrection
from .tree_builder import detect_cycles

log = logging.getLogger(__name__)

#: Attribute fields a correction may set — scenarios.EDITABLE_FIELDS (14) minus
#: the two pay fields, so 12. The current scenario template exposes inputs for
#: only 7 of the 14, which is one reason cleanup work is impossible today.
#:
#: annual_salary and fully_loaded_cost are deliberately excluded: correcting a
#: *structure* should not silently rewrite compensation. Pay belongs to the
#: payroll export, and a correction that changed it would make the chart's cost
#: rollups untraceable to source. Pay edits stay in Scenario mode.
CORRECTABLE_FIELDS = (
    "first_name", "last_name", "job_title", "management_level", "department",
    "site_location", "city", "state", "employee_status", "employee_type",
    "pay_type", "entity",
)

#: Fields an ``add_person`` correction may set on the row it creates — the same
#: twelve. Pay still comes from the payroll export rather than from someone
#: typing it into the chart.
ADDABLE_FIELDS = CORRECTABLE_FIELDS

_KIND = StructureCorrection.Kind
_STATUS = StructureCorrection.ReplayStatus

#: Replay order. add_person first, so a reparent can point at somebody this same
#: replay is about to insert. Reparent after set_root so a correction that moves
#: someone under a new root can't transiently reference a supervisor set_root is
#: about to clear.
_REPLAY_ORDER = (
    _KIND.ADD_PERSON, _KIND.EXCLUDE, _KIND.ELIMINATE, _KIND.SET_ROOT,
    _KIND.REPARENT, _KIND.ATTRIBUTE,
)

#: The two kinds that take someone off the chart. They differ only in what the
#: ledger says they mean; the mechanics are identical.
REMOVAL_KINDS = (_KIND.EXCLUDE, _KIND.ELIMINATE)


# ---------------------------------------------------------------------------
# Supervisor FK resolution
# ---------------------------------------------------------------------------

def resolve_supervisor_fks(snapshot: CensusSnapshot) -> int:
    """Re-point every Employee.supervisor FK from raw_supervisor_id, for one snapshot.

    Single pass, bulk_update. Returns the number of rows changed. Call this after
    any batch that touched raw_supervisor_id. Idempotent.

    This is the same resolution ``views._perform_save`` does after an import; that
    function now calls this one so there is a single implementation.
    """
    all_employees = list(Employee.objects.filter(snapshot=snapshot))
    lookup = {e.employee_id: e for e in all_employees}
    updates = []
    for emp in all_employees:
        target = lookup.get(emp.raw_supervisor_id) if emp.raw_supervisor_id else None
        if target is not None and target.pk == emp.pk:
            target = None  # never let a row be its own supervisor FK
        if emp.supervisor_id != (target.pk if target else None):
            emp.supervisor = target
            updates.append(emp)
    if updates:
        Employee.objects.bulk_update(updates, ["supervisor"], batch_size=500)
    return len(updates)


# ---------------------------------------------------------------------------
# Applying / reverting one correction
# ---------------------------------------------------------------------------

def capture_before(employee: Employee, kind: str, after: dict) -> dict:
    """The source values a correction is about to overwrite.

    Recorded once, the first time a correction is created, so a revert restores
    the value the census actually carried rather than an intermediate edit.
    """
    if kind == _KIND.REPARENT:
        return {"raw_supervisor_id": employee.raw_supervisor_id or None}
    if kind == _KIND.SET_ROOT:
        return {"raw_supervisor_id": employee.raw_supervisor_id or None}
    if kind in REMOVAL_KINDS:
        return {
            "employee_status": employee.employee_status,
            "raw_supervisor_id": employee.raw_supervisor_id or None,
            # Filled in by _apply_removal — which reports were pulled up, and
            # where from — so a revert puts exactly those people back and no
            # others. It has to be recorded because "everyone now reporting to
            # the manager" can't tell them apart after the fact.
            "reports": {},
        }
    if kind == _KIND.ATTRIBUTE:
        return {f: getattr(employee, f) for f in after if f in CORRECTABLE_FIELDS}
    # add_person has no `before` — the whole point is that the row didn't exist.
    return {}


def apply_correction(correction: StructureCorrection, snapshot: CensusSnapshot) -> tuple[str, str]:
    """Materialize *correction* onto the Employee rows of *snapshot*.

    Returns ``(status, detail)`` where status is a ``ReplayStatus`` value.

    Resolution rules:
      - Employee with ``correction.employee_id`` not in the snapshot  -> ("stale", ...)
      - kind=reparent and the target supervisor_id is not in the snapshot -> ("conflict", ...)
      - kind=reparent that would create a cycle in this snapshot     -> ("conflict", ...)
      - the row's current value differs from ``correction.before``   -> ("drifted", ...) but STILL APPLY
      - otherwise                                                    -> ("applied", "")

    'drifted' means the source census changed its mind about this field since the
    correction was recorded. We still apply — the human decision outranks the
    export — but we flag it so it can be reviewed and retired.

    Does **not** resolve supervisor FKs; the caller does that once per batch.
    """
    emp = Employee.objects.filter(
        snapshot=snapshot, employee_id=correction.employee_id,
    ).first()

    if correction.kind == _KIND.ADD_PERSON:
        return _apply_add_person(correction, snapshot, emp)

    if emp is None:
        return _STATUS.STALE, f"{correction.employee_id} is not in this census."

    kind = correction.kind
    after = correction.after or {}
    before = correction.before or {}

    if kind == _KIND.REPARENT:
        target = (after.get("raw_supervisor_id") or "").strip() or None
        if not target:
            return _STATUS.CONFLICT, "No target manager recorded on this correction."
        if target == emp.employee_id:
            return _STATUS.CONFLICT, "The correction points this person at themselves."
        if not Employee.objects.filter(snapshot=snapshot, employee_id=target).exists():
            return _STATUS.CONFLICT, f"Manager {target} is not in this census."
        if _would_cycle(snapshot, emp.employee_id, target):
            return _STATUS.CONFLICT, f"Reporting to {target} would create a loop in this census."
        status, detail = _drift(emp, before, ("raw_supervisor_id",))
        emp.raw_supervisor_id = target
        emp.save(update_fields=["raw_supervisor_id"])
        return status, detail

    if kind == _KIND.SET_ROOT:
        status, detail = _drift(emp, before, ("raw_supervisor_id",))
        emp.raw_supervisor_id = None
        emp.supervisor = None
        emp.save(update_fields=["raw_supervisor_id", "supervisor"])
        return status, detail

    if kind in REMOVAL_KINDS:
        return _apply_removal(correction, snapshot, emp)

    if kind == _KIND.ATTRIBUTE:
        fields = [f for f in after if f in CORRECTABLE_FIELDS]
        if not fields:
            return _STATUS.CONFLICT, "No correctable fields on this correction."
        status, detail = _drift(emp, before, fields)
        for f in fields:
            setattr(emp, f, after[f])
        emp.save(update_fields=fields)
        return status, detail

    return _STATUS.CONFLICT, f"Unknown correction kind '{kind}'."


def _apply_removal(correction, snapshot, emp) -> tuple[str, str]:
    """Take someone off the chart and re-home their direct reports.

    Each report goes wherever ``after["reassign"]`` says, falling back to the
    removed person's own manager — the same default ``eliminate_position`` has
    always used. Without re-homing them at all the reports would keep pointing at
    an id ``_fetch_employees`` no longer returns, so removing one manager would
    silently strand their whole team in the orphan tray.

    The fallback matters on replay: next month's census may hang reports off this
    person that nobody has allocated yet, and they still must land somewhere.

    Records what it moved in ``before["reports"]`` so a revert restores exactly
    those people and nobody else.
    """
    default_parent = emp.raw_supervisor_id or None
    reassign = (correction.after or {}).get("reassign") or {}
    reports = list(
        Employee.objects.filter(snapshot=snapshot, raw_supervisor_id=emp.employee_id)
        .exclude(employee_status=Employee.EXCLUDED_STATUS)
    )
    present = set(
        Employee.objects.filter(snapshot=snapshot)
        .exclude(employee_status=Employee.EXCLUDED_STATUS)
        .values_list("employee_id", flat=True)
    )
    moved = {r.employee_id: emp.employee_id for r in reports}
    for child in reports:
        wanted = (reassign.get(child.employee_id) or "").strip() or None
        # An allocation target can disappear between censuses; fall back rather
        # than stranding the person a second time.
        if wanted and wanted not in present:
            wanted = None
        child.raw_supervisor_id = wanted or default_parent
        child.save(update_fields=["raw_supervisor_id"])

    before = dict(correction.before or {})
    before["reports"] = moved
    if before != (correction.before or {}):
        correction.before = before
        correction.save(update_fields=["before", "updated_at"])

    emp.employee_status = Employee.EXCLUDED_STATUS
    emp.raw_supervisor_id = None
    emp.supervisor = None
    emp.save(update_fields=["employee_status", "raw_supervisor_id", "supervisor"])

    if moved:
        allocated = sum(1 for c in moved if reassign.get(c))
        where = (f"{allocated} to a chosen manager, " if allocated else "")
        rest = len(moved) - allocated
        if rest:
            where += (f"{rest} up to {default_parent}" if default_parent
                      else f"{rest} to the top of the org")
        return _STATUS.APPLIED, f"{len(moved)} report(s) moved — {where.rstrip(', ')}."
    return _STATUS.APPLIED, ""


def _apply_add_person(correction, snapshot, emp) -> tuple[str, str]:
    """Insert a person the export omitted, or retire the correction if it caught up.

    Resolution rule, in order:
      - a row with this id exists and we did *not* create it  -> ("resolved", …)
      - a row with this person's name exists under a different id -> ("resolved", …)
        The export presumably assigned them a real badge number; ours would be a
        duplicate, so stand down and let the source win.
      - a row with this id exists and carries our marker      -> refresh it, ("applied", …)
      - no row                                                -> create it, ("applied", "")
    """
    after = dict(correction.after or {})
    fields = {f: after.get(f, "") for f in ADDABLE_FIELDS if f in after}
    supervisor_id = (after.get("raw_supervisor_id") or "").strip() or None

    if emp is not None and not (emp.raw_data or {}).get(Employee.ADDED_BY_CORRECTION_KEY):
        return (_STATUS.RESOLVED,
                f"The census now includes {correction.employee_id}; this correction is no "
                f"longer needed.")

    first, last = fields.get("first_name", ""), fields.get("last_name", "")
    if emp is None and (first or last):
        # Filtered in Python, not with .exclude(raw_data__<key>=True): a JSON key
        # that is absent compares as NULL, and exclude() then drops the very rows
        # we are looking for.
        twin = next(
            (
                e for e in Employee.objects.filter(
                    snapshot=snapshot, first_name=first, last_name=last,
                ).exclude(employee_id=correction.employee_id)
                if not (e.raw_data or {}).get(Employee.ADDED_BY_CORRECTION_KEY)
            ),
            None,
        )
        if twin is not None:
            return (_STATUS.RESOLVED,
                    f"The census now includes {twin.full_name} as {twin.employee_id}; "
                    f"adding {correction.employee_id} would duplicate them.")

    if supervisor_id and not Employee.objects.filter(
        snapshot=snapshot, employee_id=supervisor_id,
    ).exists():
        return _STATUS.CONFLICT, f"Manager {supervisor_id} is not in this census."

    if emp is None:
        Employee.objects.create(
            snapshot=snapshot,
            employee_id=correction.employee_id,
            raw_supervisor_id=supervisor_id,
            raw_data={Employee.ADDED_BY_CORRECTION_KEY: True},
            **fields,
        )
        return _STATUS.APPLIED, ""

    # Ours from a previous run — keep it in step with the correction.
    for key, value in fields.items():
        setattr(emp, key, value)
    emp.raw_supervisor_id = supervisor_id
    emp.save(update_fields=list(fields) + ["raw_supervisor_id"])
    return _STATUS.APPLIED, ""


def _drift(emp: Employee, before: dict, fields) -> tuple[str, str]:
    """Compare the row's current values against what the correction expected."""
    changed = []
    for f in fields:
        if f not in before:
            continue
        current = getattr(emp, f, None)
        expected = before[f]
        if _norm(current) != _norm(expected):
            changed.append(f"{f}: census now says {current!r}, was {expected!r}")
    if changed:
        return _STATUS.DRIFTED, "; ".join(changed)[:300]
    return _STATUS.APPLIED, ""


def _norm(v):
    if v is None:
        return ""
    return str(v).strip()


def _would_cycle(snapshot: CensusSnapshot, employee_id: str, new_supervisor_id: str) -> bool:
    """True if pointing *employee_id* at *new_supervisor_id* closes a loop."""
    parent = dict(
        Employee.objects.filter(snapshot=snapshot)
        .values_list("employee_id", "raw_supervisor_id")
    )
    parent[employee_id] = new_supervisor_id
    return any(employee_id in cycle for cycle in detect_cycles(parent))


def revert_correction(correction: StructureCorrection, snapshot: CensusSnapshot) -> None:
    """Restore the values in ``correction.before`` onto the snapshot, then
    deactivate the correction (``is_active=False``) rather than deleting it.

    Kept rather than deleted so the ledger remains a complete audit trail of
    what was changed and un-changed, and by whom.
    """
    emp = Employee.objects.filter(
        snapshot=snapshot, employee_id=correction.employee_id,
    ).first()

    if correction.kind == _KIND.ADD_PERSON:
        # Only delete a row we created. If the export has since started carrying
        # this person, the row is real data and reverting must not destroy it.
        if emp is not None and (emp.raw_data or {}).get(Employee.ADDED_BY_CORRECTION_KEY):
            Employee.objects.filter(
                snapshot=snapshot, raw_supervisor_id=emp.employee_id,
            ).update(raw_supervisor_id=emp.raw_supervisor_id)
            emp.delete()
        correction.is_active = False
        correction.replay_detail = "Reverted."
        correction.save(update_fields=["is_active", "replay_detail", "updated_at"])
        resolve_supervisor_fks(snapshot)
        return

    if emp is not None:
        before = correction.before or {}
        fields = []
        for key, value in before.items():
            if key == "raw_supervisor_id":
                emp.raw_supervisor_id = value or None
                fields.append("raw_supervisor_id")
            elif key in CORRECTABLE_FIELDS:
                setattr(emp, key, value if value is not None else "")
                fields.append(key)
        if fields:
            emp.save(update_fields=fields)

        # Put back exactly the reports this removal moved, and only if they are
        # still where it put them. Two things to get right: an allocated report
        # sits at its chosen destination rather than the fallback, and anyone a
        # later edit has moved elsewhere must be left alone rather than yanked
        # back. Both are why we filter on the expected current parent.
        if correction.kind in REMOVAL_KINDS:
            reassign = (correction.after or {}).get("reassign") or {}
            fallback = emp.raw_supervisor_id or None
            for child_id, prior in (before.get("reports") or {}).items():
                placed = (reassign.get(child_id) or "").strip() or fallback
                Employee.objects.filter(
                    snapshot=snapshot, employee_id=child_id, raw_supervisor_id=placed,
                ).update(raw_supervisor_id=prior)

    correction.is_active = False
    correction.replay_detail = "Reverted."
    correction.save(update_fields=["is_active", "replay_detail", "updated_at"])

    if emp is not None:
        resolve_supervisor_fks(snapshot)


# ---------------------------------------------------------------------------
# Replay
# ---------------------------------------------------------------------------

@transaction.atomic
def replay_corrections(snapshot: CensusSnapshot, user=None) -> CorrectionReplayLog:
    """Re-apply every active correction for the company onto a newly saved *snapshot*.

    Order: exclude, then set_root, then reparent, then attribute. Reparent after
    set_root so a correction that moves someone under a new root can't transiently
    reference a supervisor that set_root is about to clear.

    Writes a CorrectionReplayLog, updates each correction's replay_status /
    replay_detail / last_applied_snapshot, and deactivates corrections that came
    back 'stale' (the person is gone; keep the record, stop replaying it).

    Calls resolve_supervisor_fks() once at the end, not per correction.

    NOTE: this is one of the two mutation points a tree_builder cache would have
    to invalidate (see the TODO in services/tree_builder.py).
    """
    company = snapshot.company
    corrections = list(
        StructureCorrection.objects.filter(company=company, is_active=True)
    )
    corrections.sort(key=lambda c: _REPLAY_ORDER.index(c.kind) if c.kind in _REPLAY_ORDER else 99)

    outcomes: dict[int, tuple[str, str]] = {}
    for c in corrections:
        try:
            outcomes[c.id] = apply_correction(c, snapshot)
        except Exception as exc:                      # pragma: no cover - defensive
            log.exception("Correction %s failed to apply", c.id)
            outcomes[c.id] = (_STATUS.CONFLICT, str(exc)[:300])

    # ── Cycle safety: validate the whole post-replay structure once ──────
    # A batch of individually-legal reparents can jointly close a loop. Undo
    # only the offending ones, then re-check, so a cycle never reaches
    # tree_builder.
    _resolve_replay_cycles(snapshot, corrections, outcomes)

    counts = {
        _STATUS.APPLIED: 0, _STATUS.DRIFTED: 0, _STATUS.STALE: 0,
        _STATUS.CONFLICT: 0, _STATUS.RESOLVED: 0,
    }
    detail_rows = []
    for c in corrections:
        status, detail = outcomes.get(c.id, (_STATUS.CONFLICT, "Not evaluated."))
        counts[status] = counts.get(status, 0) + 1
        c.replay_status = status
        c.replay_detail = detail
        if status in (_STATUS.APPLIED, _STATUS.DRIFTED):
            c.last_applied_snapshot = snapshot
            if c.first_applied_snapshot_id is None:
                c.first_applied_snapshot = snapshot
        # Stale: the person is gone. Resolved: the export caught up. Either way
        # the correction has nothing left to do — keep the record, stop replaying.
        if status in (_STATUS.STALE, _STATUS.RESOLVED):
            c.is_active = False
        c.save(update_fields=[
            "replay_status", "replay_detail", "last_applied_snapshot",
            "first_applied_snapshot", "is_active", "updated_at",
        ])
        detail_rows.append({
            "employee_id": c.employee_id,
            "kind": c.kind,
            "kind_label": c.get_kind_display(),
            "status": status,
            "detail": detail,
        })

    resolve_supervisor_fks(snapshot)

    return CorrectionReplayLog.objects.create(
        company=company,
        snapshot=snapshot,
        run_by=user,
        applied_count=counts[_STATUS.APPLIED],
        drifted_count=counts[_STATUS.DRIFTED],
        stale_count=counts[_STATUS.STALE],
        conflict_count=counts[_STATUS.CONFLICT],
        resolved_count=counts[_STATUS.RESOLVED],
        detail=detail_rows,
    )


def _resolve_replay_cycles(snapshot, corrections, outcomes) -> None:
    """Undo whichever replayed reparents jointly created a loop, and flag them."""
    for _ in range(10):
        parent = dict(
            Employee.objects.filter(snapshot=snapshot)
            .values_list("employee_id", "raw_supervisor_id")
        )
        cycles = detect_cycles(parent)
        if not cycles:
            return
        looped = {eid for cycle in cycles for eid in cycle}
        undone = False
        for c in corrections:
            if c.kind != _KIND.REPARENT or c.employee_id not in looped:
                continue
            status, _ = outcomes.get(c.id, (None, ""))
            if status not in (_STATUS.APPLIED, _STATUS.DRIFTED):
                continue
            emp = Employee.objects.filter(
                snapshot=snapshot, employee_id=c.employee_id,
            ).first()
            if emp is None:
                continue
            emp.raw_supervisor_id = (c.before or {}).get("raw_supervisor_id") or None
            emp.save(update_fields=["raw_supervisor_id"])
            outcomes[c.id] = (
                _STATUS.CONFLICT,
                "Not applied — combined with the other corrections it formed a reporting loop.",
            )
            undone = True
        if not undone:
            # The loop is in the source data, not something we introduced.
            log.warning("Cycle in snapshot %s not caused by corrections: %s", snapshot.id, cycles)
            return


def replay_summary(snapshot: CensusSnapshot):
    """The most recent replay log for *snapshot*, or None."""
    return CorrectionReplayLog.objects.filter(snapshot=snapshot).first()
