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

_KIND = StructureCorrection.Kind
_STATUS = StructureCorrection.ReplayStatus

#: Replay order. Reparent after set_root so a correction that moves someone under
#: a new root can't transiently reference a supervisor set_root is about to clear.
_REPLAY_ORDER = (_KIND.EXCLUDE, _KIND.SET_ROOT, _KIND.REPARENT, _KIND.ATTRIBUTE)


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
    if kind == _KIND.EXCLUDE:
        return {
            "employee_status": employee.employee_status,
            "raw_supervisor_id": employee.raw_supervisor_id or None,
        }
    if kind == _KIND.ATTRIBUTE:
        return {f: getattr(employee, f) for f in after if f in CORRECTABLE_FIELDS}
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

    if kind == _KIND.EXCLUDE:
        emp.employee_status = Employee.EXCLUDED_STATUS
        emp.raw_supervisor_id = None
        emp.supervisor = None
        emp.save(update_fields=["employee_status", "raw_supervisor_id", "supervisor"])
        return _STATUS.APPLIED, ""

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

    counts = {_STATUS.APPLIED: 0, _STATUS.DRIFTED: 0, _STATUS.STALE: 0, _STATUS.CONFLICT: 0}
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
        if status == _STATUS.STALE:
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
