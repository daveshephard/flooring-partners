"""
OrgView JSON API endpoints.

All endpoints require the user to be logged in with org-view app access,
plus company-level AppPermission checks.
"""
from django.db.models import Q
from django.http import JsonResponse
import json as _json
from datetime import date as _date
from decimal import Decimal

from django.views.decorators.http import require_GET, require_POST

from accounts.decorators import app_access_required

from .models import (
    AppPermission, CensusSnapshot, Company, CorrectionReplayLog, Employee, Scenario,
    StructureCorrection,
)
from .services import changeset as changeset_svc
from .services import corrections as corrections_svc
from .services.costing import cost_of
from .services.tree_builder import (
    _build_lookups, _fetch_employees, build_tree, get_employee_path, redact_pay,
    strip_aggregation,
)
from .services.scenarios import build_scenario_tree, scenario_summary


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _is_superadmin(user):
    """Check if user has superadmin-level access.

    Grants access if ANY of:
      - Django's built-in is_superuser flag
      - Django's is_staff flag
      - UserProfile.role == "superadmin"
    """
    if user.is_superuser or user.is_staff:
        return True
    try:
        return user.profile.role == "superadmin"
    except Exception:
        return False


def _get_user_permission(user, company):
    """Return the AppPermission for this user+company, or None.
    Superadmins get a synthetic admin-level permission object."""
    if _is_superadmin(user):
        return AppPermission(user=user, company=company, role="admin", is_active=True)
    return (
        AppPermission.objects
        .filter(user=user, company=company, is_active=True)
        .first()
    )


def _can_see_pay(perm):
    """Restricted role hides pay/cost everywhere; everyone else sees it."""
    return bool(perm) and perm.role in AppPermission.PAY_ROLES


def _can_edit(perm):
    """True if this permission allows structural edits. Mirrors views._can_edit
    but takes a resolved perm, matching _can_see_pay(perm) in this module."""
    return bool(perm) and perm.role in AppPermission.EDIT_ROLES


def _user_companies(user):
    """Companies this user has any AppPermission on."""
    if _is_superadmin(user):
        return Company.objects.filter(is_active=True)
    perm_ids = (
        AppPermission.objects
        .filter(user=user, is_active=True)
        .values_list("company_id", flat=True)
    )
    return Company.objects.filter(id__in=perm_ids, is_active=True)


def _active_snapshot(company):
    """Return the is_current snapshot, falling back to most recent by effective_date."""
    snap = CensusSnapshot.objects.filter(
        company=company, status=CensusSnapshot.Status.ACTIVE, is_current=True,
    ).first()
    if snap:
        return snap
    return (
        CensusSnapshot.objects
        .filter(company=company, status=CensusSnapshot.Status.ACTIVE)
        .order_by("-effective_date", "-upload_date")
        .first()
    )


def _error(msg, status=400):
    return JsonResponse({"error": msg}, status=status)


# ---------------------------------------------------------------------------
# GET /org-view/api/companies/
# ---------------------------------------------------------------------------

@require_GET
@app_access_required("org-view")
def api_companies(request):
    companies = _user_companies(request.user)
    result = []
    for co in companies:
        perm = _get_user_permission(request.user, co)
        snap = _active_snapshot(co)
        latest = None
        summary = None
        if snap:
            latest = {
                "id":             snap.id,
                "label":          snap.label,
                "effective_date": snap.effective_date.isoformat() if snap.effective_date else None,
                "upload_date":    snap.upload_date.isoformat(),
                "employee_count": snap.employee_count,
                "is_current":     snap.is_current,
            }
            # Build root-level summary metrics
            tree = build_tree(snap.id)
            tree = strip_aggregation(tree)
            if not _can_see_pay(perm):
                tree = redact_pay(tree)
            if isinstance(tree, dict):
                summary = tree.get("metrics")
            elif isinstance(tree, list) and tree:
                # Multiple roots — aggregate from first root as best-effort
                summary = tree[0].get("metrics")

        result.append({
            "id":               co.id,
            "name":             co.name,
            "slug":             co.slug,
            "latest_snapshot":  latest,
            "summary_metrics":  summary,
        })
    return JsonResponse(result, safe=False)


# ---------------------------------------------------------------------------
# GET /org-view/api/companies/<slug>/org-tree/
# ---------------------------------------------------------------------------

@require_GET
@app_access_required("org-view")
def api_org_tree(request, slug):
    company = Company.objects.filter(slug=slug, is_active=True).first()
    if not company:
        return _error("Company not found.", 404)

    perm = _get_user_permission(request.user, company)
    if not perm:
        return _error("Access denied.", 403)

    # Determine which snapshot to use
    snapshot_id = request.GET.get("snapshot_id")
    if snapshot_id:
        snap = CensusSnapshot.objects.filter(
            id=snapshot_id, company=company, status=CensusSnapshot.Status.ACTIVE,
        ).first()
    else:
        snap = _active_snapshot(company)

    if not snap:
        return _error("No active snapshot found.", 404)

    # Determine root — branch-restricted users are forced to their branch root
    root_id = request.GET.get("root_employee_id")
    if perm.branch_root_employee_id:
        root_id = perm.branch_root_employee_id

    # Optional depth limit
    max_depth = request.GET.get("depth")
    if max_depth is not None:
        try:
            max_depth = int(max_depth)
        except ValueError:
            max_depth = None

    report = {}
    tree = build_tree(snap.id, root_employee_id=root_id, max_depth=max_depth, report=report)
    tree = strip_aggregation(tree)
    if not _can_see_pay(perm):
        tree = redact_pay(tree)

    return JsonResponse({
        "snapshot_id":      snap.id,
        "snapshot_label":   snap.label,
        "effective_date":   snap.effective_date.isoformat() if snap.effective_date else None,
        "is_current":       snap.is_current,
        "company":          company.name,
        "can_see_pay":      _can_see_pay(perm),
        "cycles":           report.get("cycles", []),
        "tree":             tree,
    })


# ---------------------------------------------------------------------------
# GET /org-view/api/companies/<slug>/snapshots/
# ---------------------------------------------------------------------------

@require_GET
@app_access_required("org-view")
def api_snapshots(request, slug):
    company = Company.objects.filter(slug=slug, is_active=True).first()
    if not company:
        return _error("Company not found.", 404)

    perm = _get_user_permission(request.user, company)
    if not perm:
        return _error("Access denied.", 403)

    snapshots = CensusSnapshot.objects.filter(company=company).exclude(
        status=CensusSnapshot.Status.PROCESSING,
    ).order_by("-effective_date", "-upload_date")

    result = [
        {
            "id":             s.id,
            "label":          s.label,
            "effective_date": s.effective_date.isoformat() if s.effective_date else None,
            "upload_date":    s.upload_date.isoformat(),
            "employee_count": s.employee_count,
            "is_current":     s.is_current,
            "status":         s.status,
        }
        for s in snapshots
    ]
    return JsonResponse(result, safe=False)


# ---------------------------------------------------------------------------
# GET /org-view/api/companies/<slug>/employees/search/
# ---------------------------------------------------------------------------

@require_GET
@app_access_required("org-view")
def api_employee_search(request, slug):
    company = Company.objects.filter(slug=slug, is_active=True).first()
    if not company:
        return _error("Company not found.", 404)

    perm = _get_user_permission(request.user, company)
    if not perm:
        return _error("Access denied.", 403)

    snap = _active_snapshot(company)
    if not snap:
        return _error("No active snapshot.", 404)

    q = request.GET.get("q", "").strip()
    limit = min(int(request.GET.get("limit", 20)), 100)

    if not q:
        return JsonResponse([], safe=False)

    employees = (
        Employee.objects.filter(snapshot=snap)
        # Excluded rows are not findable: get_employee_path returns [] for them,
        # so selecting one in the typeahead would be a silent dead end.
        .exclude(employee_status=Employee.EXCLUDED_STATUS)
        .filter(
            Q(first_name__icontains=q)
            | Q(last_name__icontains=q)
            | Q(job_title__icontains=q)
            | Q(employee_id__icontains=q)
        )
        .values(
            "employee_id", "first_name", "last_name",
            "job_title", "management_level",
        )[:limit]
    )

    results = []
    for emp in employees:
        path = get_employee_path(snap.id, emp["employee_id"])
        results.append({
            "employee_id":      emp["employee_id"],
            "full_name":        f'{emp["first_name"]} {emp["last_name"]}'.strip(),
            "job_title":        emp["job_title"],
            "management_level": emp["management_level"],
            "path":             path,
        })

    return JsonResponse(results, safe=False)


# ---------------------------------------------------------------------------
# GET /org-view/api/companies/<slug>/trends/
# ---------------------------------------------------------------------------

@require_GET
@app_access_required("org-view")
def api_trends(request, slug):
    company = Company.objects.filter(slug=slug, is_active=True).first()
    if not company:
        return _error("Company not found.", 404)

    perm = _get_user_permission(request.user, company)
    if not perm:
        return _error("Access denied.", 403)
    see_pay = _can_see_pay(perm)

    snapshots = (
        CensusSnapshot.objects
        .filter(company=company, status=CensusSnapshot.Status.ACTIVE)
        .order_by("effective_date", "upload_date")
    )

    result = []
    for snap in snapshots:
        tree = build_tree(snap.id)
        tree = strip_aggregation(tree)
        m = {}
        if isinstance(tree, dict):
            m = tree.get("metrics", {})
        elif isinstance(tree, list) and tree:
            m = tree[0].get("metrics", {})

        # Compute additional metrics not in the tree builder
        emp_qs = Employee.objects.filter(snapshot=snap)
        manager_count = emp_qs.filter(direct_reports__isnull=False).distinct().count()
        salaries = emp_qs.filter(annual_salary__isnull=False).values_list("annual_salary", flat=True)
        salary_list = [float(s) for s in salaries if s]
        avg_salary = round(sum(salary_list) / len(salary_list)) if salary_list else None
        max_span = 0
        if snap.employee_count > 0:
            from django.db.models import Count
            spans = (
                emp_qs.filter(direct_reports__isnull=False)
                .annotate(span=Count("direct_reports"))
                .values_list("span", flat=True)
            )
            span_list = list(spans)
            max_span = max(span_list) if span_list else 0

        result.append({
            "id":              snap.id,
            "label":           snap.label or "Unlabeled",
            "effective_date":  snap.effective_date.isoformat() if snap.effective_date else snap.upload_date.strftime("%Y-%m-%d"),
            "upload_date":     snap.upload_date.strftime("%Y-%m-%d"),
            "is_current":      snap.is_current,
            "metrics": {
                "headcount":        m.get("headcount", snap.employee_count),
                "num_layers":       m.get("num_layers"),
                "avg_span":         m.get("avg_span_of_control"),
                "max_span":         max_span,
                "total_labor_cost": m.get("total_labor_cost") if see_pay else None,
                "overhead_pct":     m.get("overhead_pct"),
                "manager_count":    manager_count,
                "avg_salary":       avg_salary if see_pay else None,
            },
        })

    return JsonResponse({"snapshots": result})


# ---------------------------------------------------------------------------
# POST /org-view/api/companies/<slug>/snapshots/<int:pk>/set-active/
# ---------------------------------------------------------------------------

@require_POST
@app_access_required("org-view")
def api_set_active(request, slug, pk):
    company = Company.objects.filter(slug=slug, is_active=True).first()
    if not company:
        return _error("Company not found.", 404)

    perm = _get_user_permission(request.user, company)
    if not perm or perm.role != "admin":
        return _error("Admin access required.", 403)

    snap = CensusSnapshot.objects.filter(
        id=pk, company=company, status=CensusSnapshot.Status.ACTIVE,
    ).first()
    if not snap:
        return _error("Snapshot not found or not active.", 404)

    snap.is_current = True
    snap.save(update_fields=["is_current"])  # model save() deactivates others

    return JsonResponse({"ok": True, "snapshot_id": snap.id})


# ---------------------------------------------------------------------------
# POST /org-view/api/companies/<slug>/snapshots/<int:pk>/edit/
# ---------------------------------------------------------------------------

@require_POST
@app_access_required("org-view")
def api_edit_snapshot(request, slug, pk):
    company = Company.objects.filter(slug=slug, is_active=True).first()
    if not company:
        return _error("Company not found.", 404)

    perm = _get_user_permission(request.user, company)
    if not perm or perm.role != "admin":
        return _error("Admin access required.", 403)

    snap = CensusSnapshot.objects.filter(id=pk, company=company).first()
    if not snap:
        return _error("Snapshot not found.", 404)

    try:
        body = _json.loads(request.body)
    except (ValueError, _json.JSONDecodeError):
        return _error("Invalid JSON.", 400)

    updated = []

    if "label" in body:
        snap.label = str(body["label"]).strip()[:100]
        updated.append("label")

    if "effective_date" in body:
        try:
            parts = str(body["effective_date"]).split("-")
            snap.effective_date = _date(int(parts[0]), int(parts[1]), int(parts[2]))
            updated.append("effective_date")
        except (ValueError, IndexError):
            return _error("Invalid date. Use YYYY-MM-DD.", 400)

    if "is_current" in body:
        snap.is_current = bool(body["is_current"])
        updated.append("is_current")

    if updated:
        snap.save(update_fields=updated)

    return JsonResponse({
        "ok": True,
        "id": snap.id,
        "label": snap.label,
        "effective_date": snap.effective_date.isoformat() if snap.effective_date else None,
        "is_current": snap.is_current,
    })


# ---------------------------------------------------------------------------
# POST /org-view/api/companies/<slug>/snapshots/<int:pk>/delete/
# ---------------------------------------------------------------------------

@require_POST
@app_access_required("org-view")
def api_delete_snapshot(request, slug, pk):
    company = Company.objects.filter(slug=slug, is_active=True).first()
    if not company:
        return _error("Company not found.", 404)

    perm = _get_user_permission(request.user, company)
    if not perm or perm.role != "admin":
        return _error("Admin access required.", 403)

    snap = CensusSnapshot.objects.filter(id=pk, company=company).first()
    if not snap:
        return _error("Snapshot not found.", 404)

    was_current = snap.is_current
    snap.delete()

    # If the deleted snapshot was the active one, promote the most recent remaining
    if was_current:
        next_snap = (
            CensusSnapshot.objects
            .filter(company=company, status=CensusSnapshot.Status.ACTIVE)
            .order_by("-effective_date", "-upload_date")
            .first()
        )
        if next_snap:
            next_snap.is_current = True
            next_snap.save(update_fields=["is_current"])

    return JsonResponse({"ok": True})


# ---------------------------------------------------------------------------
# GET /org-view/api/companies/<slug>/scenarios/<int:scenario_id>/org-tree/
# ---------------------------------------------------------------------------

@require_GET
@app_access_required("org-view")
def api_scenario_tree(request, slug, scenario_id):
    company = Company.objects.filter(slug=slug, is_active=True).first()
    if not company:
        return _error("Company not found.", 404)

    perm = _get_user_permission(request.user, company)
    if not perm:
        return _error("Access denied.", 403)

    scenario = Scenario.objects.filter(id=scenario_id, company=company).first()
    if not scenario:
        return _error("Scenario not found.", 404)

    root_id = request.GET.get("root_employee_id")
    if perm.branch_root_employee_id:
        root_id = perm.branch_root_employee_id

    tree = build_scenario_tree(scenario, root_employee_id=root_id)
    tree = strip_aggregation(tree)
    if not _can_see_pay(perm):
        tree = redact_pay(tree)

    return JsonResponse({
        "scenario_id":      scenario.id,
        "scenario_name":    scenario.name,
        # The client's stale-snapshot guard works identically in both modes.
        "base_snapshot_id": scenario.base_snapshot_id,
        "company":          company.name,
        "can_see_pay":      _can_see_pay(perm),
        "summary":          _mode_summary(company, perm, target=changeset_svc.TARGET_SCENARIO,
                                          snapshot=scenario.base_snapshot, scenario=scenario),
        "tree":             tree,
    })


# ---------------------------------------------------------------------------
# The editing API — changeset validate / commit, unattached, corrections
# ---------------------------------------------------------------------------

def _editing_context(request, slug, *, require_edit=True):
    """Resolve (company, perm) or return an error response as the third element."""
    company = Company.objects.filter(slug=slug, is_active=True).first()
    if not company:
        return None, None, _error("Company not found.", 404)
    perm = _get_user_permission(request.user, company)
    if not perm:
        return None, None, _error("Access denied.", 403)
    if require_edit and not _can_edit(perm):
        return None, None, _error("Admin access required.", 403)
    return company, perm, None


def _read_ops_body(request):
    """Parse and sanity-check a changeset request body. Returns (body, error)."""
    try:
        body = _json.loads(request.body or b"{}")
    except (ValueError, _json.JSONDecodeError):
        return None, _error("Invalid JSON.", 400)
    if not isinstance(body, dict):
        return None, _error("Request body must be a JSON object.", 400)
    ops = body.get("ops")
    if not isinstance(ops, list):
        return None, _error("'ops' must be a list.", 400)
    if len(ops) > changeset_svc.MAX_OPS:
        return None, _error(
            f"Too many changes in one save ({len(ops)}). "
            f"Save in batches of {changeset_svc.MAX_OPS} or fewer.", 413,
        )
    return body, None


def _resolve_target(company, body):
    """(target, snapshot, scenario, whitelist) or raise ValueError."""
    target = body.get("target") or changeset_svc.TARGET_CORRECTIONS
    if target not in (changeset_svc.TARGET_CORRECTIONS, changeset_svc.TARGET_SCENARIO):
        raise ValueError(f"Unknown edit target '{target}'.")

    if target == changeset_svc.TARGET_SCENARIO:
        scenario = Scenario.objects.filter(
            id=body.get("scenario_id"), company=company,
        ).first()
        if not scenario:
            raise ValueError("Scenario not found.")
        from .services.scenarios import EDITABLE_FIELDS
        return target, scenario.base_snapshot, scenario, EDITABLE_FIELDS

    snap = _active_snapshot(company)
    if not snap:
        raise ValueError("No active snapshot.")
    return target, snap, None, corrections_svc.CORRECTABLE_FIELDS


def _decimals_to_float(obj):
    """JSON-safe copy of a summary dict (scenario_summary returns Decimals)."""
    if isinstance(obj, Decimal):
        return float(obj)
    if isinstance(obj, dict):
        return {k: _decimals_to_float(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_decimals_to_float(v) for v in obj]
    return obj


def _mode_summary(company, perm, *, target, snapshot, scenario):
    """The authoritative summary strip for the mode that was just committed."""
    if target == changeset_svc.TARGET_SCENARIO:
        summary = _decimals_to_float(scenario_summary(scenario))
        if not _can_see_pay(perm):
            for block in ("baseline", "scenario"):
                summary[block]["total_cost"] = None
                summary[block]["cost_by_department"] = {}
            summary["deltas"]["total_cost"] = None
            summary["totals"] = {"investment": None, "savings": None, "net": None}
            for row in summary["ledger"]:
                row["cost_impact"] = None
        return summary
    return _unattached_payload(company, perm, snapshot)


def _fresh_tree(company, perm, *, target, snapshot, scenario):
    root_id = perm.branch_root_employee_id or None
    if target == changeset_svc.TARGET_SCENARIO:
        tree = build_scenario_tree(scenario, root_employee_id=root_id)
    else:
        tree = build_tree(snapshot.id, root_employee_id=root_id)
    tree = strip_aggregation(tree)
    if not _can_see_pay(perm):
        tree = redact_pay(tree)
    return tree


# ---------------------------------------------------------------------------
# POST /org-view/api/companies/<slug>/changeset/validate/
# ---------------------------------------------------------------------------

@require_POST
@app_access_required("org-view")
def api_validate_changeset(request, slug):
    company, perm, denied = _editing_context(request, slug)
    if denied:
        return denied
    body, denied = _read_ops_body(request)
    if denied:
        return denied
    try:
        target, snapshot, scenario, whitelist = _resolve_target(company, body)
    except ValueError as exc:
        return _error(str(exc), 400)

    errors = changeset_svc.validate_changeset(
        body["ops"], target=target, snapshot=snapshot, scenario=scenario,
        whitelist=whitelist, branch_root=perm.branch_root_employee_id or None,
        can_see_pay=_can_see_pay(perm),
    )
    return JsonResponse({"valid": not errors, "errors": errors})


# ---------------------------------------------------------------------------
# POST /org-view/api/companies/<slug>/changeset/commit/
# ---------------------------------------------------------------------------

@require_POST
@app_access_required("org-view")
def api_commit_changeset(request, slug):
    company, perm, denied = _editing_context(request, slug)
    if denied:
        return denied
    body, denied = _read_ops_body(request)
    if denied:
        return denied
    try:
        target, snapshot, scenario, whitelist = _resolve_target(company, body)
    except ValueError as exc:
        return _error(str(exc), 400)

    try:
        result = changeset_svc.commit_changeset(
            body["ops"], target=target, company=company, snapshot=snapshot,
            scenario=scenario, user=request.user, whitelist=whitelist,
            branch_root=perm.branch_root_employee_id or None,
            can_see_pay=_can_see_pay(perm),
            expected_snapshot_id=body.get("expected_snapshot_id"),
        )
    except changeset_svc.StaleSnapshotError as exc:
        return JsonResponse({
            "error": "This census was replaced while you were editing. Reload to continue.",
            "current_snapshot_id": exc.current_snapshot_id,
        }, status=409)
    except changeset_svc.ChangesetError as exc:
        return JsonResponse({"errors": exc.errors}, status=422)

    if target == changeset_svc.TARGET_SCENARIO:
        scenario.refresh_from_db()
    else:
        snapshot.refresh_from_db()

    return JsonResponse({
        "applied":     result["applied"],
        "id_map":      result["id_map"],
        "snapshot_id": snapshot.id if snapshot else None,
        "scenario_id": scenario.id if scenario else None,
        "tree":        _fresh_tree(company, perm, target=target, snapshot=snapshot, scenario=scenario),
        "summary":     _mode_summary(company, perm, target=target, snapshot=snapshot, scenario=scenario),
    })


# ---------------------------------------------------------------------------
# GET /org-view/api/companies/<slug>/unattached/
# ---------------------------------------------------------------------------

_REASON_LABELS = {
    "supervisor_not_found": "Manager not in this census",
    "extra_root":           "No manager listed",
    "self_referential":     "Listed as their own manager",
    "in_cycle":             "Circular reporting",
}


def _unattached_payload(company, perm, snap):
    """Who the chart isn't drawing, and why.

    See 00-INDEX §2a: a row whose ``raw_supervisor_id`` names nobody in the census
    lands in ``children_map`` under a parent that is never visited and is *not*
    added to ``natural_roots``, so it vanishes from the tree entirely. These are
    exactly the people who most need fixing.
    """
    total = Employee.objects.filter(snapshot=snap).count()
    excluded_rows = list(
        Employee.objects.filter(snapshot=snap, employee_status=Employee.EXCLUDED_STATUS)
        .values("employee_id", "first_name", "last_name", "job_title",
                "department", "site_location")
    )

    # A branch-restricted editor only ever sees their own subtree, and an orphan
    # is by definition not in it. Report their branch honestly and nothing else.
    if perm.branch_root_employee_id:
        report = {}
        build_tree(snap.id, root_employee_id=perm.branch_root_employee_id, report=report)
        rendered = report.get("rendered", 0)
        return {
            "orphans": [], "excluded": [],
            "counts": {"orphans": 0, "excluded": 0,
                       "total_employees": rendered, "rendered": rendered},
        }

    rows = _fetch_employees(snap.id)
    emp_dict, children_map, natural_roots, unreachable = _build_lookups(rows)

    primary = natural_roots[0] if natural_roots else None
    rendered_ids = set()
    if primary:
        stack = [primary]
        while stack:
            cur = stack.pop()
            if cur in rendered_ids:
                continue
            rendered_ids.add(cur)
            stack.extend(c for c in children_map.get(cur, []) if c in emp_dict)

    def cluster_of(eid):
        """Everyone hanging off an orphan — they are unreachable too.

        An orphan can be a manager whose whole team is equally invisible;
        attaching them has to bring the team, or the drop silently strands it.
        """
        seen, stack, out = {eid}, [eid], []
        while stack:
            cur = stack.pop()
            for child in children_map.get(cur, []):
                if child in seen or child not in emp_dict:
                    continue
                seen.add(child)
                stack.append(child)
                out.append(child)
        return out

    see_pay = _can_see_pay(perm)

    def person(eid):
        row = emp_dict[eid]
        return {
            "employee_id":       eid,
            "full_name":         f'{row["first_name"]} {row["last_name"]}'.strip() or eid,
            "first_name":        row.get("first_name") or "",
            "last_name":         row.get("last_name") or "",
            "job_title":         row.get("job_title") or "",
            "management_level":  row.get("management_level") or "",
            "department":        row.get("department") or "",
            "entity":            row.get("entity") or "",
            "city":              row.get("city") or "",
            "state":             row.get("state") or "",
            "site_location":     row.get("site_location") or "",
            "raw_supervisor_id": row.get("raw_supervisor_id") or None,
            # Same shape as a tree node's "self", so metrics.js can roll the
            # person up correctly the moment they're dragged onto a manager.
            "self": {
                "cost":        float(cost_of(row)) if see_pay else None,
                "revenue":     None,
                "is_overhead": row.get("is_overhead"),
            },
        }

    orphans = []
    listed = set()
    for eid, reason in sorted(unreachable.items()):
        if eid not in emp_dict or eid in rendered_ids or eid in listed:
            continue
        cluster = [c for c in cluster_of(eid) if c not in rendered_ids]
        listed.add(eid)
        listed.update(cluster)
        entry = person(eid)
        entry.update({
            "reason":        reason,
            "reason_label":  _REASON_LABELS.get(reason, reason),
            "subtree_count": len(cluster),
            # The whole cluster travels with its root on drop.
            "cluster":       [person(c) for c in cluster],
        })
        orphans.append(entry)

    excluded = [{
        "employee_id":   r["employee_id"],
        "full_name":     f'{r["first_name"]} {r["last_name"]}'.strip() or r["employee_id"],
        "job_title":     r["job_title"] or "",
        "department":    r["department"] or "",
        "site_location": r["site_location"] or "",
    } for r in excluded_rows]

    rendered = len(rendered_ids)
    return {
        "orphans": orphans,
        "excluded": excluded,
        "counts": {
            # Every unrendered, unexcluded person — so the three always reconcile
            # against total_employees even when an orphan drags a cluster along.
            "orphans":         total - len(excluded) - rendered,
            "excluded":        len(excluded),
            "total_employees": total,
            "rendered":        rendered,
        },
    }


# ---------------------------------------------------------------------------
# GET /org-view/api/companies/<slug>/employees/<employee_id>/raw/
# ---------------------------------------------------------------------------

@require_GET
@app_access_required("org-view")
def api_employee_raw(request, slug, employee_id):
    """The original imported row for one person.

    Fetched on demand rather than shipped with every tree node: when you're
    deciding whether a supervisor id is a typo, the raw row is exactly what you
    need — but 800 copies of it would bloat every chart load.
    """
    company, perm, denied = _editing_context(request, slug, require_edit=False)
    if denied:
        return denied
    snap = _active_snapshot(company)
    if not snap:
        return _error("No active snapshot.", 404)
    emp = Employee.objects.filter(snapshot=snap, employee_id=employee_id).first()
    if not emp:
        return _error("Employee not found.", 404)

    raw = dict(emp.raw_data or {})
    if not _can_see_pay(perm):
        for key in list(raw):
            if any(t in key.lower() for t in ("salary", "cost", "pay", "comp", "wage")):
                raw.pop(key)
    return JsonResponse({"employee_id": emp.employee_id, "raw_data": raw})


@require_GET
@app_access_required("org-view")
def api_unattached(request, slug):
    company, perm, denied = _editing_context(request, slug, require_edit=False)
    if denied:
        return denied
    snap = _active_snapshot(company)
    if not snap:
        return _error("No active snapshot.", 404)
    return JsonResponse(_unattached_payload(company, perm, snap))


# ---------------------------------------------------------------------------
# GET /org-view/api/companies/<slug>/corrections/
# ---------------------------------------------------------------------------

def _name_lookup(snap):
    if not snap:
        return {}
    return {
        e["employee_id"]: f'{e["first_name"]} {e["last_name"]}'.strip() or e["employee_id"]
        for e in Employee.objects.filter(snapshot=snap)
        .values("employee_id", "first_name", "last_name")
    }


def _who(names, eid):
    if not eid:
        return "nobody"
    name = names.get(str(eid))
    return f"{name} ({eid})" if name else str(eid)


def _correction_labels(correction, names):
    """Readable before → after, resolved server-side.

    The client shouldn't have to map ids to names to render the ledger, and it may
    not have the tree at all for excluded or stale people.
    """
    kind = correction.kind
    before, after = correction.before or {}, correction.after or {}
    K = StructureCorrection.Kind
    if kind == K.REPARENT:
        return (f"reported to {_who(names, before.get('raw_supervisor_id'))}",
                f"reports to {_who(names, after.get('raw_supervisor_id'))}")
    if kind == K.SET_ROOT:
        return (f"reported to {_who(names, before.get('raw_supervisor_id'))}",
                "top of org — reports to nobody")
    if kind == K.EXCLUDE:
        return ("on the chart", "excluded from the chart")
    parts_b = ", ".join(f"{k}: {v!r}" for k, v in before.items()) or "—"
    parts_a = ", ".join(f"{k}: {v!r}" for k, v in after.items()) or "—"
    return parts_b, parts_a


def _corrections_payload(company, snap, include_inactive=True):
    names = _name_lookup(snap)
    qs = (
        StructureCorrection.objects.filter(company=company)
        .select_related("created_by")
    )
    if not include_inactive:
        qs = qs.filter(is_active=True)

    # Conflicts and drifts are the rows demanding action; applied ones are history.
    rank = {
        StructureCorrection.ReplayStatus.CONFLICT: 0,
        StructureCorrection.ReplayStatus.DRIFTED: 1,
        StructureCorrection.ReplayStatus.STALE: 2,
        StructureCorrection.ReplayStatus.APPLIED: 3,
    }
    rows = sorted(qs, key=lambda c: (rank.get(c.replay_status, 9), -(c.id or 0)))

    out = []
    for c in rows:
        before_label, after_label = _correction_labels(c, names)
        out.append({
            "id": c.id,
            "employee_id": c.employee_id,
            "full_name": names.get(c.employee_id, c.employee_id),
            "kind": c.kind,
            "kind_label": c.get_kind_display(),
            "before": c.before,
            "after": c.after,
            "before_label": before_label,
            "after_label": after_label,
            "note": c.note,
            "is_active": c.is_active,
            "replay_status": c.replay_status,
            "replay_status_label": c.get_replay_status_display(),
            "replay_detail": c.replay_detail,
            "created_by": c.created_by.get_username() if c.created_by else None,
            "updated_at": c.updated_at.isoformat(),
        })

    latest = CorrectionReplayLog.objects.filter(company=company).first()
    latest_payload = None
    if latest:
        latest_payload = {
            "id": latest.id,
            "snapshot_id": latest.snapshot_id,
            "run_at": latest.run_at.isoformat(),
            "run_by": latest.run_by.get_username() if latest.run_by else None,
            "applied_count": latest.applied_count,
            "drifted_count": latest.drifted_count,
            "stale_count": latest.stale_count,
            "conflict_count": latest.conflict_count,
            "detail": latest.detail,
        }

    return {"corrections": out, "latest_replay": latest_payload}


@require_GET
@app_access_required("org-view")
def api_corrections(request, slug):
    company, perm, denied = _editing_context(request, slug, require_edit=False)
    if denied:
        return denied
    return JsonResponse(_corrections_payload(company, _active_snapshot(company)))


# ---------------------------------------------------------------------------
# POST /org-view/api/companies/<slug>/corrections/<int:pk>/revert/
# ---------------------------------------------------------------------------

@require_POST
@app_access_required("org-view")
def api_revert_correction(request, slug, pk):
    company, perm, denied = _editing_context(request, slug)
    if denied:
        return denied
    correction = StructureCorrection.objects.filter(company=company, pk=pk).first()
    if not correction:
        return _error("Correction not found.", 404)
    snap = _active_snapshot(company)
    if not snap:
        return _error("No active snapshot.", 404)

    corrections_svc.revert_correction(correction, snap)

    return JsonResponse({
        "ok": True,
        "tree": _fresh_tree(company, perm, target=changeset_svc.TARGET_CORRECTIONS,
                            snapshot=snap, scenario=None),
        **_corrections_payload(company, snap),
    })


# ---------------------------------------------------------------------------
# POST /org-view/api/companies/<slug>/corrections/<int:pk>/keep/
# ---------------------------------------------------------------------------

@require_POST
@app_access_required("org-view")
def api_keep_correction(request, slug, pk):
    """'Keep correction' on a drifted row — the source changed its mind, we didn't.

    Clears the drift flag and leaves the correction active, so it keeps replaying.
    Without this (and its sibling 'Accept source', which is just a revert) drifted
    rows accumulate forever.
    """
    company, perm, denied = _editing_context(request, slug)
    if denied:
        return denied
    correction = StructureCorrection.objects.filter(company=company, pk=pk).first()
    if not correction:
        return _error("Correction not found.", 404)

    snap = _active_snapshot(company)
    if snap:
        emp = Employee.objects.filter(
            snapshot=snap, employee_id=correction.employee_id,
        ).first()
        if emp is not None:
            # Re-baseline `before` onto what the census says now, so the row stops
            # reporting drift against a value nobody is going to restore.
            correction.before = corrections_svc.capture_before(
                emp, correction.kind, correction.after or {},
            )
    correction.replay_status = StructureCorrection.ReplayStatus.APPLIED
    correction.replay_detail = ""
    correction.is_active = True
    correction.save(update_fields=[
        "before", "replay_status", "replay_detail", "is_active", "updated_at",
    ])

    return JsonResponse({"ok": True, **_corrections_payload(company, snap)})
