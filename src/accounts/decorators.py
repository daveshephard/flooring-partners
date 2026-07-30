from functools import wraps

from django.contrib import messages
from django.shortcuts import redirect


def app_access_required(app_slug):
    def decorator(view_func):
        @wraps(view_func)
        def wrapper(request, *args, **kwargs):
            if not request.user.is_authenticated:
                return redirect("login")
            # Django superusers always have full access
            if request.user.is_superuser or request.user.is_staff:
                return view_func(request, *args, **kwargs)
            try:
                profile = request.user.profile
                if profile.role == "superadmin":
                    return view_func(request, *args, **kwargs)
                if profile.assigned_apps.filter(slug=app_slug, is_active=True).exists():
                    return view_func(request, *args, **kwargs)
            except Exception:
                pass
            messages.error(
                request,
                "You don't have access to that application. Contact your administrator.",
            )
            return redirect("app_hub")
        return wrapper
    return decorator
