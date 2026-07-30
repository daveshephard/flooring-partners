from django.apps import AppConfig


class OrgViewConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'org_view'

    def ready(self):
        # Wire the CompanyProfile -> org_view.Company auto-sync signal.
        from . import signals  # noqa: F401
