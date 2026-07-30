"""Merge a duplicate org_view.Company into another, preserving its data.

Duplicates can arise when the same real company exists in OrgView under two
different names/slugs (e.g. "Omega" vs "Omega Fitness") — the company-sync matches
by slug and has no stable link back to accounts.CompanyProfile, so it can't tell
they're the same and leaves both. This tool reconciles them safely.

    python manage.py merge_org_view_companies --list
    python manage.py merge_org_view_companies --from <dup_id> --into <keep_id> [--dry-run]

The merge moves census snapshots and permissions from ``--from`` to ``--into``
(dropping only permissions that would duplicate one the keeper already has), keeps a
single ``is_current`` snapshot, then deletes the ``--from`` company. Run ``--list``
first to see ids + snapshot/permission counts. Deleting a company cascades to its
snapshots/permissions, so always merge (or verify the row is empty) — don't just
delete a row that still holds data.
"""
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from org_view.models import AppPermission, CensusSnapshot, Company


class Command(BaseCommand):
    help = "Merge a duplicate org_view.Company into another (moves snapshots + permissions)."

    def add_arguments(self, parser):
        parser.add_argument("--list", action="store_true",
                            help="List all companies with snapshot/permission counts.")
        parser.add_argument("--from", dest="from_id", type=int,
                            help="Id of the duplicate company to remove.")
        parser.add_argument("--into", dest="into_id", type=int,
                            help="Id of the canonical company to keep.")
        parser.add_argument("--dry-run", action="store_true",
                            help="Show the plan without making changes.")

    def handle(self, *args, **opts):
        if opts["list"] or not (opts["from_id"] and opts["into_id"]):
            self._list()
            if not (opts["from_id"] and opts["into_id"]):
                self.stdout.write("\nTo merge: --from <dup_id> --into <keep_id> [--dry-run]")
                return

        try:
            src = Company.objects.get(pk=opts["from_id"])
            dst = Company.objects.get(pk=opts["into_id"])
        except Company.DoesNotExist as exc:
            raise CommandError(f"Company not found: {exc}")
        if src.pk == dst.pk:
            raise CommandError("--from and --into must be different companies.")

        snaps = CensusSnapshot.objects.filter(company=src)
        perms = list(AppPermission.objects.filter(company=src))
        dst_users = set(
            AppPermission.objects.filter(company=dst).values_list("user_id", flat=True)
        )
        move_perms = [p for p in perms if p.user_id not in dst_users]
        drop_perms = [p for p in perms if p.user_id in dst_users]

        self.stdout.write(
            f"Merge '{src.name}' (#{src.pk}, slug={src.slug}) "
            f"-> '{dst.name}' (#{dst.pk}, slug={dst.slug}):"
        )
        self.stdout.write(
            f"  move {snaps.count()} snapshot(s), {len(move_perms)} permission(s); "
            f"drop {len(drop_perms)} duplicate permission(s); delete company #{src.pk}"
        )

        if opts["dry_run"]:
            self.stdout.write(self.style.WARNING("DRY RUN - no changes made."))
            return

        with transaction.atomic():
            snaps.update(company=dst)
            for p in move_perms:
                p.company = dst
                p.save(update_fields=["company"])
            for p in drop_perms:
                p.delete()
            # Keep only the most recent is_current snapshot on the keeper.
            currents = list(
                CensusSnapshot.objects.filter(company=dst, is_current=True)
                .order_by("-effective_date", "-upload_date")
            )
            for extra in currents[1:]:
                extra.is_current = False
                extra.save(update_fields=["is_current"])
            src.delete()

        self.stdout.write(self.style.SUCCESS(
            f"Merged '{src.name}' into '{dst.name}' and deleted company #{opts['from_id']}."))

    def _list(self):
        self.stdout.write("OrgView companies:")
        self.stdout.write(f"  {'id':<5} {'snaps':<6} {'perms':<6} {'active':<7} slug / name")
        for c in Company.objects.all().order_by("name"):
            ns = CensusSnapshot.objects.filter(company=c).count()
            npn = AppPermission.objects.filter(company=c).count()
            self.stdout.write(
                f"  {c.pk:<5} {ns:<6} {npn:<6} {str(c.is_active):<7} {c.slug}  ({c.name})")
