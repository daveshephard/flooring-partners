"""
OrgView JSON API endpoints.

All endpoints require the user to be logged in with org-view app access,
plus company-level AppPermission checks.
"""
from django.db.models import Q
from django.http import JsonResponse
import json as _json
from datetime import date as _date

from django.views.decorators.http import require_GET, require_POST

from accounts.decorators import app_access_required

from .models import AppPermission, CensusSnapshot, Company, Employee, Scenario
from .services.tree_builder import build_tree, get_employee_path, redact_pay, strip_aggregation
from .services.scenarios import build_scenario_tree


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

    tree = build_tree(snap.id, root_employee_id=root_id, max_depth=max_depth)
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
        "scenario_id":   scenario.id,
        "scenario_name": scenario.name,
        "company":       company.name,
        "can_see_pay":   _can_see_pay(perm),
        "tree":          tree,
    })
