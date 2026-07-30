# flooring_partners_apps/urls.py
from django.conf import settings
from django.conf.urls.static import static
from django.contrib import admin
from django.contrib.auth import views as auth_views
from django.urls import include, path

from .views import app_hub, healthz, logout_view

urlpatterns = [
    # Landing page = login
    path(
        "",
        auth_views.LoginView.as_view(template_name="registration/login.html"),
        name="login",
    ),
    path("logout/", logout_view, name="logout"),

    # Health probe for Railway
    path("healthz/", healthz, name="healthz"),

    # App hub
    path("apps/", app_hub, name="app_hub"),

    # Org View — the real app (ported per 06-org-view-port-plan.md).
    # placeholder_app remains in views.py for future Coming Soon cards.
    path("org-view/", include("org_view.urls")),

    # Admin panel (custom accounts admin views)
    path("admin-panel/", include("accounts.urls")),

    # Django admin
    path("admin/", admin.site.urls),
] + static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)
