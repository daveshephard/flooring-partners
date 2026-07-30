from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.test import TestCase

from accounts.models import CompanyProfile

from .models import AppPermission, CensusSnapshot, Company
from .services.company_sync import ensure_org_view_company, sync_from_accounts


class CompanySyncTests(TestCase):
    def test_ensure_creates_missing_company(self):
        company, created = ensure_org_view_company("Flooring Partners")
        self.assertTrue(created)
        self.assertEqual(company.name, "Flooring Partners")
        self.assertEqual(company.slug, "flooring-partners")
        self.assertTrue(company.is_active)

    def test_ensure_is_idempotent(self):
        ensure_org_view_company("Flooring Partners")
        company, created = ensure_org_view_company("Flooring Partners")
        self.assertFalse(created)
        self.assertEqual(Company.objects.filter(slug="flooring-partners").count(), 1)

    def test_ensure_ignores_blank(self):
        company, created = ensure_org_view_company("   ")
        self.assertIsNone(company)
        self.assertFalse(created)

    def test_sync_from_accounts_backfills_active_only(self):
        CompanyProfile.objects.create(name="Flooring Partners", is_active=True)
        CompanyProfile.objects.create(name="Dormant Co", is_active=False)
        # Simulate the pre-signal state (rows added before the sync existed).
        Company.objects.all().delete()
        created, existing = sync_from_accounts()
        self.assertIn("Flooring Partners", created)
        self.assertNotIn("Dormant Co", created)
        self.assertTrue(Company.objects.filter(slug="flooring-partners").exists())
        self.assertFalse(Company.objects.filter(slug="dormant-co").exists())

    def test_sync_dry_run_writes_nothing(self):
        CompanyProfile.objects.create(name="Flooring Partners", is_active=True)
        Company.objects.all().delete()  # pre-signal state
        created, existing = sync_from_accounts(dry_run=True)
        self.assertIn("Flooring Partners", created)
        self.assertFalse(Company.objects.filter(slug="flooring-partners").exists())

    def test_signal_creates_company_on_profile_save(self):
        CompanyProfile.objects.create(name="Signal Co", is_active=True)
        self.assertTrue(Company.objects.filter(slug="signal-co").exists())


class MergeCompaniesTests(TestCase):
    def setUp(self):
        User = get_user_model()
        self.u1 = User.objects.create_user("u1")
        self.u2 = User.objects.create_user("u2")
        self.dup = Company.objects.create(name="Omega", slug="omega")
        self.keep = Company.objects.create(name="Omega Fitness", slug="omega-fitness")

    def test_merge_moves_snapshots_and_deletes_dup(self):
        snap = CensusSnapshot.objects.create(
            company=self.dup, original_filename="c.csv", status=CensusSnapshot.Status.ACTIVE,
        )
        AppPermission.objects.create(user=self.u1, company=self.dup, role="admin")
        call_command("merge_org_view_companies", **{"from_id": self.dup.pk, "into_id": self.keep.pk})

        self.assertFalse(Company.objects.filter(pk=self.dup.pk).exists())
        snap.refresh_from_db()
        self.assertEqual(snap.company_id, self.keep.pk)
        self.assertTrue(AppPermission.objects.filter(user=self.u1, company=self.keep).exists())

    def test_merge_drops_conflicting_permission(self):
        # Both companies grant u1 — the keeper's must survive, the dup's is dropped.
        AppPermission.objects.create(user=self.u1, company=self.dup, role="viewer")
        AppPermission.objects.create(user=self.u1, company=self.keep, role="admin")
        AppPermission.objects.create(user=self.u2, company=self.dup, role="viewer")
        call_command("merge_org_view_companies", **{"from_id": self.dup.pk, "into_id": self.keep.pk})

        self.assertEqual(AppPermission.objects.filter(user=self.u1, company=self.keep).count(), 1)
        self.assertEqual(
            AppPermission.objects.get(user=self.u1, company=self.keep).role, "admin")
        self.assertTrue(AppPermission.objects.filter(user=self.u2, company=self.keep).exists())

    def test_dry_run_changes_nothing(self):
        CensusSnapshot.objects.create(company=self.dup, original_filename="c.csv")
        call_command("merge_org_view_companies",
                     **{"from_id": self.dup.pk, "into_id": self.keep.pk, "dry_run": True})
        self.assertTrue(Company.objects.filter(pk=self.dup.pk).exists())
        self.assertEqual(CensusSnapshot.objects.filter(company=self.dup).count(), 1)
