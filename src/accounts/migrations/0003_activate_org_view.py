from django.db import migrations


def activate_org_view(apps, schema_editor):
    """Point the Org View tile at the real app and mark it available.

    The slug stays "org-view" — org_view.views guards every view with
    @app_access_required("org-view"), which matches on AppDefinition.slug.
    """
    AppDefinition = apps.get_model("accounts", "AppDefinition")
    AppDefinition.objects.filter(slug="org-view").update(
        url_name="org_view:index",
        status="available",
    )


def deactivate_org_view(apps, schema_editor):
    """Revert to the placeholder route + Coming Soon status."""
    AppDefinition = apps.get_model("accounts", "AppDefinition")
    AppDefinition.objects.filter(slug="org-view").update(
        url_name="org_view_placeholder",
        status="coming_soon",
    )


class Migration(migrations.Migration):

    dependencies = [
        ("accounts", "0002_seed_app_definitions"),
    ]

    operations = [
        migrations.RunPython(activate_org_view, deactivate_org_view),
    ]
