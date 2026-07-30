# Phase 5 — Auth bootstrap and smoke test

**Mixed phase:** mostly browser and terminal verification. The optional test-user script is a
copy-paste for Claude Code or the Railway shell.

**Outcome:** confirmed working auth, a verified hub, and a committed run log.

---

## ⚠ How to run `manage.py` commands against production

Use **`railway ssh`**, not `railway run`.

| Command | What it actually does |
|---|---|
| `railway run <cmd>` | Runs `<cmd>` **on your laptop** with Railway's env vars injected. `DATABASE_URL` resolves to the *private* URL (`…@postgres.railway.internal:5432`), which does not resolve outside Railway's network — so it fails at connect. |
| `railway ssh --service web` | Opens a shell **inside the running container**. This is what you want. |
| `railway connect Postgres` | Correct as-is — the CLI proxies through the public TCP endpoint. |
| `railway logs --service web` | Correct as-is. |

Every `manage.py` command below assumes you're inside the container, where `WORKDIR` is `/code`
and `manage.py` sits at the root — so it's `python manage.py`, never `python src/manage.py`.
(The Kleen-Tech runbook gets both of these wrong.)

```bash
railway login
railway link                    # select the flooring-partners project
railway ssh --service web
# You're now inside the container. cd is already /code.
```

If the CLI isn't installed or `railway ssh` isn't available on your plan, use the **Railway
dashboard → `web` service → the shell / terminal panel** instead. Same commands.

---

## Step 1 — Confirm the superuser exists

`bootstrap_admin` ran during the container boot (Phase 3 Step 7). Verify rather than assume.

Inside the container shell:

```bash
python manage.py shell -c "from django.contrib.auth import get_user_model; U=get_user_model(); print([(u.username, u.email, u.is_superuser) for u in U.objects.all()])"
```

Expected: `[('dshephard', 'dshephard@rainierpartners.com', True)]`

If no user exists, run it manually:

```bash
python manage.py bootstrap_admin
```

If that reports "skipping", the `DJANGO_SUPERUSER_*` variables aren't set on the `web` service —
go back to Phase 3 Step 6.

---

## Step 2 — Confirm the CompanyProfile and UserProfile

`accounts.signals.ensure_superuser_profile` fires on superuser save and creates both automatically.
This is why there's no manual profile step here — unlike the Kleen-Tech playbook, which required a
hand-run shell script.

```bash
python manage.py shell -c "from accounts.models import CompanyProfile, UserProfile; print(list(CompanyProfile.objects.values_list('name','is_active'))); print(list(UserProfile.objects.values_list('user__username','company__name','role')))"
```

Expected:
```
[('Flooring Partners', True)]
[('dshephard', 'Flooring Partners', 'superadmin')]
```

**A superuser without a `UserProfile` sees an empty hub.** If the profile is missing, create it:

```bash
python manage.py shell <<'PY'
from django.contrib.auth import get_user_model
from accounts.models import CompanyProfile, UserProfile

User = get_user_model()
u = User.objects.get(username="dshephard")
company, _ = CompanyProfile.objects.get_or_create(name="Flooring Partners")
profile, created = UserProfile.objects.get_or_create(
    user=u, defaults={"company": company, "role": "superadmin"}
)
profile.company = company
profile.role = "superadmin"
profile.save()
print(f"Profile {'created' if created else 'updated'}: {profile}")
PY
```

---

## Step 3 — Attach available apps to the company

`CompanyProfile.available_apps` limits what a company admin can assign to users. It doesn't gate
superadmins (who see everything active), but set it now so the admin panel behaves correctly when
you add real users.

```bash
python manage.py shell <<'PY'
from accounts.models import AppDefinition, CompanyProfile

company = CompanyProfile.objects.get(name="Flooring Partners")
company.available_apps.set(AppDefinition.objects.filter(is_active=True))
company.save()
print("available_apps:", list(company.available_apps.values_list("slug", flat=True)))
PY
```

Expected: `available_apps: ['org-view']`

---

## Step 4 — Optional: create a non-admin test user

Worth doing once, to prove the role gating works before you onboard anyone real.

```bash
python manage.py shell <<'PY'
from django.contrib.auth import get_user_model
from accounts.models import AppDefinition, CompanyProfile, UserProfile

User = get_user_model()
company = CompanyProfile.objects.get(name="Flooring Partners")

u, _ = User.objects.get_or_create(
    username="fp_test", defaults={"email": "test+flooringpartners@example.com"}
)
u.set_password("ChangeMe-Once-2026!")
u.is_superuser = False
u.is_staff = False
u.save()

profile, _ = UserProfile.objects.get_or_create(
    user=u, defaults={"company": company, "role": "user"}
)
profile.company = company
profile.role = "user"
profile.save()
profile.assigned_apps.set(AppDefinition.objects.filter(slug="org-view"))
print("Test user ready:", profile, list(profile.assigned_apps.values_list("slug", flat=True)))
PY
```

Delete this user before the deployment goes to real users.

---

## Step 5 — Smoke tests

Run all of these against `https://flooringpartners.portfolioapps.ai`. Don't proceed past a failure.

### Test 1 — TLS and login page
- [ ] Page loads over HTTPS with a valid certificate
- [ ] Browser tab title reads **Sign in | Flooring Partners Apps**
- [ ] Dark background (`#21262b` family) with gold accent (`#a49275`), Lato / Titillium Web fonts
- [ ] No visible "Kleen-Tech" or "Rainier" text anywhere
- [ ] Submitting a wrong password shows an error inline, not a 500

### Test 2 — Hub
- [ ] Login as `dshephard` redirects to `/apps/`
- [ ] Brand label reads **Flooring Partners Apps**
- [ ] Exactly one section renders: **Business Performance and Reporting**
- [ ] Exactly one card: **Org View**, badge **Coming Soon**
- [ ] The card is dimmed (`card-muted` styling), which is correct for `coming_soon`
- [ ] The Administrative and Commercial & Sales sections do **not** render — empty sections are
      skipped by design

### Test 3 — Placeholder page
- [ ] Clicking the Org View card opens `/org-view/`
- [ ] It shows section label "Business Performance and Reporting", heading "Org View", "Coming Soon"
- [ ] "← Back to App Hub" returns to `/apps/`

### Test 4 — Admin panel
- [ ] User dropdown (top right) opens on click
- [ ] **Admin Panel** opens `/admin-panel/` and shows 1 user, 1 company
- [ ] `/admin-panel/users/` lists `dshephard`
- [ ] `/admin-panel/companies/` lists `Flooring Partners`
- [ ] Adding a user through this UI works (then delete the test row)

### Test 5 — Django admin
- [ ] `/admin/` loads
- [ ] `App definitions`, `Company profiles`, `User profiles` are all registered
- [ ] Opening the `org-view` AppDefinition shows section `Business Performance and Reporting`,
      status `Coming Soon`, active

### Test 6 — Logout
- [ ] Dropdown → **Log out** returns to `/`
- [ ] Navigating directly to `/apps/` while logged out redirects to the login page
- [ ] Navigating to `/org-view/` while logged out redirects to the login page

### Test 7 — Permissions (only if you created `fp_test`)
- [ ] Log in as `fp_test` → hub shows only the Org View card
- [ ] `/admin-panel/` → 403 or a permission-denied page, **not** a 500
- [ ] `/admin/` → redirected to the Django admin login, not granted access

### Test 8 — Health and CI/CD
- [ ] `/healthz/` returns `{"status": "ok"}`
- [ ] Make a trivial commit on `main` (e.g. a README typo), push, and confirm Railway
      auto-deploys and the site stays up

### Test 9 — Isolation
- [ ] `https://portfolioapps.ai` still works, existing credentials still log in
- [ ] `https://kleen-tech.portfolioapps.ai` still works, existing credentials still log in
- [ ] `dshephard` on Flooring Partners is a **separate** account — changing its password here has
      no effect on the other two deployments

---

## Step 6 — Log review

Run these from your **laptop**, not the container shell — `railway logs` and `railway connect`
both work locally.

```bash
railway logs --service web | grep -iE "error|traceback|warning" | tail -50
```

Acceptable: deprecation warnings, the occasional `Not Found: /favicon.ico`.
Not acceptable: any `Traceback`, any `500`, any `DisallowedHost`, any `CSRF verification failed`.

```bash
railway connect Postgres
```

```sql
SELECT count(*) FROM pg_stat_activity WHERE datname = current_database();
-- Expected: low single digits. A single gunicorn worker with 8 threads should not exceed ~10.
\q
```

---

## Step 7 — Tidy up

Once everything passes:

1. **Remove the superuser password from Railway.** `bootstrap_admin` has done its job and no-ops
   from here. Delete `DJANGO_SUPERUSER_PASSWORD` (and optionally the username/email vars) from
   `web` → Variables. The next deploy will log "skipping" and carry on.
   > If you'd rather keep them for disaster recovery, that's a defensible choice — just know a
   > production password is sitting in the Railway env, readable by anyone with project access.
2. Delete the `fp_test` user if you created it.
3. Confirm your superuser password is in your password manager.

---

## Step 8 — Write the run log

Create `instructions/subdomain-launch/RUN_LOG.md` and commit it.

```markdown
# Flooring Partners subdomain — initial cutover run log

**Date:** 2026-__-__
**Operator:** Dave Shephard
**Subdomain:** flooringpartners.portfolioapps.ai
**GitHub repo:** <url>
**Railway project:** flooring-partners
**Railway custom domain CNAME target:** ___
**Services:** web, Postgres (no worker)
**Superuser:** dshephard
**Default company:** Flooring Partners
**Apps seeded:** org-view (Coming Soon)

## Test results
| Test | Result |
|---|---|
| 1 — TLS and login page | |
| 2 — Hub | |
| 3 — Placeholder page | |
| 4 — Admin panel | |
| 5 — Django admin | |
| 6 — Logout | |
| 7 — Permissions | |
| 8 — Health and CI/CD | |
| 9 — Isolation | |

## Deviations from plan
- (none / list anything done differently)

## Open follow-ups
- Port Org View from `portfolio operations` (see 06-org-view-port-plan.md)
- Create the `flooringpartners-media` S3 bucket + IAM user before census uploads go live
- Rebrand theme with real Flooring Partners colors and logo (currently identical to Kleen-Tech)
- Add uptime monitoring on /healthz/
- Decide whether Administrative and Commercial & Sales sections get apps
- Set up a Railway staging environment tracking `dev`, if the deploy cadence warrants it
```

```bash
cd "C:\Users\DaveShephard\Dev\flooring-partners"
git add instructions/subdomain-launch/RUN_LOG.md
git commit -m "Add cutover run log"
git push
```

---

## Troubleshooting reference

| Symptom | Likely cause | Fix |
|---|---|---|
| HTTP 400 / `DisallowedHost` | Hostname missing from `DJANGO_ALLOWED_HOSTS` | Phase 3 Step 6 |
| Login form returns 403 | Origin missing from `DJANGO_CSRF_TRUSTED_ORIGINS` | Phase 3 Step 6 |
| Hub loads but is completely empty | `UserProfile` missing, or no active `AppDefinition` rows | Steps 2 and 3 above |
| Hub loads, Org View card missing | Non-superadmin user with no `assigned_apps` | Assign via `/admin-panel/` |
| Card renders but the link is dead (`href="#"`) | `url_name` doesn't resolve — the hub uses `{% url app.url_name as app_url %}` which fails silently | Confirm `AppDefinition.url_name == "org_view_placeholder"` and that route exists in `urls.py` |
| No CSS at all, unstyled HTML | `collectstatic` didn't run | Check deploy logs; confirm no Start Command overrides the Dockerfile CMD |
| Redirect loop on every page | `SECURE_SSL_REDIRECT` without the proxy header | Confirm `SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")` is in settings |
| 502 from Railway | Container not listening on `$PORT` | Confirm `boot/docker-run.sh` binds `${PORT:-8080}` |

---

## Cutover declaration

Declare Phase 1 complete when:

- [ ] All 9 test sections pass
- [ ] Log review is clean
- [ ] `RUN_LOG.md` is committed
- [ ] `DJANGO_SUPERUSER_PASSWORD` removed from Railway (or a conscious decision made to keep it)
- [ ] `portfolioapps.ai` and `kleen-tech.portfolioapps.ai` verified unaffected

Then move to `06-org-view-port-plan.md` in a fresh session.
