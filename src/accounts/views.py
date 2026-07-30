from django.contrib import messages
from django.contrib.auth.models import User
from django.core.exceptions import PermissionDenied
from django.db import transaction
from django.shortcuts import get_object_or_404, redirect, render

from .forms import AddUserForm, AdminPasswordResetForm, CompanyForm, EditUserForm
from .models import AppDefinition, CompanyProfile, UserProfile


# ---------------------------------------------------------------------------
# Permission helpers
# ---------------------------------------------------------------------------

def _get_admin_profile(request):
    """Returns profile if superadmin or company_admin, else raises PermissionDenied."""
    if not request.user.is_authenticated:
        raise PermissionDenied
    try:
        profile = request.user.profile
        if profile.role in ("superadmin", "company_admin"):
            return profile
    except UserProfile.DoesNotExist:
        pass
    raise PermissionDenied


def _get_superadmin_profile(request):
    """Returns profile if superadmin, else raises PermissionDenied."""
    if not request.user.is_authenticated:
        raise PermissionDenied
    try:
        profile = request.user.profile
        if profile.role == "superadmin":
            return profile
    except UserProfile.DoesNotExist:
        pass
    raise PermissionDenied


# ---------------------------------------------------------------------------
# Admin dashboard
# ---------------------------------------------------------------------------

def admin_dashboard(request):
    profile = _get_admin_profile(request)

    if profile.role == "superadmin":
        users = UserProfile.objects.select_related("user", "company").all()
        companies = CompanyProfile.objects.all()
    else:
        users = UserProfile.objects.select_related("user", "company").filter(
            company=profile.company
        )
        companies = CompanyProfile.objects.filter(pk=profile.company.pk)

    return render(request, "accounts/admin_dashboard.html", {
        "profile": profile,
        "users": users,
        "companies": companies,
        "total_users": users.count(),
        "total_companies": companies.count(),
    })


# ---------------------------------------------------------------------------
# User views
# ---------------------------------------------------------------------------

def user_list(request):
    profile = _get_admin_profile(request)

    if profile.role == "superadmin":
        qs = UserProfile.objects.select_related("user", "company").all()
        company_filter = request.GET.get("company")
        role_filter = request.GET.get("role")
        if company_filter:
            qs = qs.filter(company_id=company_filter)
        if role_filter:
            qs = qs.filter(role=role_filter)
        companies = CompanyProfile.objects.filter(is_active=True)
    else:
        qs = UserProfile.objects.select_related("user", "company").filter(
            company=profile.company
        )
        role_filter = request.GET.get("role")
        if role_filter:
            qs = qs.filter(role=role_filter)
        companies = []

    return render(request, "accounts/user_list.html", {
        "profile": profile,
        "users": qs,
        "companies": companies,
        "roles": UserProfile.Role.choices,
        "selected_company": request.GET.get("company", ""),
        "selected_role": request.GET.get("role", ""),
    })


def user_add(request):
    profile = _get_admin_profile(request)

    if request.method == "POST":
        form = AddUserForm(request.POST, admin_profile=profile)
        if form.is_valid():
            data = form.cleaned_data
            with transaction.atomic():
                user = User.objects.create_user(
                    username=data["username"],
                    email=data.get("email", ""),
                    password=data["password"],
                    first_name=data.get("first_name", ""),
                    last_name=data.get("last_name", ""),
                )
                user_profile = UserProfile.objects.create(
                    user=user,
                    company=data["company"],
                    role=data["role"],
                )
                if data.get("assigned_apps"):
                    user_profile.assigned_apps.set(data["assigned_apps"])
            messages.success(request, f"User '{user.get_full_name() or user.username}' created successfully.")
            return redirect("accounts:user_list")
    else:
        form = AddUserForm(admin_profile=profile)

    return render(request, "accounts/user_form.html", {
        "profile": profile,
        "form": form,
        "mode": "add",
        "title": "Add User",
    })


def user_edit(request, user_id):
    profile = _get_admin_profile(request)
    target_profile = get_object_or_404(UserProfile, pk=user_id)

    # Company admins can only edit users in their own company
    if profile.role == "company_admin" and target_profile.company != profile.company:
        raise PermissionDenied

    if request.method == "POST":
        form = EditUserForm(
            request.POST,
            admin_profile=profile,
            target_company=target_profile.company,
        )
        if form.is_valid():
            data = form.cleaned_data
            with transaction.atomic():
                target_profile.user.first_name = data.get("first_name", "")
                target_profile.user.last_name = data.get("last_name", "")
                target_profile.user.email = data.get("email", "")
                target_profile.user.save()

                if profile.role == "superadmin":
                    target_profile.company = data["company"]
                target_profile.role = data["role"]
                target_profile.is_active = data.get("is_active", True)
                target_profile.save()

                if data.get("assigned_apps") is not None:
                    target_profile.assigned_apps.set(data["assigned_apps"])
                else:
                    target_profile.assigned_apps.clear()

            messages.success(request, f"User '{target_profile.user.get_full_name() or target_profile.user.username}' updated.")
            return redirect("accounts:user_list")
    else:
        initial = {
            "first_name": target_profile.user.first_name,
            "last_name": target_profile.user.last_name,
            "email": target_profile.user.email,
            "company": target_profile.company,
            "role": target_profile.role,
            "assigned_apps": target_profile.assigned_apps.all(),
            "is_active": target_profile.is_active,
        }
        form = EditUserForm(
            initial=initial,
            admin_profile=profile,
            target_company=target_profile.company,
        )

    return render(request, "accounts/user_form.html", {
        "profile": profile,
        "form": form,
        "target_profile": target_profile,
        "mode": "edit",
        "title": f"Edit User: {target_profile.user.get_full_name() or target_profile.user.username}",
    })


def user_reset_password(request, user_id):
    profile = _get_admin_profile(request)
    target_profile = get_object_or_404(UserProfile, pk=user_id)

    if profile.role == "company_admin" and target_profile.company != profile.company:
        raise PermissionDenied

    if request.method == "POST":
        form = AdminPasswordResetForm(request.POST)
        if form.is_valid():
            target_profile.user.set_password(form.cleaned_data["new_password"])
            target_profile.user.save()
            messages.success(
                request,
                f"Password for '{target_profile.user.get_full_name() or target_profile.user.username}' has been reset.",
            )
            return redirect("accounts:user_list")
    else:
        form = AdminPasswordResetForm()

    return render(request, "accounts/password_reset.html", {
        "profile": profile,
        "form": form,
        "target_profile": target_profile,
    })


# ---------------------------------------------------------------------------
# Company views (superadmin only)
# ---------------------------------------------------------------------------

def company_list(request):
    profile = _get_superadmin_profile(request)
    companies = CompanyProfile.objects.prefetch_related("available_apps", "members").all()
    return render(request, "accounts/company_list.html", {
        "profile": profile,
        "companies": companies,
    })


def company_add(request):
    profile = _get_superadmin_profile(request)

    if request.method == "POST":
        form = CompanyForm(request.POST)
        if form.is_valid():
            company = form.save()
            messages.success(request, f"Company '{company.name}' created.")
            return redirect("accounts:company_list")
    else:
        form = CompanyForm()

    return render(request, "accounts/company_form.html", {
        "profile": profile,
        "form": form,
        "mode": "add",
        "title": "Add Company",
    })


def company_edit(request, company_id):
    profile = _get_superadmin_profile(request)
    company = get_object_or_404(CompanyProfile, pk=company_id)

    if request.method == "POST":
        form = CompanyForm(request.POST, instance=company)
        if form.is_valid():
            form.save()
            messages.success(request, f"Company '{company.name}' updated.")
            return redirect("accounts:company_list")
    else:
        form = CompanyForm(instance=company)

    return render(request, "accounts/company_form.html", {
        "profile": profile,
        "form": form,
        "company": company,
        "mode": "edit",
        "title": f"Edit Company: {company.name}",
    })
