# flooring_partners_apps/views.py
from django.contrib.auth import logout
from django.contrib.auth.decorators import login_required
from django.http import JsonResponse
from django.shortcuts import redirect, render

from accounts.models import AppDefinition, UserProfile


SECTION_META = {
    "administrative": {
        "title": "Administrative",
        "description": "Internal operations, HR, finance admin, and corporate tooling.",
    },
    "commercial_sales": {
        "title": "Commercial & Sales",
        "description": "Pipeline, proposals, and customer-facing tools.",
    },
    "business_performance": {
        "title": "Business Performance and Reporting",
        "description": "Dashboards, KPIs, and operational reporting.",
    },
}

SECTION_ORDER = ["administrative", "commercial_sales", "business_performance"]


def healthz(request):
    """Liveness probe for Railway. No DB access, no auth, always cheap."""
    return JsonResponse({"status": "ok"})


def logout_view(request):
    """Log the user out and redirect to the login page. Accepts GET so a plain <a> works."""
    logout(request)
    return redirect("login")


@login_required
def app_hub(request):
    """App hub: grid of available apps grouped by section, scoped by the user's role."""
    try:
        profile = request.user.profile
        if profile.role == "superadmin":
            apps = AppDefinition.objects.filter(is_active=True).order_by("display_order")
        else:
            apps = profile.assigned_apps.filter(is_active=True).order_by("display_order")
        is_admin = profile.role in ("superadmin", "company_admin")
    except UserProfile.DoesNotExist:
        apps = AppDefinition.objects.none()
        is_admin = False

    sections = []
    for section_key in SECTION_ORDER:
        section_apps = [a for a in apps if a.section == section_key]
        if section_apps:
            sections.append({**SECTION_META[section_key], "apps": section_apps})

    return render(request, "app_hub.html", {"sections": sections, "is_admin": is_admin})


@login_required
def placeholder_app(request, app_name, section):
    """Generic 'Coming Soon' page for apps that are not built yet."""
    return render(request, "placeholder.html", {"app_name": app_name, "section": section})
