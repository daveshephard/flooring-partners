from decimal import Decimal

from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.test import TestCase

from accounts.models import CompanyProfile

from .models import (
    AppPermission, CensusSnapshot, Company, Employee, Scenario, ScenarioPosition,
)
from .services import scenarios as S
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


class ScenarioEngineTests(TestCase):
    """Cloning, structural edits, and the cost-impact summary."""

    def setUp(self):
        self.company = Company.objects.create(name="Flooring Partners", slug="flooring-partners")
        self.snap = CensusSnapshot.objects.create(
            company=self.company, original_filename="census.csv",
            status=CensusSnapshot.Status.ACTIVE, is_current=True, employee_count=4,
        )
        # CEO -> VP -> {IC1, IC2}
        rows = [
            ("E1", "Ada",  "Root",  None, "CEO",        "300000"),
            ("E2", "Bo",   "Vice",  "E1", "VP Ops",     "200000"),
            ("E3", "Cy",   "One",   "E2", "Technician", "100000"),
            ("E4", "Di",   "Two",   "E2", "Technician", "110000"),
        ]
        for eid, fn, ln, sup, title, salary in rows:
            Employee.objects.create(
                snapshot=self.snap, employee_id=eid, first_name=fn, last_name=ln,
                raw_supervisor_id=sup, job_title=title, annual_salary=Decimal(salary),
            )

    def _new_scenario(self):
        return S.create_scenario(company=self.company, base_snapshot=self.snap, name="Reorg")

    def test_create_clones_all_positions_with_baseline_cost(self):
        sc = self._new_scenario()
        self.assertEqual(sc.positions.count(), 4)
        vp = sc.positions.get(employee_id="E2")
        self.assertEqual(vp.source_employee_id, "E2")
        self.assertEqual(vp.change_type, ScenarioPosition.ChangeType.UNCHANGED)
        self.assertEqual(vp.baseline_cost, Decimal("200000"))

    def test_baseline_summary_matches_snapshot(self):
        sc = self._new_scenario()
        summ = S.scenario_summary(sc)
        self.assertEqual(summ["baseline"]["headcount"], 4)
        self.assertEqual(summ["baseline"]["total_cost"], Decimal("710000"))
        self.assertEqual(summ["baseline"]["layers"], 3)

    def test_eliminate_reparents_reports_and_books_savings(self):
        sc = self._new_scenario()
        S.eliminate_position(sc.positions.get(employee_id="E2"))
        # E3/E4 now report to E1 (the VP's manager)
        self.assertEqual(sc.positions.get(employee_id="E3").raw_supervisor_id, "E1")
        self.assertEqual(sc.positions.get(employee_id="E4").raw_supervisor_id, "E1")
        summ = S.scenario_summary(sc)
        self.assertEqual(summ["scenario"]["headcount"], 3)
        self.assertEqual(summ["totals"]["savings"], Decimal("200000"))
        self.assertEqual(summ["totals"]["net"], Decimal("-200000"))

    def test_add_position_books_investment(self):
        sc = self._new_scenario()
        S.add_position(sc, supervisor_id="E1", job_title="VP Finance",
                       annual_salary=Decimal("150000"), is_vacant=True)
        summ = S.scenario_summary(sc)
        self.assertEqual(summ["scenario"]["headcount"], 5)
        self.assertEqual(summ["totals"]["investment"], Decimal("150000"))
        self.assertEqual(summ["totals"]["net"], Decimal("150000"))

    def test_edit_pay_books_delta(self):
        sc = self._new_scenario()
        S.edit_position(sc.positions.get(employee_id="E3"), {"annual_salary": Decimal("120000")})
        summ = S.scenario_summary(sc)
        modified = [x for x in summ["ledger"] if x["change_type"] == ScenarioPosition.ChangeType.MODIFIED]
        self.assertEqual(len(modified), 1)
        self.assertEqual(modified[0]["cost_impact"], Decimal("20000"))

    def test_reassign_cycle_guard(self):
        sc = self._new_scenario()
        # E1 (CEO) cannot report to E3, which is in E1's subtree.
        with self.assertRaises(ValueError):
            S.reassign_manager(sc.positions.get(employee_id="E1"), "E3")

    def test_scenario_tree_excludes_eliminated(self):
        sc = self._new_scenario()
        S.eliminate_position(sc.positions.get(employee_id="E4"))
        tree = S.build_scenario_tree(sc)
        root = tree if isinstance(tree, dict) else tree[0]
        self.assertEqual(root["metrics"]["headcount"], 3)

    def test_added_then_eliminated_disappears(self):
        sc = self._new_scenario()
        pos = S.add_position(sc, supervisor_id="E1", job_title="Temp")
        result = S.eliminate_position(pos)
        self.assertIsNone(result)
        self.assertEqual(sc.positions.count(), 4)
