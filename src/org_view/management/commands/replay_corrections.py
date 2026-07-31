"""Re-apply saved structural corrections to a census snapshot.

For backfilling after the corrections layer landed, and for debugging a conflict
without having to re-upload a census.

    python manage.py replay_corrections --company "Flooring Partners" [--snapshot <id>] [--dry-run]
"""
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.db.models import Q

from org_view.models import CensusSnapshot, Company, StructureCorrection
from org_view.services import corrections as corrections_svc


class Command(BaseCommand):
    help = "Re-apply a company's active structural corrections to a census snapshot."

    def add_arguments(self, parser):
        parser.add_argument(
            "--company", required=True,
            help="Company name (or slug), matching load_sample_census / sync_org_view_companies.",
        )
        parser.add_argument("--snapshot", type=int, default=None,
                            help="Snapshot id. Defaults to the company's current snapshot.")
        parser.add_argument("--dry-run", action="store_true",
                            help="Resolve and report; write nothing.")

    def handle(self, *args, **options):
        name = options["company"]
        company = Company.objects.filter(Q(name__iexact=name) | Q(slug__iexact=name)).first()
        if not company:
            raise CommandError(f"No company matching '{name}'.")

        if options["snapshot"]:
            snap = CensusSnapshot.objects.filter(
                id=options["snapshot"], company=company,
            ).first()
        else:
            snap = (
                CensusSnapshot.objects.filter(
                    company=company, status=CensusSnapshot.Status.ACTIVE, is_current=True,
                ).first()
                or CensusSnapshot.objects.filter(
                    company=company, status=CensusSnapshot.Status.ACTIVE,
                ).order_by("-effective_date", "-upload_date").first()
            )
        if not snap:
            raise CommandError(f"{company.name} has no snapshot to replay onto.")

        active = StructureCorrection.objects.filter(company=company, is_active=True).count()
        self.stdout.write(f"{company.name} — snapshot {snap.id} ({snap}) — {active} active correction(s)")
        if not active:
            return

        if options["dry_run"]:
            self._dry_run(snap)
            return

        log = corrections_svc.replay_corrections(snap)
        self._table(log.detail)
        self.stdout.write(self.style.SUCCESS(
            f"{log.applied_count} applied · {log.drifted_count} drifted · "
            f"{log.stale_count} stale · {log.conflict_count} conflict"
        ))

    def _dry_run(self, snap):
        """Apply inside a transaction we roll back, so the report is real."""
        rows = []
        try:
            with transaction.atomic():
                log = corrections_svc.replay_corrections(snap)
                rows = list(log.detail)
                summary = (log.applied_count, log.drifted_count, log.stale_count, log.conflict_count)
                raise _Rollback()
        except _Rollback:
            pass
        self._table(rows)
        self.stdout.write(self.style.WARNING(
            f"DRY RUN — nothing written. {summary[0]} applied · {summary[1]} drifted · "
            f"{summary[2]} stale · {summary[3]} conflict"
        ))

    def _table(self, rows):
        if not rows:
            self.stdout.write("  (nothing to report)")
            return
        self.stdout.write(f"  {'employee_id':<14} {'kind':<11} {'status':<10} detail")
        self.stdout.write(f"  {'-' * 14} {'-' * 11} {'-' * 10} {'-' * 40}")
        for r in rows:
            self.stdout.write(
                f"  {r['employee_id']:<14} {r['kind']:<11} {r['status']:<10} {r.get('detail', '')}"
            )


class _Rollback(Exception):
    """Internal — unwinds the dry-run transaction."""
