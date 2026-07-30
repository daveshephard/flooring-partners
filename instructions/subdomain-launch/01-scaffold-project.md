# Phase 1 — Scaffold the Flooring Partners Django project

**Where:** VS Code / Claude Code CLI. Everything in this file is for Claude Code to execute.
**Working directory:** `C:\Users\DaveShephard\Dev\flooring-partners`
**Reference repo (read-only source):** `C:\Users\DaveShephard\Dev\kleen-tech-apps`

**Outcome:** a lean Django 5.2 project that boots locally, shows a Flooring Partners login page,
and renders an app hub with a single "Org View — Coming Soon" card.

> **Approach:** selective copy, not clone-and-delete. We take only the scaffold and the `accounts`
> app from `kleen-tech-apps`, and write fresh lean versions of `settings.py`, `requirements.txt`,
> and `Dockerfile`. Do not copy `ai_proposals`, `rfp_sources`, `org_design`, `ai_library`,
> `backups`, `.env`, `.venv`, or `Dockerfile.worker`.

## ⚠ Execution order

The steps are numbered for reading order, not execution order. **Step 9 (migrations) must run
after Steps 10 and 16**, because it needs `requirements.txt` installed and a `.env` with
`DJANGO_DEBUG=True` present. Execute in this order:

```
1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 10 → 11 → 12 → 13 → 14 → 15 → 16 → 17 → 18 → 19 → 9 → 20
```

Step 9 also prints the exact prerequisite check, so if you follow the numbers you'll be told to
stop rather than seeing a confusing crash.

---

## Step 1 — Create the directory tree

```bash
cd "C:\Users\DaveShephard\Dev\flooring-partners"

mkdir -p boot
mkdir -p .github/workflows
mkdir -p src/flooring_partners_apps
mkdir -p src/templates/registration
mkdir -p src/templates/errors
mkdir -p src/static/css
mkdir -p src/media
```

> **Path style note:** the `cp` commands below use Windows-style paths (`C:\Users\...`). Git Bash
> tolerates these, but if any `cp` reports "No such file or directory", switch that path to the
> MSYS form — `/c/Users/DaveShephard/Dev/kleen-tech-apps/src/accounts` — and retry.

---

## Step 2 — Copy the `accounts` app (code only, NOT migrations)

`accounts` provides `AppDefinition`, `CompanyProfile`, `UserProfile`, the `app_access_required`
decorator, and the admin panel. Verified: it imports nothing outside `django` and itself, so it
ports cleanly.

```bash
cd "C:\Users\DaveShephard\Dev\flooring-partners"

# Copy the whole app, then remove migrations and caches.
cp -r "C:\Users\DaveShephard\Dev\kleen-tech-apps\src\accounts" src/accounts

rm -rf src/accounts/migrations
rm -rf src/accounts/__pycache__
find src/accounts -name "__pycache__" -type d -exec rm -rf {} +
find src/accounts -name "*.pyc" -delete

mkdir -p src/accounts/migrations
touch src/accounts/migrations/__init__.py
```

Confirm you have these files under `src/accounts/`:
`__init__.py`, `admin.py`, `apps.py`, `decorators.py`, `forms.py`, `models.py`, `signals.py`,
`urls.py`, `views.py`, `migrations/__init__.py`, and `templates/accounts/` (7 html files).

### 2a. Rebrand the default company in `src/accounts/signals.py`

Change the one constant:

```python
DEFAULT_COMPANY_NAME = "Flooring Partners"
```

(It was `"Kleen-Tech"`.) This signal fires on superuser save and auto-creates the
`CompanyProfile` + `UserProfile` — which is why Phase 5 needs no manual profile step.

### 2b. Rebrand `src/accounts/templates/accounts/*.html`

There is **exactly one** occurrence across all 7 templates:

`src/accounts/templates/accounts/base_admin.html`, line 6:

| Find | Replace with |
|---|---|
| `<title>{% block title %}Admin Panel{% endblock %} \| Kleen-Tech Apps</title>` | `<title>{% block title %}Admin Panel{% endblock %} \| Flooring Partners Apps</title>` |

Leave all CSS variables and hex colors alone.

```bash
grep -rn "Kleen-Tech\|Kleen Tech\|kleentech\|kleen_tech" src/accounts/
# Expected after the edit: zero hits.
```

---

## Step 3 — Copy the project-level templates and rebrand

```bash
cd "C:\Users\DaveShephard\Dev\flooring-partners"

KT="C:\Users\DaveShephard\Dev\kleen-tech-apps\src\templates"

cp "$KT/app_hub.html"               src/templates/app_hub.html
cp "$KT/placeholder.html"           src/templates/placeholder.html
cp "$KT/registration/login.html"    src/templates/registration/login.html
cp "$KT/400.html" "$KT/403.html" "$KT/404.html" "$KT/500.html" src/templates/
cp "$KT/errors/_base_error.html"    src/templates/errors/_base_error.html

cp "C:\Users\DaveShephard\Dev\kleen-tech-apps\src\static\custom.css" src/static/custom.css
cp "C:\Users\DaveShephard\Dev\kleen-tech-apps\.gitattributes"        .gitattributes
```

> **On `custom.css`:** no template in either repo actually links it — all styling is inline
> `<style>` blocks. It's copied so `STATICFILES_DIRS` has something in it and as a home for future
> shared CSS. `collectstatic` still matters regardless, because Django admin needs it.

### 3a. Text-only rebrand of the templates

Make **only** these substitutions. Do not touch any `:root { ... }` block, any hex color, or any
font import — the theme must stay byte-identical to Kleen-Tech.

In `src/templates/app_hub.html`:

| Find | Replace with |
|---|---|
| `<title>Kleen-Tech Apps \| Hub</title>` | `<title>Flooring Partners Apps \| Hub</title>` |
| `<div class="brand-label">Kleen-Tech <span>Apps</span></div>` | `<div class="brand-label">Flooring Partners <span>Apps</span></div>` |
| `Select a demo app to launch.` | `Select an application to launch.` |

In `src/templates/registration/login.html` — exactly three occurrences, at lines 7, 270, and 335:

| Find | Replace with |
|---|---|
| `<title>Sign in \| Kleen-Tech Apps</title>` | `<title>Sign in \| Flooring Partners Apps</title>` |
| `<div class="brand">Kleen-Tech <span>Apps</span></div>` | `<div class="brand">Flooring Partners <span>Apps</span></div>` |
| `Kleen-Tech Applications.` | `Flooring Partners Applications.` |

In `src/templates/placeholder.html`:

| Find | Replace with |
|---|---|
| `<title>{{ app_name }} \| Kleen-Tech Apps</title>` | `<title>{{ app_name }} \| Flooring Partners Apps</title>` |

In `src/templates/errors/_base_error.html` — two occurrences, at lines 6 and 125:

| Find | Replace with |
|---|---|
| `<title>{% block title %}Error{% endblock %} \| Kleen-Tech Apps</title>` | `<title>{% block title %}Error{% endblock %} \| Flooring Partners Apps</title>` |
| `<div class="brand">Kleen-Tech <span>Apps</span></div>` | `<div class="brand">Flooring Partners <span>Apps</span></div>` |

Then verify:

```bash
grep -rn "Kleen-Tech\|Kleen Tech\|kleentech\|kleen_tech" src/templates/
# Expected: zero hits.
```

---

## Step 4 — `src/manage.py`

```python
#!/usr/bin/env python
"""Django's command-line utility for administrative tasks."""
import os
import sys


def main():
    """Run administrative tasks."""
    os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'flooring_partners_apps.settings')
    try:
        from django.core.management import execute_from_command_line
    except ImportError as exc:
        raise ImportError(
            "Couldn't import Django. Are you sure it's installed and "
            "available on your PYTHONPATH environment variable? Did you "
            "forget to activate a virtual environment?"
        ) from exc
    execute_from_command_line(sys.argv)


if __name__ == '__main__':
    main()
```

---

## Step 5 — `src/flooring_partners_apps/settings.py`

Create `src/flooring_partners_apps/__init__.py` (empty), then write `settings.py` with exactly
this content. This is a deliberately lean rewrite of the Kleen-Tech settings — no CKEditor,
no Django-Q, no Anthropic/Gemini/GovWin/Chroma, no GDAL.

```python
"""
Django settings for flooring_partners_apps project.

Lean scaffold for flooringpartners.portfolioapps.ai.
Patterned on kleen_tech_apps/settings.py, with the AI / scraper / geospatial
stacks removed and host configuration moved to environment variables.
"""

import os
from pathlib import Path

import dj_database_url
from dotenv import load_dotenv

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent.parent

TEMPLATES_DIR = BASE_DIR / "templates"

PROJECT_NAME = os.environ.get("PROJECT_NAME", "Flooring Partners Apps")

# ---------------------------------------------------------------------------
# Core security
# ---------------------------------------------------------------------------

SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY", "")

DEBUG = os.environ.get("DJANGO_DEBUG", "False") == "True"


def _csv_env(name: str, default: str = "") -> list[str]:
    """Read a comma-separated env var into a stripped list."""
    raw = os.environ.get(name, default)
    return [item.strip() for item in raw.split(",") if item.strip()]


# Env-driven so a domain change is a config change, not a code change.
ALLOWED_HOSTS = _csv_env(
    "DJANGO_ALLOWED_HOSTS",
    "flooringpartners.portfolioapps.ai,.railway.app,localhost,127.0.0.1",
)

CSRF_TRUSTED_ORIGINS = _csv_env(
    "DJANGO_CSRF_TRUSTED_ORIGINS",
    "https://flooringpartners.portfolioapps.ai,https://*.railway.app,http://127.0.0.1:8000",
)

if DEBUG:
    ALLOWED_HOSTS = ["*"]

CSRF_COOKIE_SECURE = not DEBUG
SESSION_COOKIE_SECURE = not DEBUG
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
SECURE_SSL_REDIRECT = not DEBUG

# Railway's internal healthcheck probe may not carry X-Forwarded-Proto. Exempt
# the probe path explicitly so SecurityMiddleware can't 301 it — Railway treats
# anything other than a 2xx as a failed healthcheck.
SECURE_REDIRECT_EXEMPT = [r"^healthz/?$"]

# ---------------------------------------------------------------------------
# Applications
# ---------------------------------------------------------------------------

INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "django.contrib.humanize",

    # User Defined Apps
    "accounts",

    # Third-party
    "storages",
]

if DEBUG:
    # Must come BEFORE django.contrib.staticfiles for WhiteNoise's runserver to
    # win the command-name collision. Appending (as kleen-tech does) is a no-op.
    INSTALLED_APPS.insert(0, "whitenoise.runserver_nostatic")

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "whitenoise.middleware.WhiteNoiseMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "flooring_partners_apps.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [TEMPLATES_DIR],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.debug",
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

WSGI_APPLICATION = "flooring_partners_apps.wsgi.application"

# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------

DATABASE_URL = os.environ.get("DATABASE_URL", "")

if DATABASE_URL:
    DATABASES = {"default": dj_database_url.config(default=DATABASE_URL)}
else:
    DATABASES = {
        "default": {
            "ENGINE": "django.db.backends.sqlite3",
            "NAME": BASE_DIR / "db.sqlite3",
        }
    }
    if not DEBUG:
        raise ValueError("DATABASE_URL must be set when DJANGO_DEBUG is not True.")

# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------

AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator"},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]

LOGIN_URL = "login"
LOGIN_REDIRECT_URL = "/apps/"
LOGOUT_REDIRECT_URL = "/"

# ---------------------------------------------------------------------------
# I18N / TZ
# ---------------------------------------------------------------------------

LANGUAGE_CODE = "en-us"
TIME_ZONE = os.environ.get("DJANGO_TIME_ZONE", "America/Los_Angeles")
USE_I18N = True
USE_TZ = True

# ---------------------------------------------------------------------------
# Static and media
# ---------------------------------------------------------------------------

STATIC_URL = "/static/"
STATIC_ROOT = BASE_DIR / "staticfiles"
STATICFILES_DIRS = [BASE_DIR / "static"]

MEDIA_ROOT = BASE_DIR / "media"
MEDIA_URL = "/media/"

AWS_ACCESS_KEY_ID = os.environ.get("AWS_ACCESS_KEY_ID", "")
AWS_SECRET_ACCESS_KEY = os.environ.get("AWS_SECRET_ACCESS_KEY", "")
AWS_STORAGE_BUCKET_NAME = os.environ.get("AWS_STORAGE_BUCKET_NAME", "")
AWS_S3_REGION_NAME = os.environ.get("AWS_S3_REGION_NAME", "us-west-2")

AWS_DEFAULT_ACL = None
AWS_QUERYSTRING_AUTH = True
AWS_QUERYSTRING_EXPIRE = 3600
AWS_S3_FILE_OVERWRITE = False
AWS_S3_SIGNATURE_VERSION = "s3v4"
AWS_S3_ADDRESSING_STYLE = "virtual"
AWS_S3_OBJECT_PARAMETERS = {"CacheControl": "max-age=86400"}

# Use S3 only when a bucket is actually configured. Phase 1 uploads nothing,
# so the local filesystem backend is correct until the Org View port.
_USE_S3 = bool(AWS_STORAGE_BUCKET_NAME) and not DEBUG

STORAGES = {
    "default": {
        "BACKEND": (
            "storages.backends.s3boto3.S3Boto3Storage"
            if _USE_S3
            else "django.core.files.storage.FileSystemStorage"
        ),
    },
    "staticfiles": {
        "BACKEND": "whitenoise.storage.CompressedStaticFilesStorage",
    },
}

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

# ---------------------------------------------------------------------------
# Email
# ---------------------------------------------------------------------------

EMAIL_BACKEND = "django.core.mail.backends.smtp.EmailBackend"
EMAIL_HOST = os.environ.get("EMAIL_HOST", "")
EMAIL_PORT = int(os.environ.get("EMAIL_PORT", "587"))
EMAIL_HOST_USER = os.environ.get("EMAIL_HOST_USER", "")
EMAIL_HOST_PASSWORD = os.environ.get("EMAIL_HOST_PASSWORD", "")
EMAIL_USE_TLS = os.environ.get("EMAIL_USE_TLS", "True") == "True"
EMAIL_USE_SSL = os.environ.get("EMAIL_USE_SSL", "False") == "True"

# Nothing in the Phase 1 codebase sends mail, so leaving EMAIL_* unset is fine.
# Fall back to Django's defaults rather than empty strings if no SMTP user is set.
SERVER_EMAIL = EMAIL_HOST_USER or "root@localhost"
DEFAULT_FROM_EMAIL = EMAIL_HOST_USER or "webmaster@localhost"

ADMIN_USER_NAME = os.environ.get("ADMIN_USER_NAME", "Admin user")
ADMIN_USER_EMAIL = os.environ.get("ADMIN_USER_EMAIL", "")

ADMINS = []
MANAGERS = []
if ADMIN_USER_NAME and ADMIN_USER_EMAIL:
    ADMINS = [(ADMIN_USER_NAME, ADMIN_USER_EMAIL)]
    MANAGERS = ADMINS

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {
        "verbose": {
            "format": "[{asctime}] {levelname} {name}: {message}",
            "style": "{",
        },
    },
    "handlers": {
        "console": {
            "class": "logging.StreamHandler",
            "formatter": "verbose",
        },
    },
    "root": {
        "handlers": ["console"],
        "level": "INFO",
    },
    "loggers": {
        "django.request": {
            "handlers": ["console"],
            "level": "WARNING",
            "propagate": False,
        },
    },
}
```

> **Note on `SECURE_SSL_REDIRECT`:** this is `True` in production. Combined with
> `SECURE_PROXY_SSL_HEADER` it is safe behind Railway's proxy, which sets
> `X-Forwarded-Proto: https` on real traffic. The `/healthz/` path is exempted explicitly via
> `SECURE_REDIRECT_EXEMPT`, because Railway's *internal* healthcheck probe doesn't reliably set
> that header and a 301 counts as a failed healthcheck. If you ever see a redirect loop on any
> other path, `SECURE_SSL_REDIRECT` is the first setting to look at.

---

## Step 6 — `src/flooring_partners_apps/wsgi.py` and `asgi.py`

`wsgi.py`:

```python
"""
WSGI config for flooring_partners_apps project.
"""

import os

from django.core.wsgi import get_wsgi_application

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "flooring_partners_apps.settings")

application = get_wsgi_application()
```

`asgi.py`:

```python
"""
ASGI config for flooring_partners_apps project.
"""

import os

from django.core.asgi import get_asgi_application

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "flooring_partners_apps.settings")

application = get_asgi_application()
```

---

## Step 7 — `src/flooring_partners_apps/views.py`

Same three views as Kleen-Tech, plus a `healthz` endpoint for the Railway healthcheck.

```python
# flooring_partners_apps/views.py
from django.contrib.auth import logout
from django.contrib.auth.decorators import login_required
from django.http import JsonResponse
from django.shortcuts import redirect, render

from accounts.models import AppDefinition, UserProfile


SECTION_META = {
    "administrative": {
        "title": "Administrative",
        "description": "Internal operations, HR, finance admin, and corporate tooling.",
    },
    "commercial_sales": {
        "title": "Commercial & Sales",
        "description": "Pipeline, proposals, and customer-facing tools.",
    },
    "business_performance": {
        "title": "Business Performance and Reporting",
        "description": "Dashboards, KPIs, and operational reporting.",
    },
}

SECTION_ORDER = ["administrative", "commercial_sales", "business_performance"]


def healthz(request):
    """Liveness probe for Railway. No DB access, no auth, always cheap."""
    return JsonResponse({"status": "ok"})


def logout_view(request):
    """Log the user out and redirect to the login page. Accepts GET so a plain <a> works."""
    logout(request)
    return redirect("login")


@login_required
def app_hub(request):
    """App hub: grid of available apps grouped by section, scoped by the user's role."""
    try:
        profile = request.user.profile
        if profile.role == "superadmin":
            apps = AppDefinition.objects.filter(is_active=True).order_by("display_order")
        else:
            apps = profile.assigned_apps.filter(is_active=True).order_by("display_order")
        is_admin = profile.role in ("superadmin", "company_admin")
    except UserProfile.DoesNotExist:
        apps = AppDefinition.objects.none()
        is_admin = False

    sections = []
    for section_key in SECTION_ORDER:
        section_apps = [a for a in apps if a.section == section_key]
        if section_apps:
            sections.append({**SECTION_META[section_key], "apps": section_apps})

    return render(request, "app_hub.html", {"sections": sections, "is_admin": is_admin})


@login_required
def placeholder_app(request, app_name, section):
    """Generic 'Coming Soon' page for apps that are not built yet."""
    return render(request, "placeholder.html", {"app_name": app_name, "section": section})
```

---

## Step 8 — `src/flooring_partners_apps/urls.py`

```python
# flooring_partners_apps/urls.py
from django.conf import settings
from django.conf.urls.static import static
from django.contrib import admin
from django.contrib.auth import views as auth_views
from django.urls import include, path

from .views import app_hub, healthz, logout_view, placeholder_app

urlpatterns = [
    # Landing page = login
    path(
        "",
        auth_views.LoginView.as_view(template_name="registration/login.html"),
        name="login",
    ),
    path("logout/", logout_view, name="logout"),

    # Health probe for Railway
    path("healthz/", healthz, name="healthz"),

    # App hub
    path("apps/", app_hub, name="app_hub"),

    # Org View — placeholder until the real app is ported (see 06-org-view-port-plan.md).
    # When the real app lands, replace this line with:
    #     path("org-view/", include("org_view.urls")),
    path(
        "org-view/",
        placeholder_app,
        {"app_name": "Org View", "section": "Business Performance and Reporting"},
        name="org_view_placeholder",
    ),

    # Admin panel (custom accounts admin views)
    path("admin-panel/", include("accounts.urls")),

    # Django admin
    path("admin/", admin.site.urls),
] + static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)
```

---

## Step 9 — Migrations: fresh `0001_initial` plus an `AppDefinition` seed

> ### ⚠ RUN THIS STEP LAST, after Steps 10 through 19.
>
> It has two hard prerequisites:
> - **Step 10** must be done — `requirements.txt` has to exist to install from.
> - **Step 16** must be done — without a `.env` setting `DJANGO_DEBUG=True`, `settings.py` sees
>   `DEBUG=False` and an empty `DATABASE_URL`, and raises
>   `ValueError: DATABASE_URL must be set when DJANGO_DEBUG is not True.` Both `makemigrations`
>   commands below will die on that.
>
> Verify before starting:
> ```bash
> cd "C:\Users\DaveShephard\Dev\flooring-partners"
> test -f requirements.txt && test -f .env && grep -q "DJANGO_DEBUG=True" .env \
>   && echo "OK — prerequisites met" \
>   || echo "STOP — complete Steps 10 and 16 first"
> ```

### 9a. Generate the initial migration

```bash
cd "C:\Users\DaveShephard\Dev\flooring-partners"
python -m venv .venv
source .venv/Scripts/activate          # Git Bash on Windows
# PowerShell: .\.venv\Scripts\Activate.ps1
pip install --upgrade pip
pip install -r requirements.txt

cd src
# Belt-and-braces: force DEBUG on for this shell even if .env is missed.
export DJANGO_DEBUG=True
export DJANGO_SECRET_KEY=local-scaffold-only

python manage.py makemigrations accounts -n initial
```

Expected: `src/accounts/migrations/0001_initial.py` creating `AppDefinition`, `CompanyProfile`,
and `UserProfile`.

### 9b. Seed the Org View card

```bash
python manage.py makemigrations accounts -n seed_app_definitions --empty
```

Write the generated file (it will be `0002_seed_app_definitions.py`) as:

```python
from django.db import migrations


def seed_apps(apps, schema_editor):
    AppDefinition = apps.get_model("accounts", "AppDefinition")

    AppDefinition.objects.update_or_create(
        slug="org-view",
        defaults={
            "name": "Org View",
            "description": (
                "Upload an employee census and explore the Flooring Partners "
                "organization chart, headcount, and cost structure."
            ),
            "url_name": "org_view_placeholder",
            "section": "business_performance",
            "section_description": "Dashboards, KPIs, and operational reporting.",
            "status": "coming_soon",
            "is_active": True,
            "display_order": 10,
        },
    )


def unseed_apps(apps, schema_editor):
    AppDefinition = apps.get_model("accounts", "AppDefinition")
    AppDefinition.objects.filter(slug="org-view").delete()


class Migration(migrations.Migration):

    dependencies = [
        ("accounts", "0001_initial"),
    ]

    operations = [
        migrations.RunPython(seed_apps, unseed_apps),
    ]
```

> **Why `update_or_create` and not `all().delete()` + `create()`:** the Kleen-Tech seed migration
> wipes the whole `AppDefinition` table first. That's fine on a fresh DB and destructive forever
> after. `update_or_create` on the slug is idempotent and safe to re-run.
>
> **Why `url_name="org_view_placeholder"`:** the hub template resolves `{% url app.url_name %}`.
> Pointing at the placeholder route means the card is clickable and gives you a real page to load
> as a deploy smoke test. When the real app is ported, change this value to `org_view:index` in a
> new migration.

---

## Step 10 — `requirements.txt` (repo root)

```
asgiref==3.9.0
Django==5.2.4
gunicorn==23.0.0
packaging==25.0
python-dotenv==1.1.1
sqlparse==0.5.3
tzdata==2025.2

dj-database-url==3.0.1
psycopg[binary]==3.3.2
whitenoise==6.9.0

boto3==1.42.7
botocore==1.42.7
django-storages==1.14.6
s3transfer==0.16.0
urllib3==2.3.0

pillow==12.0.0
python-dateutil==2.9.0.post0
requests==2.32.5

# Needed by the Org View census parser (Phase 6). Pinned now so the
# image doesn't change when that app lands.
openpyxl==3.1.5
```

Versions are pinned to match `kleen-tech-apps` so both deployments stay in lockstep.
Deliberately **excluded**: `django-ckeditor-5`, `django-import-export`, `django-q2`, `croniter`,
`anthropic`, `chromadb`, `playwright`, `patchright`, `2captcha-python`, `cryptography`,
`pdfplumber`, `pypdf`, `python-docx`, `docx2txt`, `xhtml2pdf`, `mammoth`, `shapely`, `geopandas`,
`pyproj`, `overturemaps`, `google-genai`, `h3`, `k-means-constrained`, `python-decouple`.

---

## Step 11 — `Dockerfile` (repo root)

Much smaller than the Kleen-Tech web image: no Cairo, no GDAL, no LibreOffice.

```dockerfile
# Web service image for flooringpartners.portfolioapps.ai
ARG PYTHON_VERSION=3.12-slim-bookworm
FROM python:${PYTHON_VERSION}

# Create virtualenv
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Python settings
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

# OS dependencies — minimal. psycopg[binary] and pillow ship wheels, so
# gcc/libpq-dev are only here as a safety net for source builds.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq-dev \
    gcc \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /code

COPY requirements.txt /tmp/requirements.txt
RUN pip install --upgrade pip && pip install -r /tmp/requirements.txt

COPY ./src /code

COPY ./boot/docker-run.sh /opt/docker-run.sh
RUN chmod +x /opt/docker-run.sh

CMD ["/opt/docker-run.sh"]
```

---

## Step 12 — `boot/docker-run.sh`

> **Must be LF line endings.** The `.gitattributes` copied in Step 3 enforces this. CRLF makes the
> shebang unusable inside the Linux container and the deploy fails with "no such file or directory".

```bash
#!/bin/bash
set -e

source /opt/venv/bin/activate
cd /code

python manage.py collectstatic --no-input
python manage.py migrate --no-input

# Idempotent superuser bootstrap. No-op unless DJANGO_SUPERUSER_* are set,
# and no-op if the user already exists. Never fails the boot.
python manage.py bootstrap_admin || echo "warning: bootstrap_admin failed (continuing)"

HOST=${HOST:-0.0.0.0}
PORT=${PORT:-8080}

exec gunicorn flooring_partners_apps.wsgi:application \
  --bind "$HOST:$PORT" \
  --timeout 120 \
  --workers 1 \
  --threads 8 \
  --max-requests 500 \
  --max-requests-jitter 50
```

```bash
chmod +x boot/docker-run.sh
```

---

## Step 13 — `bootstrap_admin` management command

Create `src/accounts/management/__init__.py`, `src/accounts/management/commands/__init__.py`
(both empty), then `src/accounts/management/commands/bootstrap_admin.py`:

```python
"""Create the initial superuser non-interactively from environment variables.

Idempotent and safe to run on every container boot:
  - no-op if DJANGO_SUPERUSER_USERNAME or DJANGO_SUPERUSER_PASSWORD are unset
  - no-op if a user with that username already exists

Saving a superuser fires accounts.signals.ensure_superuser_profile, which creates
the "Flooring Partners" CompanyProfile and a superadmin UserProfile. So this one
command is all that's needed to get a working hub login.
"""
import os

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand


class Command(BaseCommand):
    help = "Create the initial superuser from DJANGO_SUPERUSER_* environment variables."

    def handle(self, *args, **options):
        username = os.environ.get("DJANGO_SUPERUSER_USERNAME", "").strip()
        email = os.environ.get("DJANGO_SUPERUSER_EMAIL", "").strip()
        password = os.environ.get("DJANGO_SUPERUSER_PASSWORD", "")

        if not username or not password:
            self.stdout.write(
                "bootstrap_admin: DJANGO_SUPERUSER_USERNAME / "
                "DJANGO_SUPERUSER_PASSWORD not set — skipping."
            )
            return

        User = get_user_model()

        if User.objects.filter(username=username).exists():
            self.stdout.write(f"bootstrap_admin: user '{username}' already exists — skipping.")
            return

        User.objects.create_superuser(username=username, email=email, password=password)
        self.stdout.write(self.style.SUCCESS(f"bootstrap_admin: created superuser '{username}'."))
```

---

## Step 14 — `railway.json` (repo root)

Committed so the service config is reproducible instead of living only in the Railway UI.

```json
{
  "$schema": "https://railway.com/railway.schema.json",
  "build": {
    "builder": "DOCKERFILE",
    "dockerfilePath": "Dockerfile"
  },
  "deploy": {
    "healthcheckPath": "/healthz/",
    "healthcheckTimeout": 120,
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 3,
    "numReplicas": 1
  }
}
```

---

## Step 15 — `.gitignore` (repo root)

```gitignore
# Environment
.env
.env.*
!.env.example

# Python
__pycache__/
*.py[cod]
*$py.class
*.so
.Python
build/
dist/
*.egg-info/
.pytest_cache/
.mypy_cache/
.ruff_cache/

# Virtualenvs
.venv/
venv/
env/

# Django
db.sqlite3
db.sqlite3-journal
/src/staticfiles/
/src/media/
*.log

# OS / editor
.DS_Store
Thumbs.db
.idea/
*.swp

# Data dumps
*.sql
*.dump
backups/
```

---

## Step 16 — `.env` for local development (NOT committed)

**Location: the repo root** — `C:\Users\DaveShephard\Dev\flooring-partners\.env`, *not* inside
`src/`. `load_dotenv()` walks up from `src/flooring_partners_apps/settings.py` to find it, and this
matches where `kleen-tech-apps` keeps its own.

```dotenv
DJANGO_SETTINGS_MODULE=flooring_partners_apps.settings
DJANGO_SECRET_KEY=dev-only-not-a-real-secret-change-me
DJANGO_DEBUG=True
PROJECT_NAME=Flooring Partners Apps
DJANGO_TIME_ZONE=America/Los_Angeles

# Leave DATABASE_URL empty locally to use SQLite.
DATABASE_URL=

DJANGO_SUPERUSER_USERNAME=dshephard
DJANGO_SUPERUSER_EMAIL=dshephard@rainierpartners.com
DJANGO_SUPERUSER_PASSWORD=change-me-locally

# Optional — SMTP. Nothing in Phase 1 sends mail, so leave these unset.
# EMAIL_HOST=
# EMAIL_PORT=587
# EMAIL_HOST_USER=
# EMAIL_HOST_PASSWORD=
# EMAIL_USE_TLS=True
# EMAIL_USE_SSL=False
```

Also commit a `.env.example` at the repo root with the same keys, all values blank **except**
`DJANGO_DEBUG=True` — a blank `DJANGO_DEBUG` makes `cp .env.example .env` produce a config that
refuses to start.

The full set of environment variables `settings.py` reads, for reference:

| Variable | Required? | Notes |
|---|---|---|
| `DJANGO_SECRET_KEY` | **yes** | |
| `DJANGO_DEBUG` | yes in dev | `True` locally, `False` in Railway |
| `DATABASE_URL` | yes in prod | Empty locally → SQLite |
| `DJANGO_ALLOWED_HOSTS` | prod only | Falls back to a sensible default |
| `DJANGO_CSRF_TRUSTED_ORIGINS` | prod only | Falls back to a sensible default |
| `DJANGO_TIME_ZONE` | no | Default `America/Los_Angeles` |
| `PROJECT_NAME` | no | Default `Flooring Partners Apps` |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_STORAGE_BUCKET_NAME` / `AWS_S3_REGION_NAME` | no | Unset until the Org View port; storage falls back to the filesystem |
| `EMAIL_HOST` / `EMAIL_PORT` / `EMAIL_HOST_USER` / `EMAIL_HOST_PASSWORD` / `EMAIL_USE_TLS` / `EMAIL_USE_SSL` | no | Nothing sends mail in Phase 1 |
| `ADMIN_USER_NAME` / `ADMIN_USER_EMAIL` | no | Populates `ADMINS`/`MANAGERS` |
| `DJANGO_SUPERUSER_USERNAME` / `DJANGO_SUPERUSER_EMAIL` / `DJANGO_SUPERUSER_PASSWORD` | first boot only | Read by `bootstrap_admin`, not by `settings.py` |
| `DJANGO_SETTINGS_MODULE` | no | `manage.py` and `wsgi.py` `setdefault` it; setting it in Railway is belt-and-braces |

---

## Step 17 — `.github/workflows/django.yml`

Trimmed from the Kleen-Tech workflow: no Cairo system dependency, and it runs against SQLite so
it needs no repository secrets to pass.

```yaml
name: Django CI

on:
  push:
    branches: [ "main", "dev" ]
  pull_request:
    branches: [ "main", "dev" ]

jobs:
  build:
    runs-on: ubuntu-latest
    strategy:
      max-parallel: 4
      matrix:
        python-version: ["3.12"]

    steps:
    - uses: actions/checkout@v4.2.2

    - name: Set up Python ${{ matrix.python-version }}
      uses: actions/setup-python@v5
      with:
        python-version: ${{ matrix.python-version }}

    - name: Install dependencies
      run: |
        python -m pip install --upgrade pip
        pip install -r requirements.txt

    - name: Django system check
      working-directory: src
      env:
        DJANGO_DEBUG: "True"
        DJANGO_SECRET_KEY: "ci-only-secret-key"
      run: python manage.py check

    - name: Run migrations
      working-directory: src
      env:
        DJANGO_DEBUG: "True"
        DJANGO_SECRET_KEY: "ci-only-secret-key"
      run: python manage.py migrate --no-input

    - name: Run tests
      working-directory: src
      env:
        DJANGO_DEBUG: "True"
        DJANGO_SECRET_KEY: "ci-only-secret-key"
      run: python manage.py test
```

---

## Step 18 — `CLAUDE.md` (repo root)

Same guardrail as the other two repos:

```markdown
When invoked via Cowork (desktop), do NOT modify source code files directly. You may:
- Review code and suggest changes
- Draft documentation, READMEs, and comments
- Analyze architecture and propose plans

Code modifications should only be made through Claude Code CLI with direct filesystem access.
For recommended changes, please write as instructions that I can cut and paste or saved as .md
files in the instructions folder that I can pass along to Claude Code in the terminal window to
execute.
```

---

## Step 19 — `README.md` (repo root)

```markdown
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
```

---

## Step 20 — Local verification

```bash
cd "C:\Users\DaveShephard\Dev\flooring-partners"
source .venv/Scripts/activate
cd src

python manage.py check
# Expected: System check identified no issues (0 silenced).

python manage.py migrate
# Expected: accounts 0001_initial and 0002_seed_app_definitions applied.

python manage.py bootstrap_admin
# Expected: bootstrap_admin: created superuser 'dshephard'.

python manage.py shell -c "from accounts.models import AppDefinition, CompanyProfile, UserProfile; print(list(AppDefinition.objects.values_list('slug','section','status'))); print(list(CompanyProfile.objects.values_list('name', flat=True))); print(list(UserProfile.objects.values_list('user__username','role')))"
# Expected:
#   [('org-view', 'business_performance', 'coming_soon')]
#   ['Flooring Partners']
#   [('dshephard', 'superadmin')]

python manage.py runserver 8000
```

Then in a browser:

- [ ] `http://127.0.0.1:8000/` — login page, title "Sign in | Flooring Partners Apps", dark/gold theme
- [ ] Log in as `dshephard` → redirected to `/apps/`
- [ ] Hub header reads "Flooring Partners Apps" / "Choose a workspace"
- [ ] One section: "Business Performance and Reporting" with one **Org View** card, badge "Coming Soon"
- [ ] Clicking the card → `/org-view/` placeholder page with a working "Back to App Hub" link
- [ ] User dropdown → "Admin Panel" opens `/admin-panel/`, "Log out" returns to `/`
- [ ] `http://127.0.0.1:8000/healthz/` → `{"status": "ok"}`
- [ ] `http://127.0.0.1:8000/admin/` → Django admin, `AppDefinition` / `CompanyProfile` / `UserProfile` registered

## Done check

```bash
cd "C:\Users\DaveShephard\Dev\flooring-partners"
grep -rn "kleen\|Kleen\|rainier\|Rainier" --include="*.py" --include="*.html" --include="*.sh" --include="*.json" --include="*.md" --include="Dockerfile" src/ boot/ Dockerfile railway.json README.md
# Expected: zero hits outside instructions/ (where the reference deployments are named on purpose).
```

Do **not** commit yet — Phase 2 handles git init and the first push.
