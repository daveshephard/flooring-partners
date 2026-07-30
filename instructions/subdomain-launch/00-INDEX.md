# Flooring Partners Apps — Subdomain Launch

**Goal:** stand up `flooringpartners.portfolioapps.ai` as an isolated portfolio-company apps hub
for Flooring Partners (consolidated Flooring Partners + SCI), with its own GitHub repo, its own
Railway project, and its own Postgres — mirroring the `kleen-tech.portfolioapps.ai` pipeline.

**Author:** Dave Shephard
**Date scoped:** 2026-07-30
**Reference deployments:**
- `C:\Users\DaveShephard\Dev\portfolio operations` — original `rainier_apps` monorepo (source of `org_view`)
- `C:\Users\DaveShephard\Dev\kleen-tech-apps` — the pattern this deployment copies

---

## Scope of THIS session

Ship a working subdomain with the hub and login only. **No Org View code yet.**

At the end of this session:

- `https://flooringpartners.portfolioapps.ai` resolves, has a valid TLS cert, and shows a
  Flooring Partners-branded login page.
- Logging in lands on `/apps/` — the app hub, styled identically to Kleen-Tech.
- The hub shows one card: **Org View**, status `Coming Soon`, linking to a placeholder page.
- Pushing to `main` on GitHub auto-deploys to Railway.

Org View itself is ported in a **later session** — see `06-org-view-port-plan.md`.

---

## Locked decisions

| Area | Decision |
|---|---|
| **Isolation** | New GitHub repo, new Railway project, new Postgres. Zero sharing with `rainier_apps` or `kleen-tech-apps`. |
| **Seed strategy** | **Selective copy**, not "copy everything then delete." We copy only the scaffold + `accounts` app from `kleen-tech-apps`. This avoids dragging in `ai_library/` (568 document files), the `ai_proposals`/`rfp_sources`/`org_design` apps, and the Playwright / GDAL / Cairo / LibreOffice / Anthropic / Chroma dependency stack. |
| **Services** | `web` + `Postgres` only. **No worker service** — nothing on this deployment needs Django-Q2, so we skip the heavy Playwright/Xvfb image entirely. |
| **Auth** | Independent accounts. No SSO with `portfolioapps.ai`. Fresh superuser on first deploy. |
| **Tenancy** | **One** `CompanyProfile`: `Flooring Partners`. SCI is consolidated into it, not modeled separately. |
| **DNS** | Cloudflare (nameservers point to CF). CNAME `flooringpartners` → Railway target, **proxy OFF (gray cloud)**. |
| **Hub sections** | (1) Administrative, (2) Commercial & Sales, (3) Business Performance and Reporting — same three as Kleen-Tech. |
| **First app tile** | `Org View`, slug `org-view`, section `business_performance`, status `coming_soon`. |
| **Styling** | Byte-identical theme to Kleen-Tech (dark `#21262b` / gold `#a49275`, Lato + Titillium Web). Brand text only is changed. Rebrand colors later. |
| **Migrations** | `accounts` migrations are **squashed to a fresh `0001_initial`**. The DB is brand new, and Kleen-Tech's 15 accounts migrations carry references to apps we don't have. |

### Three deliberate improvements over the Kleen-Tech playbook

The Kleen-Tech build left three gaps. Fix them here from day one:

1. **`ALLOWED_HOSTS` / `CSRF_TRUSTED_ORIGINS` are env-driven**, not hardcoded in `settings.py`.
   Kleen-Tech hardcodes the hostname, which means a domain change is a code change.
2. **A `bootstrap_admin` management command** creates the superuser non-interactively from env vars.
   Kleen-Tech has a commented-out `auto_admin` line in `boot/docker-run.sh` and a manual
   `createsuperuser` step; that's the single most annoying part of that deploy.
3. **`railway.json` is committed**, with an explicit `healthcheckPath`. Kleen-Tech's entire
   Railway config lives only in the UI and is not reproducible.

---

## Naming conventions — use these exactly

| Thing | Value |
|---|---|
| GitHub repo | `flooring-partners-apps` |
| Local clone path | `C:\Users\DaveShephard\Dev\flooring-partners` |
| Django project package | `flooring_partners_apps` |
| Railway project | `flooring-partners` |
| Railway web service | `web` |
| Railway Postgres service | `Postgres` |
| Production domain | `flooringpartners.portfolioapps.ai` |
| Cloudflare record name | `flooringpartners` |
| S3 bucket (not needed until Org View) | `flooringpartners-media` |
| `PROJECT_NAME` | `Flooring Partners Apps` |
| Default `CompanyProfile` name | `Flooring Partners` |

> **Note the hostname has no hyphen** (`flooringpartners`), while the repo and Railway project do
> (`flooring-partners-apps`, `flooring-partners`). This matches the Kleen-Tech precedent, where the
> repo is `kleen-tech-apps` and the host is `kleen-tech.portfolioapps.ai`. Don't drift.

---

## Phase order

Run in order. Do not skip ahead — Railway needs the repo, DNS needs Railway.

| # | File | Where you work | Est. |
|---|---|---|---|
| 1 | `01-scaffold-project.md` | **VS Code / Claude Code** | 30–45 min |
| 2 | `02-github-and-ci.md` | Browser + VS Code | 15 min |
| 3 | `03-railway-setup.md` | **Browser (Railway)** | 20 min |
| 4 | `04-cloudflare-dns.md` | **Browser (Railway + Cloudflare)** | 10 min + propagation |
| 5 | `05-auth-bootstrap-and-smoke-test.md` | Browser + terminal | 20 min |
| 6 | `06-org-view-port-plan.md` | *Next session — do not execute now* | — |

Files marked **Browser** are things Claude Code cannot do. Everything in `01` and most of `02`
is a copy-paste prompt for Claude Code.

---

## Prerequisites

- [ ] GitHub account with permission to create private repos in your namespace.
- [ ] Railway account with a free project slot.
- [ ] Cloudflare access to the `portfolioapps.ai` zone.
- [ ] Local clones of both `portfolio operations` and `kleen-tech-apps` present and current
      (Claude Code reads from them in Phase 1).
- [ ] `git`, `python 3.12`, and `psql` on PATH. Railway CLI optional (`npm i -g @railway/cli`).
- [ ] `C:\Users\DaveShephard\Dev\flooring-partners` exists and contains only `instructions/`.

---

## Risks and things not to do

- **Do not reuse `DJANGO_SECRET_KEY`** from either existing deployment. Generate a fresh one.
- **Do not reuse a `DATABASE_URL`.** New Postgres, always.
- **Do not copy `.env` from `kleen-tech-apps`.** It contains GovWin, Anthropic, Gemini, 2Captcha,
  and Fernet keys that have no business in this deployment. Write a fresh minimal `.env`.
- **Do not copy `accounts/migrations/`.** Squash to a fresh `0001_initial` (Phase 1, Steps 2 and 9).
- **Do not turn on the Cloudflare orange cloud.** Railway issues its own cert at its edge; the
  proxy breaks issuance unless you separately configure Full (strict). Gray cloud is the working setup.
- **Do not enable a worker service.** If you later add an app that needs one, add
  `Dockerfile.worker` and the Railway service at that point, not now.
- **Test on the Railway-generated `*.up.railway.app` URL before touching DNS.** Phase 4 is the cutover.

## Rollback

1. Cloudflare → delete the `flooringpartners` CNAME. Subdomain stops resolving.
2. Railway → pause or delete the `flooring-partners` project.
3. Nothing on `portfolioapps.ai` or `kleen-tech.portfolioapps.ai` is touched at any point.
