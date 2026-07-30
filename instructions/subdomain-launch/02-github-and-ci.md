# Phase 2 — GitHub repo and CI

Two parts. **Part A is browser work you do yourself.** Part B is a copy-paste prompt for Claude Code.

---

# PART A — In the browser (Dave)

## A1. Create the repository

1. Go to **https://github.com/new**
2. Fill in:
   - **Repository name:** `flooring-partners-apps`
   - **Description:** `Flooring Partners apps hub (flooringpartners.portfolioapps.ai)`
   - **Visibility:** **Private**
   - **Initialize this repository with:** leave **all three boxes unchecked** — no README,
     no `.gitignore`, no license. The local repo already has all three, and an initialized
     remote forces an awkward first merge.
3. Click **Create repository**.
4. On the next screen, copy the **HTTPS clone URL**. It looks like:
   `https://github.com/<your-account>/flooring-partners-apps.git`

Keep that URL — Part B needs it.

## A2. Protect `main` (optional but recommended)

Railway deploys from `main`, so an accidental broken push goes straight to production.

1. Repo → **Settings** → **Branches** → **Add branch ruleset** (or **Add rule** on older UIs)
2. **Branch name pattern:** `main`
3. Enable:
   - **Require a pull request before merging** (0 required approvals is fine for a solo repo)
   - **Require status checks to pass** → select **build** once the first CI run has happened
   - **Do not allow bypassing the above settings** — leave this **off** so you can force through
     an emergency fix.
4. Save.

> If this feels like friction for a one-person repo, skip it. Just be deliberate about what you
> push to `main`.

---

# PART B — In VS Code (Claude Code)

Paste this into Claude Code, substituting your clone URL.

## B1. Initialize and push

```bash
cd "C:\Users\DaveShephard\Dev\flooring-partners"

# There should be no .git folder yet. If there is, stop and check why before deleting it.
ls -la .git 2>/dev/null && echo "WARNING: .git already exists — stop and investigate."

git init -b main

# Sanity check what is about to be committed BEFORE committing.
git add -A
git status --short
```

Review that list. It should contain roughly 50–55 files — that includes the 6 instruction `.md`
files already in `instructions/subdomain-launch/`, which **should** be committed; they're the
runbook for this deployment and belong in the repo. It must **not** contain:

- `.env` (only `.env.example`)
- `.venv/` or any `venv/`
- `__pycache__/` or `*.pyc`
- `src/db.sqlite3`
- `src/staticfiles/` or `src/media/`

If any of those appear, fix `.gitignore` and run `git rm -r --cached <path>` before continuing.

```bash
git commit -m "Scaffold Flooring Partners apps hub

Lean Django 5.2 project for flooringpartners.portfolioapps.ai:
- accounts app (AppDefinition / CompanyProfile / UserProfile) ported from kleen-tech-apps
- three-section app hub, Org View seeded as Coming Soon
- env-driven ALLOWED_HOSTS / CSRF_TRUSTED_ORIGINS
- bootstrap_admin command for non-interactive superuser creation
- /healthz/ probe and committed railway.json
- web-only Dockerfile (no worker, no GDAL/Cairo/LibreOffice)"

git remote add origin https://github.com/<your-account>/flooring-partners-apps.git
git push -u origin main
```

## B2. Create the `dev` branch

`main` is the deployable trunk. Feature work happens on short-lived branches off `dev`.

```bash
git checkout -b dev
git push -u origin dev
```

## B3. Verify the working tree is clean and `.env` is ignored

```bash
git status
# Expected: "nothing to commit, working tree clean"

git status --ignored --short | grep -E "\.env$|\.venv|__pycache__|db\.sqlite3"
# Expected: each shown with a "!!" prefix, meaning ignored — not staged, not tracked.

git ls-files | grep -E "\.env$|\.venv|__pycache__|db\.sqlite3"
# Expected: no output at all. Any output here means a secret or artifact got committed.
```

If `.env` did get committed, fix it now rather than later:

```bash
git rm --cached .env
git commit -m "Remove .env from tracking"
git push
```

...and then **rotate `DJANGO_SECRET_KEY`**, since the old value is in git history.

---

## B4. Confirm CI runs

The workflow file was written in Phase 1, Step 17. After the push:

1. Repo → **Actions** tab
2. You should see a **Django CI** run for the `main` push.
3. It should pass all four steps: install deps, `manage.py check`, `migrate`, `test`.

If it fails on `manage.py check` with a `SECRET_KEY` error, confirm the workflow sets
`DJANGO_SECRET_KEY: "ci-only-secret-key"` in **every** step's `env` block, not just the first.

> **No repository secrets are required.** The workflow runs against SQLite with `DJANGO_DEBUG=True`,
> deliberately, so CI can't be broken by a rotated production credential. This differs from the
> Kleen-Tech workflow, which references six secrets (`DJANGO_SECRET_KEY`, `DATABASE_URL`,
> `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_STORAGE_BUCKET_NAME`, `AWS_S3_REGION_NAME`)
> and silently fails without them.

---

## Done check

- [ ] `flooring-partners-apps` exists on GitHub and is **Private**
- [ ] `main` and `dev` both exist and point at the same commit
- [ ] `git ls-files | grep "\.env$"` returns nothing
- [ ] Actions → **Django CI** is green on `main`
- [ ] `README.md` renders on the repo landing page

Next: `03-railway-setup.md`.
