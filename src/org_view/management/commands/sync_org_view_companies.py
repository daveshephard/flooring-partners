"""Backfill OrgView companies from active accounts.CompanyProfile records.

    python manage.py sync_org_view_companies [--dry-run]

Idempotent: creates an ``org_view.Company`` for any active ``CompanyProfile`` that
doesn't already have one, and leaves existing rows untouched. Going forward this
happens automatically via the ``post_save`` signal (see org_view/signals.py); this
command is the manual backfill / audit tool.
"""
from django.core.management.base import BaseCommand

from org_view.services.company_sync import sync_from_accounts


class Command(BaseCommand):
    help = "Create org_view.Company rows for active accounts.CompanyProfile records missing one."

    def add_arguments(self, parser):
        parser.add_argument("--dry-run", action="store_true",
                            help="Report what would be created without writing.")

    def handle(self, *args, **opts):
        dry = opts["dry_run"]
        created, existing = sync_from_accounts(dry_run=dry)
        for name in created:
            self.stdout.write(f"  + {name}")
        verb = "Would create" if dry else "Created"
        self.stdout.write(self.style.SUCCESS(
            f"{verb} {len(created)} company(ies); {len(existing)} already present."))
