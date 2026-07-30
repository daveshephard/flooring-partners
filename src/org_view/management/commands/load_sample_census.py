"""
Management command to load a census file for quick testing.

Usage:
    python manage.py load_sample_census --file path/to/census.xlsx
    python manage.py load_sample_census --file data.csv --company "Acme Corp"
"""
from django.core.management.base import BaseCommand, CommandError
from django.utils.text import slugify

from org_view.models import CensusSnapshot, Company, Employee
from org_view.parsers import apply_mapping, auto_map_columns, parse_file


class Command(BaseCommand):
    help = "Load a census CSV/XLSX file into OrgView for testing."

    def add_arguments(self, parser):
        parser.add_argument("--file", required=True, help="Path to the census file (.csv or .xlsx)")
        parser.add_argument("--company", default="Flooring Partners", help="Company name (created if missing)")
        parser.add_argument("--label", default="", help="Optional snapshot label (e.g. 'Q4 2025')")

    def handle(self, *args, **options):
        filepath = options["file"]
        company_name = options["company"]
        label = options["label"]

        # Parse file
        self.stdout.write(f"Parsing {filepath} …")
        with open(filepath, "rb") as f:
            headers, rows = parse_file(f, filepath)

        if not rows:
            raise CommandError("File is empty or could not be parsed.")

        self.stdout.write(f"  {len(rows)} rows, {len(headers)} columns")

        # Auto-map columns
        mapping = auto_map_columns(headers)
        mapped_count = sum(1 for v in mapping.values() if v)
        self.stdout.write(f"  Auto-mapped {mapped_count}/{len(mapping)} standard fields")

        unmapped_required = [f for f in ("employee_id", "first_name", "last_name", "supervisor_id", "job_title", "entity")
                            if not mapping.get(f)]
        if unmapped_required:
            self.stdout.write(self.style.WARNING(f"  Unmapped required fields: {', '.join(unmapped_required)}"))

        # Apply mapping
        mapped_rows = apply_mapping(rows, mapping)

        # Get or create company
        slug = slugify(company_name)[:50]
        company, created = Company.objects.get_or_create(slug=slug, defaults={"name": company_name})
        if created:
            self.stdout.write(f"  Created company: {company_name}")
        else:
            self.stdout.write(f"  Using existing company: {company_name}")

        # Create snapshot
        snapshot = CensusSnapshot.objects.create(
            company=company,
            label=label,
            original_filename=filepath.split("/")[-1].split("\\")[-1],
            file="",
            status=CensusSnapshot.Status.PROCESSING,
            column_mapping=mapping,
        )

        # Build Employee objects
        from org_view.views import _row_to_employee_kwargs

        employees = [Employee(**_row_to_employee_kwargs(row, snapshot)) for row in mapped_rows]
        Employee.objects.bulk_create(employees, ignore_conflicts=True)

        # Resolve supervisor tree
        all_emps = list(Employee.objects.filter(snapshot=snapshot))
        lookup = {e.employee_id: e for e in all_emps}
        updates = []
        for emp in all_emps:
            if emp.raw_supervisor_id and emp.raw_supervisor_id in lookup:
                emp.supervisor = lookup[emp.raw_supervisor_id]
                updates.append(emp)
        if updates:
            Employee.objects.bulk_update(updates, ["supervisor"], batch_size=500)

        # Identify roots and depth
        roots = [e for e in all_emps if not e.raw_supervisor_id]
        children_map = {}
        for e in all_emps:
            if e.raw_supervisor_id:
                children_map.setdefault(e.raw_supervisor_id, []).append(e.employee_id)

        def _depth(eid, seen=None):
            if seen is None:
                seen = set()
            if eid in seen:
                return 0
            seen.add(eid)
            kids = children_map.get(eid, [])
            return 1 + max((_depth(k, seen) for k in kids), default=0) if kids else 1

        max_depth = max((_depth(r.employee_id) for r in roots), default=0) if roots else 0

        # Finalize
        snapshot.employee_count = len(all_emps)
        snapshot.status = CensusSnapshot.Status.ACTIVE
        snapshot.save(update_fields=["employee_count", "status"])

        self.stdout.write(self.style.SUCCESS(
            f"\nDone! Snapshot #{snapshot.id}\n"
            f"  Employees: {len(all_emps)}\n"
            f"  Root nodes: {len(roots)}\n"
            f"  Max tree depth: {max_depth}\n"
            f"  Supervisor links resolved: {len(updates)}"
        ))
