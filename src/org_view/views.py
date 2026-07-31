"""
OrgView views — census upload pipeline, org chart, permissions admin, trends.
"""
import csv as csv_module
import json
import logging
from datetime import datetime
from decimal import Decimal, InvalidOperation

from accounts.decorators import app_access_required
from django.contrib import messages
from django.contrib.auth import get_user_model
from django.db import IntegrityError
from django.db.models import Count, Q
from django.http import HttpResponse
from django.shortcuts import get_object_or_404, redirect, render
from django.urls import reverse

from .models import (
    AppPermission, CensusSnapshot, Company, CorrectionReplayLog, Employee, Scenario,
    ScenarioPosition, StructureCorrection,
)
from .parsers import STANDARD_FIELDS, apply_mapping, auto_map_columns, parse_file
from .services import corrections as corrections_svc
from .services import scenarios as scenario_svc
from .validators import validate_rows

User = get_user_model()
logger = logging.getLogger(__name__)

# Session key — single dict holding all upload-pipeline state
_SK = "ov_upload"


def _clear_session(request):
    request.session.pop(_SK, None)


def _get_state(request) -> dict | None:
    return request.session.get(_SK)


def _set_state(request, data: dict):
    request.session[_SK] = data
    request.session.modified = True


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


def _admin_companies(user):
    """Companies this user has OrgView admin permission on."""
    if _is_superadmin(user):
        return Company.objects.filter(is_active=True)
    perm_ids = (
        AppPermission.objects.filter(user=user, role="admin", is_active=True)
        .values_list("company_id", flat=True)
    )
    return Company.objects.filter(id__in=perm_ids, is_active=True)


# ---------------------------------------------------------------------------
# Landing page
# ---------------------------------------------------------------------------

def _all_user_companies(user):
    """Companies this user has ANY OrgView permission on (admin or viewer)."""
    if _is_superadmin(user):
        return Company.objects.filter(is_active=True)
    perm_ids = (
        AppPermission.objects.filter(user=user, is_active=True)
        .values_list("company_id", flat=True)
    )
    return Company.objects.filter(id__in=perm_ids, is_active=True)


# ---------------------------------------------------------------------------
# Role helpers (three roles: admin / viewer / restricted)
# ---------------------------------------------------------------------------

def _perm_for(user, company):
    """The user's AppPermission for a company (synthetic admin for superadmins)."""
    if _is_superadmin(user):
        return AppPermission(user=user, company=company, role="admin", is_active=True)
    return AppPermission.objects.filter(user=user, company=company, is_active=True).first()


def _can_edit(user, company):
    """True if the user may make structural changes (admin / superadmin)."""
    perm = _perm_for(user, company)
    return bool(perm) and perm.role in AppPermission.EDIT_ROLES


def _can_see_pay(user, company):
    """False only for the 'restricted' role — pay/cost is hidden from them."""
    perm = _perm_for(user, company)
    return bool(perm) and perm.role in AppPermission.PAY_ROLES


@app_access_required("org-view")
def index(request):
    from django.utils import timezone as tz
    from .services.tree_builder import build_tree, strip_aggregation

    companies = _all_user_companies(request.user)
    is_admin = request.user.is_superuser or request.user.is_staff
    stale_cutoff = tz.now().date() - tz.timedelta(days=90)

    rows = []
    for co in companies:
        snapshots = list(
            CensusSnapshot.objects.filter(company=co)
            .exclude(status=CensusSnapshot.Status.PROCESSING)
            .order_by("-effective_date", "-upload_date")
        )
        # Find the is_current snapshot, fall back to most recent active
        latest = None
        for s in snapshots:
            if s.is_current and s.status == CensusSnapshot.Status.ACTIVE:
                latest = s
                break
        if not latest:
            for s in snapshots:
                if s.status == CensusSnapshot.Status.ACTIVE:
                    latest = s
                    break

        metrics = None
        is_stale = False
        see_pay = _can_see_pay(request.user, co)
        if latest:
            tree = build_tree(latest.id)
            tree = strip_aggregation(tree)
            if isinstance(tree, dict):
                metrics = tree.get("metrics")
            elif isinstance(tree, list) and tree:
                metrics = tree[0].get("metrics")
            if metrics and not see_pay:
                metrics = {**metrics, "total_labor_cost": None, "revenue_managed": None}
            eff = latest.effective_date or latest.upload_date.date()
            is_stale = eff < stale_cutoff

        rows.append({
            "company": co,
            "snapshots": snapshots,
            "latest": latest,
            "metrics": metrics,
            "is_stale": is_stale,
            "can_see_pay": see_pay,
        })

    return render(request, "org_view/index.html", {
        "rows": rows,
        "is_admin": is_admin,
        "has_companies": bool(rows),
    })


# ---------------------------------------------------------------------------
# Company detail (org chart placeholder — built in Chunk 6)
# ---------------------------------------------------------------------------

@app_access_required("org-view")
def company_detail(request, slug):
    company = get_object_or_404(Company, slug=slug, is_active=True)
    # Verify the user has permission for this company
    perm = AppPermission.objects.filter(
        user=request.user, company=company, is_active=True,
    ).first()
    if not perm and not _is_superadmin(request.user):
        messages.error(request, "You don't have access to that company.")
        return redirect("org_view:index")
    snapshots = (
        CensusSnapshot.objects.filter(company=company, status=CensusSnapshot.Status.ACTIVE)
        .order_by("-effective_date", "-upload_date")
    )
    # Use is_current snapshot, or fall back to most recent
    snap = snapshots.filter(is_current=True).first() or snapshots.first()
    # Allow ?snapshot_id= override for viewing historical data
    sid = request.GET.get("snapshot_id")
    if sid:
        override = snapshots.filter(id=sid).first()
        if override:
            snap = override

    can_edit = _can_edit(request.user, company)

    # ?mode=correct / ?mode=scenario&scenario=<id> so a reload or a shared link
    # lands where the user left off.
    mode = request.GET.get("mode", "view")
    if mode not in ("view", "correct", "scenario") or not can_edit:
        mode = "view"
    scenario = None
    if mode == "scenario":
        scenario = Scenario.objects.filter(
            id=request.GET.get("scenario"), company=company,
        ).first()
        if scenario is None:
            mode = "view"

    # The corrections ledger deep-links back here with ?focus=<employee_id>.
    focus_id = (request.GET.get("focus") or "").strip()[:50]

    # Pop the post-upload replay banner, if this is the page we landed on.
    replay_log = None
    replay_log_id = request.session.pop("org_view_replay_log_id", None)
    if replay_log_id:
        replay_log = CorrectionReplayLog.objects.filter(
            id=replay_log_id, company=company,
        ).first()

    return render(request, "org_view/company_detail.html", {
        "company": company,
        "snapshot": snap,
        "snapshots": snapshots,
        # perm is resolved above but was never passed; without it branchRootId
        # renders null and the client-side branch check never fires.
        "perm": _perm_for(request.user, company),
        "scenario": scenario,
        "mode": mode,
        "focus_id": focus_id,
        "replay_log": replay_log,
        "can_edit": can_edit,
        "can_see_pay": _can_see_pay(request.user, company),
        "scenario_count": Scenario.objects.filter(company=company).count(),
        "scenarios": Scenario.objects.filter(company=company).only("id", "name", "updated_at"),
        "snapshots_json": json.dumps([
            {
                "id": s.id,
                "label": s.label or "Unlabeled",
                "date": s.effective_date.strftime("%b %d, %Y") if s.effective_date else s.upload_date.strftime("%b %d, %Y"),
                "is_current": s.is_current,
            }
            for s in snapshots
        ]),
    })


# ---------------------------------------------------------------------------
# Corrections review — the audit trail and the drift-resolution workflow
# ---------------------------------------------------------------------------

@app_access_required("org-view")
def corrections_review(request, slug):
    company, denied = _company_access(request, slug)
    if denied:
        return denied

    snap = (
        CensusSnapshot.objects.filter(
            company=company, status=CensusSnapshot.Status.ACTIVE, is_current=True,
        ).first()
        or CensusSnapshot.objects.filter(company=company, status=CensusSnapshot.Status.ACTIVE)
        .order_by("-effective_date", "-upload_date").first()
    )
    latest_replay = CorrectionReplayLog.objects.filter(company=company).first()

    return render(request, "org_view/corrections_review.html", {
        "company": company,
        "snapshot": snap,
        "latest_replay": latest_replay,
        "can_edit": _can_edit(request.user, company),
        "total_corrections": StructureCorrection.objects.filter(
            company=company, is_active=True,
        ).count(),
    })


# ---------------------------------------------------------------------------
# Trends page
# ---------------------------------------------------------------------------

@app_access_required("org-view")
def trends(request, slug):
    company = get_object_or_404(Company, slug=slug, is_active=True)
    perm = AppPermission.objects.filter(
        user=request.user, company=company, is_active=True,
    ).first()
    if not perm and not _is_superadmin(request.user):
        messages.error(request, "You don't have access to that company.")
        return redirect("org_view:index")
    snapshots = (
        CensusSnapshot.objects.filter(company=company, status=CensusSnapshot.Status.ACTIVE)
        .order_by("-effective_date", "-upload_date")
    )
    return render(request, "org_view/trends.html", {
        "company": company,
        "snapshots": snapshots,
        "snapshot_count": snapshots.count(),
    })


# ---------------------------------------------------------------------------
# Permissions admin
# ---------------------------------------------------------------------------

def _require_admin(request):
    """Return True if user is superadmin or staff, else redirect."""
    if _is_superadmin(request.user) or request.user.is_staff or request.user.is_superuser:
        return None
    messages.error(request, "You don't have access to this page.")
    return redirect("org_view:index")


@app_access_required("org-view")
def permissions_list(request):
    denied = _require_admin(request)
    if denied:
        return denied
    perms = (
        AppPermission.objects
        .select_related("user", "company")
        .order_by("company__name", "user__last_name", "user__first_name")
    )
    # Resolve branch root names
    for p in perms:
        p.branch_name = None
        if p.branch_root_employee_id:
            snap = (
                CensusSnapshot.objects.filter(
                    company=p.company, status=CensusSnapshot.Status.ACTIVE
                ).order_by("-effective_date", "-upload_date").first()
            )
            if snap:
                emp = Employee.objects.filter(
                    snapshot=snap, employee_id=p.branch_root_employee_id
                ).first()
                if emp:
                    p.branch_name = f"{emp.full_name} — {emp.job_title}"

    return render(request, "org_view/permissions_list.html", {
        "permissions": perms,
        "companies": Company.objects.filter(is_active=True),
    })


@app_access_required("org-view")
def permission_add(request):
    denied = _require_admin(request)
    if denied:
        return denied

    companies = Company.objects.filter(is_active=True)
    users = User.objects.filter(is_active=True).order_by("last_name", "first_name")

    if request.method == "POST":
        user_id = request.POST.get("user_id")
        company_id = request.POST.get("company_id")
        role = request.POST.get("role", "viewer")
        branch_eid = request.POST.get("branch_root_employee_id", "").strip() or None

        if not user_id or not company_id:
            messages.error(request, "User and Company are required.")
            return render(request, "org_view/permission_form.html", {
                "companies": companies, "users": users, "form_action": "Add",
            })

        try:
            AppPermission.objects.create(
                user_id=user_id,
                company_id=company_id,
                role=role,
                branch_root_employee_id=branch_eid,
            )
            messages.success(request, "Permission created.")
        except IntegrityError:
            messages.error(request, "A permission already exists for this user + company.")
            return render(request, "org_view/permission_form.html", {
                "companies": companies, "users": users, "form_action": "Add",
            })

        return redirect("org_view:permissions_list")

    return render(request, "org_view/permission_form.html", {
        "companies": companies, "users": users, "form_action": "Add",
    })


@app_access_required("org-view")
def permission_edit(request, pk):
    denied = _require_admin(request)
    if denied:
        return denied

    perm = get_object_or_404(AppPermission, pk=pk)
    companies = Company.objects.filter(is_active=True)
    users = User.objects.filter(is_active=True).order_by("last_name", "first_name")

    if request.method == "POST":
        perm.user_id = request.POST.get("user_id", perm.user_id)
        perm.company_id = request.POST.get("company_id", perm.company_id)
        perm.role = request.POST.get("role", perm.role)
        perm.branch_root_employee_id = request.POST.get("branch_root_employee_id", "").strip() or None
        perm.is_active = request.POST.get("is_active") == "on"
        try:
            perm.save()
            messages.success(request, "Permission updated.")
        except IntegrityError:
            messages.error(request, "A permission already exists for this user + company.")
            return render(request, "org_view/permission_form.html", {
                "companies": companies, "users": users, "perm": perm,
                "form_action": "Edit",
            })
        return redirect("org_view:permissions_list")

    return render(request, "org_view/permission_form.html", {
        "companies": companies, "users": users, "perm": perm,
        "form_action": "Edit",
    })


@app_access_required("org-view")
def permission_delete(request, pk):
    denied = _require_admin(request)
    if denied:
        return denied

    perm = get_object_or_404(AppPermission, pk=pk)
    if request.method == "POST":
        perm.delete()
        messages.success(request, "Permission deleted.")
    return redirect("org_view:permissions_list")


@app_access_required("org-view")
def permission_quick_setup(request):
    denied = _require_admin(request)
    if denied:
        return denied

    companies = Company.objects.filter(is_active=True)

    if request.method == "POST":
        company_id = request.POST.get("company_id")
        selected = request.POST.getlist("employee_ids")
        if not company_id or not selected:
            messages.error(request, "Select a company and at least one leader.")
            return redirect("org_view:permission_quick_setup")

        company = get_object_or_404(Company, id=company_id, is_active=True)
        snap = (
            CensusSnapshot.objects.filter(company=company, status=CensusSnapshot.Status.ACTIVE)
            .order_by("-effective_date", "-upload_date").first()
        )
        if not snap:
            messages.error(request, "No active snapshot for this company.")
            return redirect("org_view:permission_quick_setup")

        created = 0
        for eid in selected:
            emp = Employee.objects.filter(snapshot=snap, employee_id=eid).first()
            if not emp:
                continue
            # Find or create a user stub — for quick setup we need an existing user
            # Just create the permission with branch_root set
            # The admin will need to assign to actual users separately
            # For now, create with the requesting user as a placeholder is wrong —
            # skip user creation, just show the leaders. Actual permission_add handles user selection.

        messages.info(request, "Use the Add Permission form to assign users to each branch leader.")
        return redirect("org_view:permissions_list")

    # GET: show top-level leaders per company
    company_id = request.GET.get("company_id")
    leaders = []
    selected_company = None
    if company_id:
        selected_company = Company.objects.filter(id=company_id, is_active=True).first()
        if selected_company:
            snap = (
                CensusSnapshot.objects.filter(
                    company=selected_company, status=CensusSnapshot.Status.ACTIVE
                ).order_by("-effective_date", "-upload_date").first()
            )
            if snap:
                from .services.tree_builder import build_tree, strip_aggregation
                tree = build_tree(snap.id, max_depth=3)
                tree = strip_aggregation(tree)

                def collect_leaders(node, depth=0):
                    if depth > 2:
                        return
                    leaders.append({
                        "employee_id": node["employee_id"],
                        "full_name": node["full_name"],
                        "job_title": node.get("job_title", ""),
                        "management_level": node.get("management_level", ""),
                        "headcount": node.get("metrics", {}).get("headcount", 0),
                        "depth": depth,
                    })
                    for ch in node.get("children", []):
                        collect_leaders(ch, depth + 1)

                roots = tree if isinstance(tree, list) else [tree]
                for r in roots:
                    collect_leaders(r)

    return render(request, "org_view/permission_quick_setup.html", {
        "companies": companies,
        "selected_company": selected_company,
        "leaders": leaders,
    })


# ---------------------------------------------------------------------------
# 1. Upload
# ---------------------------------------------------------------------------

@app_access_required("org-view")
def upload(request):
    from datetime import date as date_type

    companies = _admin_companies(request.user)

    if request.method != "POST":
        return render(request, "org_view/upload.html", {"companies": companies})

    file = request.FILES.get("file")
    company_id = request.POST.get("company_id")
    label = request.POST.get("label", "").strip()
    effective_date_str = request.POST.get("effective_date", "").strip()
    set_as_active = request.POST.get("set_as_active") == "on"

    if not file:
        messages.error(request, "Please select a file to upload.")
        return render(request, "org_view/upload.html", {"companies": companies})

    company = companies.filter(id=company_id).first()
    if not company:
        messages.error(request, "Please select a company you have admin access to.")
        return render(request, "org_view/upload.html", {"companies": companies})

    # Parse effective date
    effective_date = None
    if effective_date_str:
        try:
            effective_date = datetime.strptime(effective_date_str, "%Y-%m-%d").date()
            if effective_date > date_type.today():
                messages.error(request, "Census effective date cannot be in the future.")
                return render(request, "org_view/upload.html", {"companies": companies})
        except ValueError:
            messages.error(request, "Invalid date format. Use YYYY-MM-DD.")
            return render(request, "org_view/upload.html", {"companies": companies})
    else:
        effective_date = date_type.today()

    # Default set_as_active to True if this is the company's first snapshot
    if not CensusSnapshot.objects.filter(company=company, status=CensusSnapshot.Status.ACTIVE).exists():
        set_as_active = True

    filename = file.name
    if not filename.lower().endswith((".csv", ".xlsx", ".xls")):
        messages.error(request, "Supported formats: .csv, .xlsx, .xls")
        return render(request, "org_view/upload.html", {"companies": companies})

    try:
        headers, rows = parse_file(file, filename)
    except Exception as exc:
        messages.error(request, f"Could not parse file: {exc}")
        return render(request, "org_view/upload.html", {"companies": companies})

    if not rows:
        messages.error(request, "The uploaded file appears to be empty.")
        return render(request, "org_view/upload.html", {"companies": companies})

    # Save file to a processing snapshot now so it persists
    file.seek(0)
    snapshot = CensusSnapshot(
        company=company,
        label=label,
        uploaded_by=request.user,
        original_filename=filename,
        effective_date=effective_date,
        status=CensusSnapshot.Status.PROCESSING,
    )
    snapshot.file.save(filename, file, save=True)

    auto_mapping = auto_map_columns(headers)

    _clear_session(request)
    _set_state(request, {
        "snapshot_id": snapshot.id,
        "company_id": company.id,
        "label": label,
        "original_filename": filename,
        "headers": headers,
        "rows": rows,
        "auto_mapping": auto_mapping,
        "set_as_active": set_as_active,
    })

    return redirect("org_view:mapping")


# ---------------------------------------------------------------------------
# 2. Column mapping
# ---------------------------------------------------------------------------

@app_access_required("org-view")
def mapping(request):
    state = _get_state(request)
    if not state or "rows" not in state:
        messages.error(request, "Upload session expired. Please start again.")
        return redirect("org_view:upload")

    headers = state["headers"]
    rows = state["rows"]
    auto_mapping = state["auto_mapping"]

    if request.method == "POST":
        confirmed = {}
        for field, _, _ in STANDARD_FIELDS:
            val = request.POST.get(f"map_{field}", "").strip()
            confirmed[field] = val if val else None

        mapped_rows = apply_mapping(rows, confirmed)
        errors, warnings = validate_rows(mapped_rows)

        # Strip _raw from session storage (raw_data goes into Employee.raw_data at save time)
        state["mapping"] = confirmed
        state["mapped_rows"] = mapped_rows
        state["errors"] = errors
        state["warnings"] = warnings
        # Drop bulk raw rows to shrink session
        state.pop("rows", None)
        _set_state(request, state)

        return redirect("org_view:quality_report")

    context = {
        "headers": headers,
        "auto_mapping": auto_mapping,
        "auto_mapping_json": json.dumps(auto_mapping),
        "standard_fields": STANDARD_FIELDS,
        "preview_rows": rows[:5],
        "filename": state["original_filename"],
        "row_count": len(rows),
    }
    return render(request, "org_view/mapping.html", context)


# ---------------------------------------------------------------------------
# 3. Quality report
# ---------------------------------------------------------------------------

@app_access_required("org-view")
def quality_report(request):
    state = _get_state(request)
    if not state or "mapped_rows" not in state:
        messages.error(request, "Upload session expired. Please start again.")
        return redirect("org_view:upload")

    errors = state.get("errors", [])
    warnings = state.get("warnings", [])

    context = {
        "errors": errors,
        "warnings": warnings,
        "has_blocking": bool(errors),
        "row_count": len(state["mapped_rows"]),
        "error_row_count": sum(len(e["rows"]) for e in errors),
        "warning_row_count": sum(len(w["rows"]) for w in warnings),
        "filename": state["original_filename"],
    }
    return render(request, "org_view/quality_report.html", context)


# ---------------------------------------------------------------------------
# 4. Bulk edit
# ---------------------------------------------------------------------------

@app_access_required("org-view")
def bulk_edit(request):
    state = _get_state(request)
    if not state or "mapped_rows" not in state:
        messages.error(request, "Upload session expired. Please start again.")
        return redirect("org_view:upload")

    if request.method == "POST":
        try:
            edited_rows = json.loads(request.POST.get("rows_json", "[]"))
        except (json.JSONDecodeError, ValueError):
            messages.error(request, "Invalid data submitted.")
            return redirect("org_view:bulk_edit")

        errors, warnings = validate_rows(edited_rows)
        state["mapped_rows"] = edited_rows
        state["errors"] = errors
        state["warnings"] = warnings
        _set_state(request, state)

        action = request.POST.get("action")
        if action == "save" and not errors:
            return redirect("org_view:save_snapshot")
        if action == "save" and errors:
            messages.error(request, "Cannot save — resolve all errors first.")
        return redirect("org_view:quality_report")

    # Build row-level flag sets for highlighting
    errors = state.get("errors", [])
    warnings = state.get("warnings", [])
    error_rows = set()
    warning_rows = set()
    for e in errors:
        error_rows.update(e["rows"])
    for w in warnings:
        warning_rows.update(w["rows"])

    display_fields = [(f, label) for f, label, _ in STANDARD_FIELDS]

    context = {
        "rows_json": json.dumps(state["mapped_rows"]),
        "rows": state["mapped_rows"],
        "display_fields": display_fields,
        "error_rows_json": json.dumps(sorted(x for x in error_rows if x is not None)),
        "warning_rows_json": json.dumps(sorted(x for x in warning_rows if x is not None)),
        "filename": state["original_filename"],
    }
    return render(request, "org_view/bulk_edit.html", context)


# ---------------------------------------------------------------------------
# 5. Save snapshot
# ---------------------------------------------------------------------------

@app_access_required("org-view")
def save_snapshot(request):
    if request.method != "POST":
        return redirect("org_view:quality_report")

    state = _get_state(request)
    if not state or "mapped_rows" not in state:
        messages.error(request, "Upload session expired. Please start again.")
        return redirect("org_view:upload")

    if state.get("errors"):
        messages.error(request, "Cannot save — resolve all errors first.")
        return redirect("org_view:quality_report")

    snapshot = get_object_or_404(CensusSnapshot, id=state["snapshot_id"])
    mapped_rows = state["mapped_rows"]
    mapping = state.get("mapping", {})
    warning_count = sum(len(w["rows"]) for w in state.get("warnings", []))
    set_as_active = state.get("set_as_active", False)

    _perform_save(snapshot, mapped_rows, mapping, warning_count, set_as_active)
    _clear_session(request)

    messages.success(
        request,
        f"Snapshot saved: {snapshot.employee_count} employees loaded for {snapshot.company.name}.",
    )

    # Re-apply saved structural corrections to the new census. A bad correction
    # must never block a census refresh, so failures warn rather than raise.
    if snapshot.company.corrections.filter(is_active=True).exists():
        try:
            log = corrections_svc.replay_corrections(snapshot, user=request.user)
            request.session["org_view_replay_log_id"] = log.id
            messages.info(
                request,
                f"Re-applied {log.applied_count} saved correction(s) to this census. "
                f"{log.drifted_count} changed at source, {log.stale_count} no longer apply, "
                f"{log.conflict_count} need attention.",
            )
        except Exception as exc:
            logger.exception("Correction replay failed for snapshot %s", snapshot.id)
            messages.warning(
                request,
                "The census saved, but saved corrections could not be re-applied "
                f"automatically ({exc}). Open the Corrections page to re-check them.",
            )

    return redirect("org_view:index")


def _perform_save(snapshot, mapped_rows, mapping, warning_count, set_as_active=False):
    """Create Employee records, resolve supervisor tree, finalise snapshot."""
    employees_to_create = []
    for row in mapped_rows:
        employees_to_create.append(Employee(**_row_to_employee_kwargs(row, snapshot)))

    Employee.objects.bulk_create(employees_to_create, ignore_conflicts=True)

    # Resolve supervisor FKs — one implementation, shared with the corrections layer.
    corrections_svc.resolve_supervisor_fks(snapshot)
    all_employees = Employee.objects.filter(snapshot=snapshot)

    snapshot.employee_count = all_employees.count()
    snapshot.warnings_count = warning_count
    snapshot.column_mapping = mapping
    snapshot.status = CensusSnapshot.Status.ACTIVE
    snapshot.is_current = set_as_active
    snapshot.save(update_fields=["employee_count", "warnings_count", "column_mapping", "status", "is_current"])


# ---------------------------------------------------------------------------
# Helpers — row → Employee kwargs
# ---------------------------------------------------------------------------

def _row_to_employee_kwargs(row: dict, snapshot) -> dict:
    raw_row = {k: v for k, v in row.items() if not k.startswith("_")}
    return {
        "snapshot":           snapshot,
        "employee_id":        _str(row, "employee_id") or f"UNKNOWN-{row.get('_row_num', 0)}",
        "first_name":         _str(row, "first_name"),
        "last_name":          _str(row, "last_name"),
        "raw_supervisor_id":  _str(row, "supervisor_id") or None,
        "job_title":          _str(row, "job_title"),
        "management_level":   _str(row, "management_level"),
        "department":         _str(row, "department"),
        "site_location":      _str(row, "site_location"),
        "city":               _str(row, "city"),
        "state":              _str(row, "state"),
        "employee_status":    _str(row, "employee_status"),
        "employee_type":      _str(row, "employee_type"),
        "pay_type":           _str(row, "pay_type"),
        "annual_salary":      _decimal(row.get("annual_salary")),
        "fully_loaded_cost":  _decimal(row.get("fully_loaded_cost")),
        "is_overhead":        _bool(row.get("is_overhead")),
        "hire_date":          _date(row.get("hire_date")),
        "revenue_attribution": _decimal(row.get("revenue_attribution")),
        "cost_center":        _str(row, "cost_center"),
        "entity":             _str(row, "entity"),
        "union_affiliation":  _str(row, "union_affiliation"),
        "flsa_status":        _str(row, "flsa_status"),
        "raw_data":           raw_row,
    }


def _str(row, key):
    return str(row.get(key, "")).strip()


def _decimal(val):
    if val is None:
        return None
    try:
        cleaned = str(val).replace(",", "").replace("$", "").strip()
        return Decimal(cleaned) if cleaned else None
    except InvalidOperation:
        return None


def _date(val):
    if not val:
        return None
    s = str(val).strip()
    for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y", "%d/%m/%Y", "%Y%m%d"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    return None


def _bool(val):
    if val is None or str(val).strip() == "":
        return None
    return str(val).strip().lower() in ("yes", "true", "1", "y")


# ---------------------------------------------------------------------------
# Template download
# ---------------------------------------------------------------------------

TEMPLATE_DATA = [
    ("employee_id",         "12345",                        "Unique identifier (badge number, HR ID, etc.)"),
    ("first_name",          "Jane",                         "Employee first name"),
    ("last_name",           "Smith",                        "Employee last name"),
    ("supervisor_id",       "10001",                        "Employee ID of direct supervisor (blank for top-level)"),
    ("job_title",           "Operations Manager",           "Official job title"),
    ("entity",              "Flooring Partners",            "Legal entity or subsidiary"),
    ("management_level",    "Manager",                      "CEO, SVP, VP, Director, Manager, IC, etc."),
    ("department",          "Operations",                   "Department or business unit"),
    ("employee_status",     "Active",                       "Active, LOA, Terminated"),
    ("employee_type",       "Full-time",                    "Full-time, Part-time, Seasonal, Temp"),
    ("pay_type",            "Salaried",                     "Salaried or Hourly"),
    ("annual_salary",       "75000",                        "Annualized base salary (no $ or commas)"),
    ("site_location",       "HQ - Seattle",                 "Physical work location"),
    ("city",                "Seattle",                      "City"),
    ("state",               "WA",                           "State / Province"),
    ("fully_loaded_cost",   "95000",                        "Salary + benefits + burden"),
    ("is_overhead",         "No",                           "Yes = overhead; No = frontline"),
    ("hire_date",           "2019-03-15",                   "YYYY-MM-DD"),
    ("revenue_attribution", "500000",                       "Revenue attributed to this role"),
    ("cost_center",         "OPS-001",                      "Accounting cost center"),
    ("union_affiliation",   "SEIU Local 6",                 "Union name, or blank"),
    ("flsa_status",         "Exempt",                       "Exempt or Non-Exempt"),
]


@app_access_required("org-view")
def download_template(request):
    response = HttpResponse(content_type="text/csv")
    response["Content-Disposition"] = 'attachment; filename="orgview_census_template.csv"'
    writer = csv_module.writer(response)
    writer.writerow([r[0] for r in TEMPLATE_DATA])
    writer.writerow([r[1] for r in TEMPLATE_DATA])
    writer.writerow([r[2] for r in TEMPLATE_DATA])
    return response


# ---------------------------------------------------------------------------
# Scenario planning (cleanup + design)
# ---------------------------------------------------------------------------

def _company_access(request, slug):
    """(company, None) if the user can access it, else (None, redirect)."""
    company = get_object_or_404(Company, slug=slug, is_active=True)
    if not _perm_for(request.user, company):
        messages.error(request, "You don't have access to that company.")
        return None, redirect("org_view:index")
    return company, None


@app_access_required("org-view")
def scenario_list(request, slug):
    company, denied = _company_access(request, slug)
    if denied:
        return denied
    scenarios = (
        Scenario.objects.filter(company=company)
        .select_related("base_snapshot", "created_by")
        .annotate(change_count=Count(
            "positions",
            filter=~Q(positions__change_type=ScenarioPosition.ChangeType.UNCHANGED),
        ))
    )
    snapshots = (
        CensusSnapshot.objects.filter(company=company, status=CensusSnapshot.Status.ACTIVE)
        .order_by("-effective_date", "-upload_date")
    )
    return render(request, "org_view/scenario_list.html", {
        "company": company,
        "scenarios": scenarios,
        "snapshots": snapshots,
        "can_edit": _can_edit(request.user, company),
    })


@app_access_required("org-view")
def scenario_create(request, slug):
    company, denied = _company_access(request, slug)
    if denied:
        return denied
    if not _can_edit(request.user, company):
        messages.error(request, "You need admin access to create a scenario.")
        return redirect("org_view:scenario_list", slug=slug)
    if request.method != "POST":
        return redirect("org_view:scenario_list", slug=slug)

    base = CensusSnapshot.objects.filter(
        id=request.POST.get("base_snapshot_id"), company=company,
        status=CensusSnapshot.Status.ACTIVE,
    ).first()
    if not base:
        base = (
            CensusSnapshot.objects.filter(
                company=company, status=CensusSnapshot.Status.ACTIVE, is_current=True,
            ).first()
            or CensusSnapshot.objects.filter(
                company=company, status=CensusSnapshot.Status.ACTIVE,
            ).order_by("-effective_date", "-upload_date").first()
        )
    if not base:
        messages.error(request, "This company has no saved census to base a scenario on.")
        return redirect("org_view:scenario_list", slug=slug)

    scenario = scenario_svc.create_scenario(
        company=company, base_snapshot=base,
        name=request.POST.get("name", "").strip() or "Untitled scenario",
        description=request.POST.get("description", "").strip(),
        user=request.user,
    )
    correction_count = StructureCorrection.objects.filter(
        company=company, is_active=True,
    ).count()
    messages.success(
        request,
        f"Scenario '{scenario.name}' created from {base.employee_count} positions"
        + (f" ({correction_count} correction(s) applied to the baseline)."
           if correction_count else "."),
    )
    return redirect(_scenario_chart_url(slug, scenario.id))


def _scenario_chart_url(slug, scenario_id):
    return (
        f"{reverse('org_view:company_detail', kwargs={'slug': slug})}"
        f"?mode=scenario&scenario={scenario_id}"
    )


@app_access_required("org-view")
def scenario_detail(request, slug, scenario_id):
    """The chart, in scenario mode.

    Kept as its own URL so existing links and bookmarks still resolve. The old
    265-line form list is gone: it re-rendered every position on every edit
    (640,800 ``<option>`` tags at 800 headcount), had no search, no chart, and no
    undo — and it ignored ``perm.branch_root_employee_id`` entirely while
    ``api_scenario_tree`` honoured it. The chart sources its tree from that API,
    so the branch-scoping gap closes by construction.
    """
    company, denied = _company_access(request, slug)
    if denied:
        return denied
    scenario = get_object_or_404(Scenario, id=scenario_id, company=company)
    return redirect(_scenario_chart_url(slug, scenario.id))


@app_access_required("org-view")
def scenario_action(request, slug, scenario_id):
    """Scenario metadata only — every structural edit goes through the changeset API.

    The ``save_position``, ``eliminate`` and ``reassign`` branches are deleted.
    ``save_position`` in particular ran ``reassign_manager`` first and let the
    outer ``except ValueError`` swallow a rejected move, so ``edit_position``
    never ran and the user's title/department/salary edits vanished silently.
    That whole class of bug is now impossible: the changeset endpoint validates
    the batch before writing anything and commits atomically.
    """
    company, denied = _company_access(request, slug)
    if denied:
        return denied
    scenario = get_object_or_404(Scenario, id=scenario_id, company=company)
    back = _scenario_chart_url(slug, scenario.id)
    if not _can_edit(request.user, company):
        messages.error(request, "You need admin access to edit a scenario.")
        return redirect(back)
    if request.method != "POST":
        return redirect(back)

    if request.POST.get("action", "") == "rename":
        scenario.name = request.POST.get("name", scenario.name).strip() or scenario.name
        scenario.description = request.POST.get("description", scenario.description).strip()
        scenario.save(update_fields=["name", "description", "updated_at"])
        messages.success(request, "Scenario details updated.")
    else:
        messages.error(request, "Unknown action.")

    return redirect(back)


@app_access_required("org-view")
def scenario_delete(request, slug, scenario_id):
    company, denied = _company_access(request, slug)
    if denied:
        return denied
    scenario = get_object_or_404(Scenario, id=scenario_id, company=company)
    if not _can_edit(request.user, company):
        messages.error(request, "You need admin access to delete a scenario.")
        return redirect(_scenario_chart_url(slug, scenario.id))
    if request.method == "POST":
        name = scenario.name
        scenario.delete()
        messages.success(request, f"Scenario '{name}' deleted.")
        return redirect("org_view:scenario_list", slug=slug)
    return redirect(_scenario_chart_url(slug, scenario.id))
