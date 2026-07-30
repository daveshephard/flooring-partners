"""
Census file parsing and column auto-mapping for OrgView.
"""
import csv
import io
import re

import openpyxl

# ---------------------------------------------------------------------------
# Standard field registry
# (field_name, display_label, category)
# ---------------------------------------------------------------------------

STANDARD_FIELDS = [
    ("employee_id",         "Employee ID",           "required"),
    ("first_name",          "First Name",            "required"),
    ("last_name",           "Last Name",             "required"),
    ("supervisor_id",       "Supervisor ID",         "required"),
    ("job_title",           "Job Title",             "required"),
    ("entity",              "Entity",                "required"),
    ("management_level",    "Management Level",      "recommended"),
    ("department",          "Department",            "recommended"),
    ("employee_status",     "Employee Status",       "recommended"),
    ("employee_type",       "Employee Type",         "recommended"),
    ("pay_type",            "Pay Type",              "recommended"),
    ("annual_salary",       "Annual Salary",         "recommended"),
    ("site_location",       "Site Location",         "optional"),
    ("city",                "City",                  "optional"),
    ("state",               "State",                 "optional"),
    ("fully_loaded_cost",   "Fully Loaded Cost",     "optional"),
    ("is_overhead",         "Is Overhead",           "optional"),
    ("hire_date",           "Hire Date",             "optional"),
    ("revenue_attribution", "Revenue Attribution",   "optional"),
    ("cost_center",         "Cost Center",           "optional"),
    ("union_affiliation",   "Union Affiliation",     "optional"),
    ("flsa_status",         "FLSA Status",           "optional"),
]

REQUIRED_FIELDS     = [f for f, _, cat in STANDARD_FIELDS if cat == "required"]
RECOMMENDED_FIELDS  = [f for f, _, cat in STANDARD_FIELDS if cat == "recommended"]
OPTIONAL_FIELDS     = [f for f, _, cat in STANDARD_FIELDS if cat == "optional"]
ALL_STANDARD_FIELDS = [f for f, _, _ in STANDARD_FIELDS]

COLUMN_ALIASES = {
    "employee_id":         ["badge", "emp_id", "employee id", "employee_id", "id",
                            "employee number", "emp #", "emp no"],
    "first_name":          ["first name", "first_name", "fname", "given name"],
    "last_name":           ["last name", "last_name", "lname", "surname", "family name"],
    "supervisor_id":       ["supervisor", "supervisor id", "manager id", "reports to",
                            "supervisor name", "supervisor_id"],
    "job_title":           ["title", "job title", "job_title", "position",
                            "jobs (hr)(1)", "jobs (hr)"],
    "management_level":    ["level", "management level", "role simplified", "role",
                            "job level", "grade"],
    "department":          ["department", "dept", "division",
                            "labor levels(site / department)", "site / department"],
    "entity":              ["entity", "subsidiary", "legal entity", "labor levels(company)"],
    "site_location":       ["site", "location", "office", "building"],
    "city":                ["city", "work city"],
    "state":               ["state", "province", "unemployment state/province",
                            "labor levels(state)"],
    "employee_status":     ["status", "employee status", "emp status", "employment status"],
    "employee_type":       ["employee type", "emp type", "worker type", "employment type"],
    "pay_type":            ["pay type", "pay_type", "compensation type", "salary type"],
    "annual_salary":       ["salary", "annual salary", "annualized pay", "base salary",
                            "annual pay"],
    "fully_loaded_cost":   ["fully loaded", "loaded cost", "total cost", "burdened cost"],
    "is_overhead":         ["overhead", "is overhead", "overhead classification"],
    "hire_date":           ["hire date", "date seniority", "start date", "seniority date",
                            "date of hire"],
    "revenue_attribution": ["revenue", "revenue attribution", "revenue managed"],
    "cost_center":         ["cost center", "cost_center", "cc"],
    "union_affiliation":   ["union", "employee union", "union affiliation", "labor union"],
    "flsa_status":         ["flsa", "flsa status", "exempt status"],
}

# Matches "FIRST LAST (ENTITY NAME) (12345)" — extracts badge number at end
SUPERVISOR_BADGE_RE = re.compile(r'\((\d+)\)\s*$')


# ---------------------------------------------------------------------------
# Supervisor ID extraction
# ---------------------------------------------------------------------------

def extract_supervisor_id(value: str) -> str:
    """
    Normalise a supervisor reference to a bare ID string.

    Handles payroll exports that embed the badge number as the last
    parenthesised group, e.g. "OLGA CASTRO (SOME ENTITY, LLC) (34381)" -> "34381".
    A value that is already a bare ID is returned unchanged.
    """
    if not value:
        return ""
    stripped = str(value).strip()
    match = SUPERVISOR_BADGE_RE.search(stripped)
    if match:
        return match.group(1)
    # Already a bare numeric or alphanumeric ID
    return stripped


# ---------------------------------------------------------------------------
# File parsing
# ---------------------------------------------------------------------------

def parse_file(file_obj, filename: str) -> tuple[list[str], list[dict]]:
    """Parse a CSV or XLSX file. Returns (headers, rows)."""
    if filename.lower().endswith((".xlsx", ".xls")):
        return _parse_excel(file_obj)
    return _parse_csv(file_obj)


def _parse_excel(file_obj) -> tuple[list[str], list[dict]]:
    wb = openpyxl.load_workbook(file_obj, read_only=True, data_only=True)
    ws = wb.active
    rows_iter = ws.iter_rows(values_only=True)
    raw_headers = next(rows_iter, None)
    if raw_headers is None:
        return [], []
    headers = [str(h).strip() if h is not None else "" for h in raw_headers]
    rows = []
    for raw_row in rows_iter:
        row_dict = {
            headers[i]: (str(v).strip() if v is not None else "")
            for i, v in enumerate(raw_row)
            if i < len(headers)
        }
        if any(v for v in row_dict.values()):
            rows.append(row_dict)
    return headers, rows


def _parse_csv(file_obj) -> tuple[list[str], list[dict]]:
    if hasattr(file_obj, "read"):
        content = file_obj.read()
        if isinstance(content, bytes):
            content = content.decode("utf-8-sig")
    else:
        content = str(file_obj)
    reader = csv.DictReader(io.StringIO(content))
    headers = list(reader.fieldnames or [])
    rows = [
        dict(row) for row in reader
        if any(str(v).strip() for v in row.values())
    ]
    return headers, rows


# ---------------------------------------------------------------------------
# Column auto-mapping
# ---------------------------------------------------------------------------

def auto_map_columns(headers: list[str]) -> dict[str, str | None]:
    """
    Returns {standard_field: original_col_name_or_None}.
    Matches on lowercased column names against COLUMN_ALIASES.
    """
    lower_to_original = {h.lower().strip(): h for h in headers}
    mapping: dict[str, str | None] = {}
    for std_field, aliases in COLUMN_ALIASES.items():
        mapped = None
        for alias in aliases:
            if alias in lower_to_original:
                mapped = lower_to_original[alias]
                break
        mapping[std_field] = mapped
    return mapping


# ---------------------------------------------------------------------------
# Apply mapping
# ---------------------------------------------------------------------------

def apply_mapping(rows: list[dict], mapping: dict[str, str | None]) -> list[dict]:
    """
    Convert raw rows (keyed by original column names) to rows keyed by
    standard field names.  Each output row also has '_row_num' (1-based).
    """
    mapped_rows = []
    for i, row in enumerate(rows):
        mapped: dict = {"_row_num": i + 1}
        for std_field, orig_col in mapping.items():
            if orig_col and orig_col in row:
                val = str(row[orig_col]).strip() if row[orig_col] is not None else ""
                if std_field == "supervisor_id":
                    val = extract_supervisor_id(val)
                mapped[std_field] = val
            else:
                mapped[std_field] = ""
        # Skip rows where every mapped field is blank (trailing empty rows)
        if any(v for k, v in mapped.items() if k != "_row_num"):
            mapped_rows.append(mapped)
    return mapped_rows
