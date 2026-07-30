# Flooring Partners Apps

Internal apps hub for Flooring Partners, hosted at https://flooringpartners.portfolioapps.ai.

Scaffolded 2026-07-30 from the `kleen-tech-apps` deployment pattern. Maintained independently —
no code or data is shared with `rainier_apps` or `kleen-tech-apps`.

## Structure

- `src/flooring_partners_apps/` — Django project (settings, urls, views, wsgi)
- `src/accounts/` — auth, CompanyProfile, UserProfile, AppDefinition catalog, admin panel
- `src/templates/` — hub, login, placeholder, error pages
- `boot/docker-run.sh` — container entrypoint: collectstatic, migrate, bootstrap_admin, gunicorn
- `instructions/` — build and deployment runbooks

## Apps

| App | Section | Status |
|---|---|---|
| Org View | Business Performance and Reporting | Coming Soon |

## Local development

```bash
python -m venv .venv && source .venv/Scripts/activate
pip install -r requirements.txt
cp .env.example .env    # then set DJANGO_SECRET_KEY and DJANGO_DEBUG=True
cd src
python manage.py migrate
python manage.py bootstrap_admin
python manage.py runserver 8000
```

## Deployment

Railway project `flooring-partners`, services `web` + `Postgres`. Pushes to `main` auto-deploy.
See `instructions/subdomain-launch/`.
