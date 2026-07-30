# Phase 3 — Railway project setup

**This entire phase is browser work in the Railway dashboard.** Nothing here is for Claude Code.

**Outcome:** a Railway project `flooring-partners` with a `web` service and a `Postgres` service,
deploying automatically from `main`, reachable on a generated `*.up.railway.app` URL.

**Prerequisite:** Phase 2 complete — `flooring-partners-apps` is on GitHub with a green CI run.

---

## Step 1 — Generate the two secrets you'll need

Run these locally first and paste the output somewhere you can copy from. Don't reuse the
Kleen-Tech or Rainier values.

```bash
python -c "import secrets; print(secrets.token_urlsafe(50))"
```

That's your `DJANGO_SECRET_KEY`.

Then pick a strong password for the initial superuser. This becomes `DJANGO_SUPERUSER_PASSWORD`.
Store it in your password manager now — you will be logging in with it in Phase 5.

---

## Step 2 — Create the project

1. Go to **https://railway.com/new**
2. Click **Deploy from GitHub repo**
3. If Railway can't see the repo: **Configure GitHub App** → grant access to
   `flooring-partners-apps` → return to Railway.
4. Select **`flooring-partners-apps`**
5. Railway creates the project and **immediately starts a build**. **Cancel that build.**
   It will fail anyway — there are no environment variables and no database yet.
   (Deployments tab → the running deployment → **⋮** → **Remove** / **Cancel**.)
6. Rename the project: top-left project name → **Settings** → **Name** → `flooring-partners`

---

## Step 3 — Rename the service to `web`

Railway names the auto-created service after the repo (`flooring-partners-apps`). Rename it so
environment-variable references stay short and match these instructions.

1. Click the service card
2. **Settings** → **Service Name** → `web` → save

---

## Step 4 — Add Postgres

1. In the project canvas, click **+ Create** (or **+ New**)
2. **Database** → **Add PostgreSQL**
3. Leave the service named **`Postgres`** (capital P — this is Railway's default and the reference
   variable `${{Postgres.DATABASE_URL}}` is case-sensitive)

Wait until the Postgres service shows a green/active state before continuing.

---

## Step 5 — Confirm the build settings

Because `railway.json` is committed (Phase 1, Step 14), Railway should pick these up automatically.
Verify rather than assume:

1. `web` service → **Settings** → **Build**
   - **Builder:** `Dockerfile`
   - **Dockerfile Path:** `Dockerfile`
   - **Root Directory:** empty (repo root)
2. `web` service → **Settings** → **Deploy**
   - **Healthcheck Path:** `/healthz/`
   - **Healthcheck Timeout:** `120`
   - **Start Command:** **leave empty** — the Dockerfile's `CMD` runs `boot/docker-run.sh`.
     Setting a start command here overrides it and skips migrations.
   - **Restart Policy:** `On Failure`, max retries `3`
   - **Replicas:** `1`
3. `web` service → **Settings** → **Source**
   - **Branch:** `main`
   - **Wait for CI:** **on**, if the option is available. This makes Railway hold the deploy until
     GitHub Actions passes, which is the whole point of having CI.

---

## Step 6 — Environment variables

`web` service → **Variables** tab → **Raw Editor** → paste the block below, then fill in the two
placeholder values.

```
DJANGO_SETTINGS_MODULE=flooring_partners_apps.settings
DJANGO_SECRET_KEY=<paste the token from Step 1>
DJANGO_DEBUG=False
DJANGO_ALLOWED_HOSTS=flooringpartners.portfolioapps.ai,.railway.app,localhost,127.0.0.1
DJANGO_CSRF_TRUSTED_ORIGINS=https://flooringpartners.portfolioapps.ai,https://*.railway.app
DJANGO_TIME_ZONE=America/Los_Angeles
PROJECT_NAME=Flooring Partners Apps
DATABASE_URL=${{Postgres.DATABASE_URL}}
DJANGO_SUPERUSER_USERNAME=dshephard
DJANGO_SUPERUSER_EMAIL=dshephard@rainierpartners.com
DJANGO_SUPERUSER_PASSWORD=<paste your chosen strong password>
ADMIN_USER_NAME=Dave Shephard
ADMIN_USER_EMAIL=dshephard@rainierpartners.com
```

Click **Deploy** / **Apply Changes**.

### Notes on specific variables

| Variable | Note |
|---|---|
| `DATABASE_URL` | Must be typed as the literal reference `${{Postgres.DATABASE_URL}}`, not a pasted connection string. Railway resolves it at deploy time, so credential rotations don't break you. If the Postgres service isn't named exactly `Postgres`, adjust the reference. Note this resolves to Railway's **private** hostname (`postgres.railway.internal`), which is unreachable from your laptop — see the note at the top of Phase 5. |
| `DJANGO_SETTINGS_MODULE` | Belt-and-braces. `manage.py` and `wsgi.py` already `setdefault` it to the same value, so the app works without it — but setting it explicitly means a future `asgi`/celery/worker entrypoint can't pick up the wrong module. |
| `DJANGO_ALLOWED_HOSTS` | Includes the production hostname now even though DNS doesn't exist yet. Harmless, and it means Phase 4 needs no redeploy. |
| `DJANGO_SUPERUSER_*` | Read by `bootstrap_admin` on every boot. The command is idempotent — after the first successful run it no-ops. You can delete these three variables after Phase 5 if you'd rather not leave a password in the Railway env. |
| `DJANGO_TIME_ZONE` | Affects display only; datetimes are stored in UTC. Change to Flooring Partners' operating timezone if Pacific is wrong. |

### Variables NOT to set

Don't copy these over from Kleen-Tech. Nothing in this deployment reads them, and having them
around invites confusion later: `ANTHROPIC_API_KEY`, `GOOGLE_GEMINI_API_KEY`, `GOOGLE_API_KEY`,
`GEMINI_MODEL`, `CLAUDE_MODEL`, `CREDENTIAL_ENCRYPTION_KEY`, `GOVWIN_*`, `TWOCAPTCHA_API_KEY`,
`BRAVE_SEARCH_API_KEY`, `VISUAL_CROSSING_API_KEY`, `ORS_API_KEY`, `SYNC_SCRAPE`, `INGEST_TOKEN`.

`AWS_*` is also unnecessary for now — `settings.py` falls back to filesystem storage when
`AWS_STORAGE_BUCKET_NAME` is unset, and Phase 1's hub uploads nothing. You'll add the S3 bucket
and those four variables during the Org View port, when census file uploads start.

The six `EMAIL_*` variables are likewise unset. Nothing in the Phase 1 codebase sends mail
(`grep -rn "send_mail\|EmailMessage\|mail_admins" src/` returns nothing), so this is safe. If you
later add password-reset emails or error notifications, that's when to configure SMTP.

---

## Step 7 — Deploy and read the logs

1. `web` → **Deployments** → **Deploy** (or push any commit to `main`)
2. Open the deployment and watch **Build Logs** then **Deploy Logs**

Expected sequence in the deploy logs:

```
<n> static files copied to '/code/staticfiles'
Operations to perform:
  Apply all migrations: accounts, admin, auth, contenttypes, sessions
Running migrations:
  Applying contenttypes.0001_initial... OK
  ...
  Applying accounts.0001_initial... OK
  Applying accounts.0002_seed_app_definitions... OK
bootstrap_admin: created superuser 'dshephard'.
[<date>] [1] [INFO] Starting gunicorn 23.0.0
[<date>] [1] [INFO] Listening at: http://0.0.0.0:8080
```

Then the healthcheck passes and the deployment flips to **Active**.

### If the build or deploy fails

| Symptom | Cause | Fix |
|---|---|---|
| `/opt/docker-run.sh: no such file or directory` (but the file exists) | CRLF line endings on the shell script | Confirm `.gitattributes` has `*.sh text eol=lf`, then `git rm --cached boot/docker-run.sh && git add boot/docker-run.sh && git commit && git push` to re-normalize |
| `ValueError: DATABASE_URL must be set when DJANGO_DEBUG is not True` | `DATABASE_URL` reference didn't resolve | Check the Postgres service name matches the `${{...}}` reference exactly |
| `django.core.exceptions.ImproperlyConfigured: SECRET_KEY` | `DJANGO_SECRET_KEY` missing or empty | Re-add in Variables |
| Healthcheck times out but gunicorn is listening | Healthcheck path wrong, or `SECURE_SSL_REDIRECT` loop | Confirm path is `/healthz/` **with the trailing slash**. If it still fails, temporarily set `DJANGO_DEBUG=True`, confirm the app responds, then investigate the redirect |
| Build succeeds, deploy crash-loops with `relation "accounts_appdefinition" does not exist` | A start command was set in Settings, overriding the Dockerfile CMD and skipping migrations | Clear the Start Command field (Step 5) |
| `no such table` / SQLite errors in production | `DATABASE_URL` empty and `DJANGO_DEBUG=True` | Set `DJANGO_DEBUG=False` and fix `DATABASE_URL` |

---

## Step 8 — Generate a temporary domain and test

1. `web` → **Settings** → **Networking** → **Generate Domain**
2. Railway gives you something like `https://web-production-a1b2.up.railway.app`
3. Open it. You should see the Flooring Partners login page.
4. Log in with `DJANGO_SUPERUSER_USERNAME` / `DJANGO_SUPERUSER_PASSWORD`.
5. You should land on `/apps/` with the **Org View — Coming Soon** card.

**Do not proceed to Phase 4 until this works.** DNS is the cutover step; get the app right first.

---

## Step 9 — Verify the database

Optional but worth 60 seconds. Requires the Railway CLI (`npm i -g @railway/cli`).

```bash
railway login
railway link          # select the flooring-partners project
railway connect Postgres
```

```sql
\dt
-- Expected: accounts_appdefinition, accounts_companyprofile, accounts_userprofile,
--           auth_user, auth_group, django_migrations, django_session, etc.

SELECT slug, section, status, is_active FROM accounts_appdefinition;
-- Expected: org-view | business_performance | coming_soon | t

SELECT name FROM accounts_companyprofile;
-- Expected: Flooring Partners

SELECT u.username, p.role FROM auth_user u JOIN accounts_userprofile p ON p.user_id = u.id;
-- Expected: dshephard | superadmin

\q
```

---

## Step 10 — Right-size the service (cost control)

Railway bills on usage. This app is a single gunicorn worker with 8 threads serving a login page
and a hub — it does not need much.

1. `web` → **Settings** → **Resources** (naming varies by plan, and **this panel may not exist at
   all on the Hobby plan** — per-service resource limits are a paid-plan feature)
2. If available, set a memory limit around **512 MB**. The Kleen-Tech deployment needed ~700 MB+
   because of Playwright and Chroma; none of that is here.
3. Leave vCPU on the default.

If the panel isn't there, skip this step — the app's actual footprint is small and you'll be billed
on real usage either way. If the service OOMs during `collectstatic` or `migrate`, raise to 1 GB —
but it shouldn't.

---

## Done check

- [ ] Project `flooring-partners` contains exactly two services: `web` and `Postgres`
- [ ] No worker service exists
- [ ] `web` latest deployment is **Active** with a passing healthcheck
- [ ] The generated `*.up.railway.app` URL serves the login page over HTTPS
- [ ] Logging in reaches `/apps/` and shows the Org View card
- [ ] Deploy logs show `accounts.0002_seed_app_definitions... OK` and `bootstrap_admin: created superuser`
- [ ] `/healthz/` on the generated domain returns `{"status": "ok"}`

Next: `04-cloudflare-dns.md`.
