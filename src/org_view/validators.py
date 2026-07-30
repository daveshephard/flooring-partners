"""
Data-quality validation for census mapped rows.
"""


def validate_rows(mapped_rows: list[dict]) -> tuple[list[dict], list[dict]]:
    """
    Run all validation rules against mapped rows.

    Returns (errors, warnings).
    Each item is a dict:
        {
            "type":    str,         # machine key
            "label":   str,         # human label
            "message": str,         # summary sentence
            "rows":    list[int],   # 1-based row numbers affected
        }

    Errors block saving; warnings may be acknowledged.
    """
    errors: list[dict] = []
    warnings: list[dict] = []

    all_ids = [str(r.get("employee_id", "")).strip() for r in mapped_rows]

    # ── Errors ──────────────────────────────────────────────────────────────

    # Missing employee_id
    missing_id_rows = [r["_row_num"] for r in mapped_rows if not str(r.get("employee_id", "")).strip()]
    if missing_id_rows:
        errors.append({
            "type":    "missing_employee_id",
            "label":   "Missing Employee ID",
            "message": f"{len(missing_id_rows)} row(s) have no Employee ID.",
            "rows":    missing_id_rows,
        })

    # Duplicate employee_id
    valid_ids = [eid for eid in all_ids if eid]
    seen: set[str] = set()
    duplicate_ids: set[str] = set()
    for eid in valid_ids:
        if eid in seen:
            duplicate_ids.add(eid)
        seen.add(eid)
    if duplicate_ids:
        dup_rows = [r["_row_num"] for r in mapped_rows if str(r.get("employee_id", "")).strip() in duplicate_ids]
        sample = ", ".join(sorted(duplicate_ids)[:5])
        suffix = "…" if len(duplicate_ids) > 5 else ""
        errors.append({
            "type":    "duplicate_employee_id",
            "label":   "Duplicate Employee ID",
            "message": f"{len(duplicate_ids)} duplicate ID(s): {sample}{suffix}",
            "rows":    dup_rows,
        })

    # Orphaned supervisor_id (references an ID not in the file)
    emp_id_set = set(eid for eid in all_ids if eid)
    orphan_rows = [
        r["_row_num"] for r in mapped_rows
        if str(r.get("supervisor_id", "")).strip()
        and str(r["supervisor_id"]).strip() not in emp_id_set
    ]
    if orphan_rows:
        errors.append({
            "type":    "orphaned_supervisor",
            "label":   "Unknown Supervisor ID",
            "message": f"{len(orphan_rows)} row(s) reference a Supervisor ID not present in this file.",
            "rows":    orphan_rows,
        })

    # Self-referencing supervisor
    self_ref_rows = [
        r["_row_num"] for r in mapped_rows
        if str(r.get("supervisor_id", "")).strip()
        and str(r.get("employee_id", "")).strip()
        and str(r["supervisor_id"]).strip() == str(r["employee_id"]).strip()
    ]
    if self_ref_rows:
        errors.append({
            "type":    "self_referencing",
            "label":   "Self-Referencing Supervisor",
            "message": f"{len(self_ref_rows)} row(s) have Supervisor ID equal to their own Employee ID.",
            "rows":    self_ref_rows,
        })

    # ── Warnings ────────────────────────────────────────────────────────────

    # Multiple root nodes
    root_rows = [
        r for r in mapped_rows
        if not str(r.get("supervisor_id", "")).strip()
        and str(r.get("employee_id", "")).strip()
    ]
    if len(root_rows) > 1:
        warnings.append({
            "type":    "multiple_roots",
            "label":   "Multiple Root Nodes",
            "message": f"{len(root_rows)} employees have no Supervisor ID (multiple org roots detected).",
            "rows":    [r["_row_num"] for r in root_rows],
        })

    # Missing first or last name
    blank_name_rows = [
        r["_row_num"] for r in mapped_rows
        if not str(r.get("first_name", "")).strip() or not str(r.get("last_name", "")).strip()
    ]
    if blank_name_rows:
        warnings.append({
            "type":    "blank_name",
            "label":   "Missing Name",
            "message": f"{len(blank_name_rows)} row(s) are missing first or last name.",
            "rows":    blank_name_rows,
        })

    # Missing management_level
    blank_level_rows = [r["_row_num"] for r in mapped_rows if not str(r.get("management_level", "")).strip()]
    if blank_level_rows:
        warnings.append({
            "type":    "blank_management_level",
            "label":   "Missing Management Level",
            "message": f"{len(blank_level_rows)} row(s) have no Management Level (affects metric calculations).",
            "rows":    blank_level_rows,
        })

    # Missing overhead classification
    blank_overhead_rows = [r["_row_num"] for r in mapped_rows if not str(r.get("is_overhead", "")).strip()]
    if blank_overhead_rows:
        warnings.append({
            "type":    "blank_overhead",
            "label":   "Missing Overhead Classification",
            "message": f"{len(blank_overhead_rows)} row(s) have no Overhead flag (affects overhead % metric).",
            "rows":    blank_overhead_rows,
        })

    # Salaried employees missing salary
    blank_salary_rows = [
        r["_row_num"] for r in mapped_rows
        if not str(r.get("annual_salary", "")).strip()
        and str(r.get("pay_type", "")).strip().lower() in ("salaried", "salary", "exempt")
    ]
    if blank_salary_rows:
        warnings.append({
            "type":    "blank_salary",
            "label":   "Missing Salary for Salaried Employee",
            "message": f"{len(blank_salary_rows)} salaried employee(s) have no Annual Salary.",
            "rows":    blank_salary_rows,
        })

    return errors, warnings
