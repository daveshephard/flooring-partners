"""Validate and atomically commit a batch of structural edits.

The editor accumulates ops client-side and submits them as one changeset. This
module is deliberately the only write path: it validates the *whole* batch against
the *resulting* structure before touching anything, which is what makes batch
editing safe. The old per-edit view could accept two individually-valid reparents
that jointly formed a cycle.
"""
from __future__ import annotations

from datetime import datetime

from django.db import transaction

from ..models import Employee, ScenarioPosition, StructureCorrection
from . import corrections as corrections_svc
from . import scenarios as scenarios_svc
from .costing import to_decimal
from .tree_builder import detect_cycles

TARGET_CORRECTIONS = "corrections"
TARGET_SCENARIO = "scenario"

#: Ops the editor can stage, and which targets accept them.
#:
#: Correct mode accepts `add` but not `eliminate`, and the asymmetry is the
#: point: adding is a data fix (the person works here, the export missed them),
#: whereas eliminating is a plan — you are proposing that a real role stop
#: existing, which belongs in a scenario. Scenario mode has no `exclude`, since
#: excluding a duplicate row is a census correction, not a reorg.
OPS_BY_TARGET = {
    TARGET_CORRECTIONS: {"reparent", "set_root", "attribute", "exclude", "add"},
    TARGET_SCENARIO: {"reparent", "set_root", "attribute", "add", "eliminate"},
}

#: Only these two members of EDITABLE_FIELDS reveal pay.
PAY_FIELDS = ("annual_salary", "fully_loaded_cost")
_DECIMAL_FIELDS = ("annual_salary", "fully_loaded_cost", "revenue_attribution")
_DATE_FIELDS = ("hire_date",)

MAX_OPS = 2000


class ChangesetError(Exception):
    """Carries the per-op error list for a 422 response."""

    def __init__(self, errors: list[dict]):
        self.errors = errors
        super().__init__(f"{len(errors)} invalid operation(s)")


class StaleSnapshotError(Exception):
    """The company's current snapshot moved while the user was editing."""

    def __init__(self, current_snapshot_id):
        self.current_snapshot_id = current_snapshot_id
        super().__init__("This census was replaced while you were editing.")


# ---------------------------------------------------------------------------
# Reading the target's current structure
# ---------------------------------------------------------------------------

def _parent_map(*, target, snapshot=None, scenario=None) -> dict[str, str | None]:
    """{employee_id: supervisor_id} for the edit target, as it stands right now."""
    if target == TARGET_SCENARIO:
        rows = (
            scenario.positions
            .exclude(change_type=ScenarioPosition.ChangeType.REMOVED)
            .values_list("employee_id", "raw_supervisor_id")
        )
    else:
        rows = (
            Employee.objects.filter(snapshot=snapshot)
            .exclude(employee_status=Employee.EXCLUDED_STATUS)
            .values_list("employee_id", "raw_supervisor_id")
        )
    return {eid: (sup or None) for eid, sup in rows}


def _branch_members(parent_map: dict[str, str | None], branch_root: str) -> set[str]:
    """*branch_root* plus everyone beneath it in *parent_map*."""
    children: dict[str, list[str]] = {}
    for eid, sup in parent_map.items():
        if sup:
            children.setdefault(sup, []).append(eid)
    members = {branch_root}
    stack = list(children.get(branch_root, []))
    while stack:
        cur = stack.pop()
        if cur in members:
            continue
        members.add(cur)
        stack.extend(children.get(cur, []))
    return members


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

def validate_changeset(ops: list[dict], *, target, snapshot=None, scenario=None,
                       whitelist, branch_root: str | None = None,
                       can_see_pay: bool = True) -> list[dict]:
    """Return a list of per-op errors; empty list means the batch is safe to commit.

    Each error: {"index": <int>, "op": <str>, "employee_id": <str>, "error": <str>}

    Validation is done against a *simulated* result, not the current DB state:
    build an in-memory {employee_id: supervisor_id} map from the target, apply
    every op to the map, then check the invariants once. This is the only way to
    catch a batch whose ops are individually legal and jointly broken.
    """
    errors: list[dict] = []
    allowed_ops = OPS_BY_TARGET.get(target, set())
    parent_map = _parent_map(target=target, snapshot=snapshot, scenario=scenario)
    sim = dict(parent_map)
    eliminated: set[str] = set()
    branch = _branch_members(parent_map, branch_root) if branch_root else None
    # Correct-mode adds carry a real badge number, which must not collide with a
    # row already in the census or with another add in the same batch. Excluded
    # rows count as taken — the id is still in the table.
    existing_ids = (
        set(Employee.objects.filter(snapshot=snapshot).values_list("employee_id", flat=True))
        if target == TARGET_CORRECTIONS and snapshot else set()
    )
    claimed_ids: set[str] = set()

    def err(i, op, eid, msg):
        errors.append({"index": i, "op": op, "employee_id": eid, "error": msg})

    for i, raw in enumerate(ops):
        if not isinstance(raw, dict):
            err(i, "", "", "Malformed operation.")
            continue
        name = str(raw.get("op") or "").strip()
        eid = str(raw.get("employee_id") or "").strip()
        after = raw.get("after") or {}
        if not isinstance(after, dict):
            err(i, name, eid, "Operation payload must be an object.")
            continue

        # 1. Op allowed for the target.
        if name not in allowed_ops:
            if name == "eliminate" and target == TARGET_CORRECTIONS:
                err(i, name, eid,
                    "Correct mode can't eliminate a role — proposing that a real position "
                    "stop existing is a plan, not a correction. Use Scenario mode.")
            elif name == "exclude" and target == TARGET_SCENARIO:
                err(i, name, eid,
                    "Scenario mode can't exclude rows — eliminate the position instead.")
            else:
                err(i, name, eid, f"Unknown operation '{name}'.")
            continue

        # 2. Subject exists (or is a TMP- id introduced earlier in this batch).
        if not eid:
            err(i, name, eid, "Operation is missing an employee id.")
            continue
        if name == "add":
            if eid in sim:
                err(i, name, eid, f"'{eid}' is already used in this batch.")
                continue
        elif eid not in sim:
            err(i, name, eid, f"{eid} is not in this {('scenario' if target == TARGET_SCENARIO else 'census')}.")
            continue
        elif eid in eliminated:
            err(i, name, eid, "This position was eliminated earlier in the batch.")
            continue

        # Branch-restricted editors: subject must be inside their branch.
        if branch is not None and name != "add" and eid not in branch:
            err(i, name, eid, "That person is outside the part of the org you can edit.")
            continue

        # 3–7. Per-op payload checks.
        if name == "attribute":
            _check_fields(i, name, eid, after, whitelist, can_see_pay, err)

        elif name == "reparent":
            new_sup = str(after.get("raw_supervisor_id") or "").strip()
            if not new_sup:
                err(i, name, eid, "No new manager was given.")
                continue
            if new_sup == eid:
                err(i, name, eid, "A position cannot report to itself.")
                continue
            if new_sup not in sim:
                err(i, name, eid, f"Manager {new_sup} is not in this {('scenario' if target == TARGET_SCENARIO else 'census')}.")
                continue
            if new_sup in eliminated:
                err(i, name, eid, "That manager was eliminated earlier in the batch.")
                continue
            if branch is not None and new_sup not in branch:
                err(i, name, eid, "That manager is outside the part of the org you can edit.")
                continue
            sim[eid] = new_sup

        elif name == "set_root":
            sim[eid] = None

        elif name == "exclude":
            sim[eid] = None

        elif name == "add":
            _check_fields(i, name, eid, after, whitelist, can_see_pay, err,
                          extra_keys={"raw_supervisor_id", "is_vacant", "note", "employee_id"})
            new_sup = str(after.get("raw_supervisor_id") or "").strip()
            if new_sup and new_sup not in sim:
                err(i, name, eid, f"Manager {new_sup} is not in this "
                                  f"{'scenario' if target == TARGET_SCENARIO else 'census'}.")
                continue
            if target == TARGET_CORRECTIONS:
                # The badge number matters here in a way it doesn't in a scenario:
                # it is what next month's export has to match for the correction
                # to retire itself instead of creating a duplicate.
                real_id = str(after.get("employee_id") or "").strip()
                if real_id and real_id in existing_ids:
                    err(i, name, real_id,
                        f"{real_id} is already in this census — correct that row instead "
                        f"of adding a second one.")
                    continue
                if real_id and real_id in claimed_ids:
                    err(i, name, real_id, f"{real_id} is added twice in this batch.")
                    continue
                if real_id:
                    claimed_ids.add(real_id)
                if not any(str(after.get(f) or "").strip()
                           for f in ("first_name", "last_name", "job_title")):
                    err(i, name, eid, "Give the person at least a name or a job title.")
                    continue
            sim[eid] = new_sup or None

        elif name == "eliminate":
            eliminated.add(eid)
            pulled_up = sim.get(eid)
            for child, sup in list(sim.items()):
                if sup == eid:
                    sim[child] = pulled_up
            sim.pop(eid, None)

    # 6. No cycles, batch-wide — checked once, against the simulated result.
    for cycle in detect_cycles(sim):
        members = set(cycle)
        names = " → ".join(cycle)
        hit = False
        for i, raw in enumerate(ops):
            if not isinstance(raw, dict):
                continue
            if str(raw.get("op") or "") in ("reparent", "add") and str(raw.get("employee_id") or "") in members:
                err(i, raw.get("op"), raw.get("employee_id"),
                    f"That move would create a reporting loop ({names}).")
                hit = True
        if not hit:
            err(0, "reparent", cycle[0], f"These changes would create a reporting loop ({names}).")

    errors.sort(key=lambda e: e["index"])
    return errors


def _check_fields(i, name, eid, after, whitelist, can_see_pay, err, extra_keys=frozenset()):
    """Whitelist + type coercion for an attribute-style payload."""
    for key, value in after.items():
        if key in extra_keys:
            continue
        if key not in whitelist:
            err(i, name, eid, f"'{key}' can't be edited here.")
            continue
        if key in PAY_FIELDS and not can_see_pay:
            err(i, name, eid, f"You don't have access to pay fields ('{key}').")
            continue
        if key in _DECIMAL_FIELDS and value not in (None, ""):
            if to_decimal(value) is None:
                err(i, name, eid, f"'{key}' must be a number (got {value!r}).")
        elif key in _DATE_FIELDS and value not in (None, ""):
            if _parse_date(value) is None:
                err(i, name, eid, f"'{key}' must be a date as YYYY-MM-DD (got {value!r}).")


def _parse_date(value):
    if not value:
        return None
    try:
        return datetime.strptime(str(value).strip(), "%Y-%m-%d").date()
    except ValueError:
        return None


def _coerce(field, value):
    """Type-coerce one whitelisted field value for writing."""
    if field in _DECIMAL_FIELDS:
        return to_decimal(value)
    if field in _DATE_FIELDS:
        return _parse_date(value)
    return "" if value is None else value


# ---------------------------------------------------------------------------
# Commit
# ---------------------------------------------------------------------------

@transaction.atomic
def commit_changeset(ops: list[dict], *, target, company, snapshot=None, scenario=None,
                     user=None, whitelist=None, branch_root=None, can_see_pay=True,
                     expected_snapshot_id=None) -> dict:
    """Validate then apply every op. Raises ChangesetError if validation fails.

    target: "corrections" | "scenario"

    corrections -> upsert StructureCorrection rows (capturing ``before`` from the
                   current Employee row on first correction) and materialize onto
                   the snapshot's Employee rows, then resolve_supervisor_fks() once.
    scenario    -> call the existing services/scenarios.py functions
                   (reassign_manager, edit_position, add_position, eliminate_position),
                   setting prior_supervisor_id before any move so it stays revertible.

    Returns {"applied": <int>, "id_map": {...}} — the caller builds the fresh tree
    and summary so pay redaction stays in one place (the API layer).

    NOTE: this is one of the two mutation points a tree_builder cache would have
    to invalidate (see the TODO in services/tree_builder.py).
    """
    if whitelist is None:
        whitelist = (
            corrections_svc.CORRECTABLE_FIELDS if target == TARGET_CORRECTIONS
            else scenarios_svc.EDITABLE_FIELDS
        )

    if expected_snapshot_id is not None:
        current = _current_snapshot_id(company, target=target, scenario=scenario)
        if current is not None and int(expected_snapshot_id) != int(current):
            raise StaleSnapshotError(current)

    errors = validate_changeset(
        ops, target=target, snapshot=snapshot, scenario=scenario,
        whitelist=whitelist, branch_root=branch_root, can_see_pay=can_see_pay,
    )
    if errors:
        raise ChangesetError(errors)

    if target == TARGET_CORRECTIONS:
        applied, id_map = _commit_corrections(ops, company=company, snapshot=snapshot, user=user)
    else:
        applied, id_map = _commit_scenario(ops, scenario=scenario)

    return {"applied": applied, "id_map": id_map}


def _current_snapshot_id(company, *, target, scenario=None):
    from ..models import CensusSnapshot
    if target == TARGET_SCENARIO:
        return scenario.base_snapshot_id if scenario else None
    snap = CensusSnapshot.objects.filter(
        company=company, status=CensusSnapshot.Status.ACTIVE, is_current=True,
    ).first() or (
        CensusSnapshot.objects
        .filter(company=company, status=CensusSnapshot.Status.ACTIVE)
        .order_by("-effective_date", "-upload_date").first()
    )
    return snap.id if snap else None


def _next_added_id(snapshot) -> str:
    """A fallback id when the user doesn't know the person's badge number.

    Worth avoiding: a made-up id can't match next month's export, so the
    correction will keep re-inserting the person alongside their real row until
    someone notices. ``_apply_add_person`` falls back to a name match to catch
    that, but a real badge number is always better.
    """
    taken = set(
        Employee.objects.filter(snapshot__company=snapshot.company,
                                employee_id__startswith="ADDED-")
        .values_list("employee_id", flat=True)
    )
    n = 1
    while f"ADDED-{n}" in taken:
        n += 1
    return f"ADDED-{n}"


def _commit_corrections(ops, *, company, snapshot, user) -> tuple[int, dict]:
    kind_for = {
        "reparent": StructureCorrection.Kind.REPARENT,
        "set_root": StructureCorrection.Kind.SET_ROOT,
        "attribute": StructureCorrection.Kind.ATTRIBUTE,
        "exclude": StructureCorrection.Kind.EXCLUDE,
        "add": StructureCorrection.Kind.ADD_PERSON,
    }
    applied = 0
    id_map: dict[str, str] = {}

    def resolve(value):
        value = str(value or "").strip()
        return id_map.get(value, value)

    for raw in ops:
        name = raw["op"]
        eid = resolve(raw["employee_id"])
        after = dict(raw.get("after") or {})
        note = (raw.get("note") or "").strip()
        kind = kind_for[name]

        if name == "add":
            real_id = str(after.pop("employee_id", "") or "").strip() or _next_added_id(snapshot)
            payload = {k: _coerce(k, v) for k, v in after.items()
                       if k in corrections_svc.ADDABLE_FIELDS}
            payload["raw_supervisor_id"] = resolve(after.get("raw_supervisor_id")) or None
            correction, _ = StructureCorrection.objects.update_or_create(
                company=company, employee_id=real_id,
                kind=StructureCorrection.Kind.ADD_PERSON,
                defaults={
                    "before": {}, "after": payload, "note": note, "is_active": True,
                    "created_by": user, "first_applied_snapshot": snapshot,
                    "last_applied_snapshot": snapshot,
                    "replay_status": StructureCorrection.ReplayStatus.APPLIED,
                    "replay_detail": "",
                },
            )
            status, detail = corrections_svc.apply_correction(correction, snapshot)
            if status != StructureCorrection.ReplayStatus.APPLIED:
                correction.replay_status = status
                correction.replay_detail = detail
                correction.save(update_fields=["replay_status", "replay_detail", "updated_at"])
            id_map[str(raw["employee_id"]).strip()] = real_id
            applied += 1
            continue

        emp = Employee.objects.filter(snapshot=snapshot, employee_id=eid).first()
        if emp is None:
            continue

        if name == "attribute":
            after = {k: _coerce(k, v) for k, v in after.items()
                     if k in corrections_svc.CORRECTABLE_FIELDS}
        elif name == "reparent":
            after = {"raw_supervisor_id": resolve(after.get("raw_supervisor_id"))}
        else:
            after = {}

        correction = StructureCorrection.objects.filter(
            company=company, employee_id=eid, kind=kind,
        ).first()

        if correction is None:
            correction = StructureCorrection(
                company=company, employee_id=eid, kind=kind, created_by=user,
                before=corrections_svc.capture_before(emp, kind, after),
                first_applied_snapshot=snapshot,
            )
        elif not correction.is_active:
            # Re-correcting after a revert: the row is back at its source value,
            # so re-capture `before` rather than trusting a stale one.
            correction.before = corrections_svc.capture_before(emp, kind, after)
        elif kind == StructureCorrection.Kind.ATTRIBUTE:
            merged = dict(correction.before or {})
            for f in after:
                merged.setdefault(f, getattr(emp, f, ""))
            correction.before = merged

        if kind == StructureCorrection.Kind.ATTRIBUTE:
            correction.after = {**(correction.after or {}), **after}
        else:
            correction.after = after
        if note:
            correction.note = note
        correction.is_active = True
        correction.replay_status = StructureCorrection.ReplayStatus.APPLIED
        correction.replay_detail = ""
        correction.last_applied_snapshot = snapshot
        correction.save()

        status, detail = corrections_svc.apply_correction(correction, snapshot)
        if status != StructureCorrection.ReplayStatus.APPLIED:
            correction.replay_status = status
            correction.replay_detail = detail
            correction.save(update_fields=["replay_status", "replay_detail", "updated_at"])
        applied += 1

    corrections_svc.resolve_supervisor_fks(snapshot)
    return applied, id_map


def _commit_scenario(ops, *, scenario) -> tuple[int, dict]:
    # One query for the whole batch. The old per-edit view re-queried per action
    # and had no select_related at all.
    positions = {
        p.employee_id: p
        for p in scenario.positions.select_related("scenario").all()
    }
    id_map: dict[str, str] = {}
    applied = 0

    def resolve(eid):
        eid = str(eid).strip()
        return id_map.get(eid, eid)

    for raw in ops:
        name = raw["op"]
        eid = resolve(raw["employee_id"])
        after = dict(raw.get("after") or {})
        note = (raw.get("note") or "").strip()

        if name == "add":
            fields = {k: _coerce(k, v) for k, v in after.items()
                      if k in scenarios_svc.EDITABLE_FIELDS}
            pos = scenarios_svc.add_position(
                scenario,
                supervisor_id=resolve(after.get("raw_supervisor_id") or "") or None,
                is_vacant=bool(after.get("is_vacant", True)),
                note=note,
                **fields,
            )
            id_map[str(raw["employee_id"]).strip()] = pos.employee_id
            positions[pos.employee_id] = pos
            applied += 1
            continue

        pos = positions.get(eid)
        if pos is None:
            continue

        if name == "reparent":
            scenarios_svc.reassign_manager(pos, resolve(after.get("raw_supervisor_id")))
        elif name == "set_root":
            scenarios_svc.reassign_manager(pos, None)
        elif name == "attribute":
            changes = {k: _coerce(k, v) for k, v in after.items()
                       if k in scenarios_svc.EDITABLE_FIELDS}
            if "is_vacant" in after:
                changes["is_vacant"] = bool(after["is_vacant"])
            if note:
                changes["note"] = note
            scenarios_svc.edit_position(pos, changes)
        elif name == "eliminate":
            if note:
                pos.note = note
                pos.save(update_fields=["note", "updated_at"])
            scenarios_svc.eliminate_position(pos)
            positions.pop(eid, None)
        applied += 1

    scenario.save(update_fields=["updated_at"])
    return applied, id_map
