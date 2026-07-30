# Phase 6 — Org View port plan

> **Do not execute this in the launch session.** This is the forward plan, written now while the
> source app is fresh in view, so the next session starts from a decision list rather than a
> discovery exercise. Phases 1–5 must be green first.

---

## What we're porting

**Source:** `C:\Users\DaveShephard\Dev\portfolio operations\src\org_view\`
mounted at `/org-view/` in the `rainier_apps` deployment.

**Not** `kleen-tech-apps/src/org_design/`. That is a different product — a geospatial
field/territory design tool built on H3 hex binning, route clustering, and geocoding. It shares
nothing with Org View beyond the theme. Don't get them confused; the names are close and the code
is not.

### What Org View actually does

An HR-census → org-chart viewer. The flow is:

1. Upload a CSV or XLSX employee census
2. Auto-map the file's column headers to a standard field registry (with manual override)
3. Review a data-quality report (orphaned supervisors, missing required fields, etc.)
4. Bulk-edit problem rows in the browser
5. Save as a **CensusSnapshot** — a point-in-time, dated version of the org
6. Explore the resulting org chart, headcount rollups, spans/layers, and cost structure
7. Compare snapshots over time on a trends page

### Size and shape

| Component | Lines | Notes |
|---|---|---|
| `models.py` | 137 | 4 models — the whole data model, small and clean |
| `views.py` | 796 | UI views + the upload wizard + save logic |
| `api.py` | 448 | JSON endpoints the front end calls |
| `parsers.py` | 194 | CSV/XLSX parsing + column auto-mapping |
| `validators.py` | 150 | Data-quality checks |
| `services/tree_builder.py` | 301 | Builds the org tree from flat employee rows |
| `services/company_sync.py` | 59 | Keeps `org_view.Company` in step with `accounts.CompanyProfile` |
| `templates/org_view/*.html` | 4,305 | 11 templates; `company_detail.html` alone is 1,700 lines |
| `management/commands/` | 3 files | `load_sample_census`, `sync_org_view_companies`, `merge_org_view_companies` |
| migrations | 6 | Two of them are data migrations that read `accounts.CompanyProfile` |
| `signals.py`, `admin.py`, `apps.py`, `urls.py`, `tests.py` | small | `apps.py` `ready()` wires the signal, so the app must be registered as plain `"org_view"` |
| `templatetags/org_view_tags.py` | 11 | Easy to miss in a copy — it's a real package directory and templates load it |
| `validators.py`, `parsers.py`, `services/` | — | Listed above; note `services/` is a package with `__init__.py` |

### Dependencies — this is the good news

The only third-party Python import in the entire app is **`openpyxl`**, which is already pinned in
`requirements.txt` (Phase 1, Step 10). No new packages, no new system libraries, no change to the
Dockerfile.

Front-end libraries are loaded from CDN, not bundled:

```
https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js
https://cdn.jsdelivr.net/npm/chartjs-plugin-datalabels@2.2.0/dist/chartjs-plugin-datalabels.min.js
```

The org chart itself is **hand-rolled** — no OrgChart.js, no D3. That's a mixed blessing: nothing
to install, but 1,700 lines of bespoke template to maintain.

---

## Data model summary

```
Company (name, slug, description, is_active)
  └── CensusSnapshot (label, effective_date, is_current, original_filename,
                      file, employee_count, warnings_count, column_mapping,
                      status[processing|active|archived], notes, uploaded_by)
        └── Employee (employee_id, first_name, last_name,
                      raw_supervisor_id, supervisor→self,
                      job_title, management_level, department,
                      site_location, city, state,
                      employee_status, employee_type, pay_type,
                      annual_salary, fully_loaded_cost, is_overhead,
                      hire_date, revenue_attribution, cost_center,
                      entity, union_affiliation, flsa_status, raw_data)
  └── AppPermission (user, company, role[admin|viewer], branch_root_employee_id)
```

`CensusSnapshot.save()` enforces one `is_current=True` per company.
`Employee` has `unique_together = ("snapshot", "employee_id")` — so each snapshot is a full,
self-contained copy of the org, not a delta.

### Census file schema

`parsers.py` defines the field registry. **Required** columns (the upload will not save without
these mapped):

| Field | Display label |
|---|---|
| `employee_id` | Employee ID |
| `first_name` | First Name |
| `last_name` | Last Name |
| `supervisor_id` | Supervisor ID |
| `job_title` | Job Title |
| `entity` | Entity |

**Recommended:** Management Level, Department, Employee Status, Employee Type, Pay Type, Annual Salary.
**Optional:** Site Location, City, State, Fully Loaded Cost, Is Overhead, Hire Date,
Revenue Attribution, Cost Center, Union Affiliation, FLSA Status.

Auto-mapping matches lowercased headers against a `COLUMN_ALIASES` dict. **Several aliases are
Kleen-Tech-specific and should be reviewed against a real Flooring Partners export:**

```python
"job_title":       [..., "jobs (hr)(1)", "jobs (hr)"]
"department":      [..., "labor levels(site / department)", "site / department"]
"entity":          [..., "labor levels(company)"]
"state":           [..., "unemployment state/province", "labor levels(state)"]
```

Those `labor levels(...)` headers come from a specific payroll export format. Add Flooring Partners'
actual header names as aliases rather than removing the existing ones — extra aliases are harmless.

There's also a Kleen-Tech-shaped supervisor parser:

```python
SUPERVISOR_BADGE_RE = re.compile(r'\((\d+)\)\s*$')
# Handles "OLGA CASTRO (KLEEN - TECH SERVICES, LLC) (34381)" -> "34381"
```

If Flooring Partners' census puts a bare supervisor ID in that column, this is a harmless no-op.
If it uses a different embedded format, `extract_supervisor_id()` needs adjusting. **Get a real
census file before writing any of this — do not guess the format.**

---

## Decisions to make before porting

These are the reasons this is a separate session rather than a copy-paste.

### D1. Keep or drop the multi-tenant `Company` layer?

Org View has its own `Company` table, separate from `accounts.CompanyProfile`, kept in sync by
`services/company_sync.py` plus a `post_save` signal. URLs are `/org-view/c/<slug>/`, and the
index page is a company picker.

- **Keep it** (recommended for the first port): zero code change, lowest risk. The picker just shows
  one entry, "Flooring Partners". If a second entity ever needs separating, it already works.
- **Drop it**: collapse to a single implicit company, remove the picker, change URLs to
  `/org-view/` and `/org-view/trends/`. Touches `models.py`, `urls.py`, `views.py`, `api.py`, and
  most templates. Meaningful work for a cosmetic gain.

Given the decision to consolidate Flooring Partners and SCI into one entity, "keep it" costs
almost nothing.

### D2. Keep or drop `AppPermission` and the permissions admin UI?

Five views, three templates, and a model exist to grant per-user, per-company, optionally
branch-scoped access — including `branch_root_employee_id`, which limits a user to one subtree of
the org chart.

- If Org View users are just you and a couple of Rainier people, the `accounts` app's
  `assigned_apps` gating is already sufficient and `AppPermission` is dead weight.
- If Flooring Partners managers will log in and should each see only their own branch, this is the
  feature that does that, and it's already built.

**Decide based on who logs in.** Don't port machinery for a use case that doesn't exist.

### D3. Anonymization

Employee names and salaries are in the model. Kleen-Tech's `org_design` app has a whole instruction
doc for this (`instructions/org-design/16-anonymize-pii-names-and-pay.md`). Org View has no
equivalent — it shows real names and real pay to anyone with access.

Decide before real data lands: does Flooring Partners' census get uploaded with names and salary
intact, and is per-user access control (D2) sufficient to protect it? This is the highest-stakes
question in the port and worth answering deliberately.

### D4. Does Org View need the trends page in v1?

`trends.html` (386 lines) + `api_trends` compare snapshots over time. With one snapshot it shows
nothing useful. Consider shipping without it and adding it once there are two or three quarters of
census data. Reduces the initial port surface by ~15%.

---

## Port sequence (draft — refine next session)

1. **Get a real Flooring Partners census file first.** Everything about the parser configuration
   depends on it. Don't start the port without one.
2. Create the S3 bucket `flooringpartners-media` (region `us-west-2` to match), block all public
   access, signed URLs only. Create a dedicated IAM user scoped to just that bucket. Add
   `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_STORAGE_BUCKET_NAME=flooringpartners-media`,
   `AWS_S3_REGION_NAME=us-west-2` to the Railway `web` service. `settings.py` already switches to
   S3 automatically once `AWS_STORAGE_BUCKET_NAME` is non-empty — no code change needed.
   `CensusSnapshot.file` uses `upload_to="census_uploads/"`.
3. Copy `src/org_view/` from `portfolio operations`, then **delete `migrations/` and regenerate a
   fresh `0001_initial`** — same reasoning as the `accounts` squash in Phase 1. The source
   migrations `0003_sync_companies_from_accounts` and `0006_resync_companies_from_accounts` are
   data migrations tied to that deployment's history and shouldn't come along.
4. Rebrand. There are **exactly two** `Rainier` strings across all 11 templates, both in
   `templates/org_view/base.html`:

   | Line | Find | Replace with |
   |---|---|---|
   | 6 | `<title>{% block title %}OrgView{% endblock %} \| Rainier Apps</title>` | `<title>{% block title %}OrgView{% endblock %} \| Flooring Partners Apps</title>` |
   | 315 | `<a href="{% url 'app_hub' %}" class="topbar-brand">Rainier <span>Apps</span></a>` | `<a href="{% url 'app_hub' %}" class="topbar-brand">Flooring Partners <span>Apps</span></a>` |

   Leave the `:root` CSS block alone — it's already the shared theme. Re-verify with
   `grep -rn "Rainier\|rainier" src/org_view/`.
5. Add `"org_view"` to `INSTALLED_APPS`.
6. In `flooring_partners_apps/urls.py`, replace the placeholder route with
   `path("org-view/", include("org_view.urls")),` and delete the `placeholder_app` import if it's
   no longer used. **Keep `placeholder_app` in `views.py`** — future Coming Soon cards will want it.
7. New `accounts` migration flipping the existing tile rather than creating a new one:
   ```python
   AppDefinition.objects.filter(slug="org-view").update(
       url_name="org_view:index",
       status="available",
   )
   ```
   The slug must stay `org-view` — `views.py` guards every view with
   `@app_access_required("org-view")`, which matches on `AppDefinition.slug`.
8. Seed the Org View `Company`. `org_view.signals` auto-creates one from any active
   `CompanyProfile` on save, so the simplest path is
   `python manage.py sync_org_view_companies`, which backfills from `accounts.CompanyProfile`.
   Confirm it produces exactly one row: `flooring-partners`.
9. Apply the D1–D4 decisions.
10. Test locally with the real census file end to end: upload → mapping → quality report →
    bulk edit → save → org chart renders → trends (if kept).
11. Push to `dev`, PR to `main`, verify the Railway deploy, re-run the Phase 5 smoke tests plus
    an Org View-specific pass.

---

## Known Kleen-Tech / Rainier-isms to clean during the port

| Location | Issue |
|---|---|
| `templates/org_view/base.html` lines 6 and 315 | `Rainier Apps` brand text |
| `parsers.py` `COLUMN_ALIASES` | `labor levels(...)` aliases from a Kleen-Tech payroll export |
| `parsers.py` `extract_supervisor_id` docstring | References the Kleen-Tech supervisor format explicitly |
| `services/company_sync.py` docstring | Narrates this deployment's migration-0003 history, which won't apply after the migration squash — rewrite the docstring |
| `management/commands/load_sample_census.py` | No sample data is bundled (the command takes `--file`); the Kleen-Tech-ism is the argument default `parser.add_argument("--company", default="Kleen-Tech Services, LLC", ...)` — change to `"Flooring Partners"` or drop the default |
| `management/commands/merge_org_view_companies.py` | Written for a specific one-off cleanup in the Rainier deployment; probably delete rather than port |

---

## What NOT to port

- `org_design/` from `kleen-tech-apps` — different product entirely
- Anything from `ai_proposals`, `rfp_sources`, or `ai_library`
- The Django-Q2 worker, `Dockerfile.worker`, `boot/worker-run.sh` — Org View has no background jobs
- Any `CREDENTIAL_ENCRYPTION_KEY` / GovWin / Playwright configuration
