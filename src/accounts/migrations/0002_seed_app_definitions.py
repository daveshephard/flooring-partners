from django.db import migrations


def seed_apps(apps, schema_editor):
    AppDefinition = apps.get_model("accounts", "AppDefinition")

    AppDefinition.objects.update_or_create(
        slug="org-view",
        defaults={
            "name": "Org View",
            "description": (
                "Upload an employee census and explore the Flooring Partners "
                "organization chart, headcount, and cost structure."
            ),
            "url_name": "org_view_placeholder",
            "section": "business_performance",
            "section_description": "Dashboards, KPIs, and operational reporting.",
            "status": "coming_soon",
            "is_active": True,
            "display_order": 10,
        },
    )


def unseed_apps(apps, schema_editor):
    AppDefinition = apps.get_model("accounts", "AppDefinition")
    AppDefinition.objects.filter(slug="org-view").delete()


class Migration(migrations.Migration):

    dependencies = [
        ("accounts", "0001_initial"),
    ]

    operations = [
        migrations.RunPython(seed_apps, unseed_apps),
    ]
