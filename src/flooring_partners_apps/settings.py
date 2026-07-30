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

# Railway's internal healthcheck probe always sends Host: healthcheck.railway.app,
# independent of DJANGO_ALLOWED_HOSTS. It's a platform invariant, not a domain
# choice, so bake it in — otherwise a trimmed env var 400s the probe and the
# deploy never goes healthy (CommonMiddleware.get_host() raises DisallowedHost
# on every path, before the /healthz/ SSL exemption can even apply).
if "healthcheck.railway.app" not in ALLOWED_HOSTS:
    ALLOWED_HOSTS.append("healthcheck.railway.app")

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
    "org_view",

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

# Accept both the django-storages setting names and the boto3 / AWS-CLI-standard
# names that Railway's bucket service injects (AWS_S3_BUCKET_NAME,
# AWS_ENDPOINT_URL, AWS_DEFAULT_REGION), so the bucket's own variables work as-is
# without renaming anything in Railway.
AWS_STORAGE_BUCKET_NAME = (
    os.environ.get("AWS_STORAGE_BUCKET_NAME")
    or os.environ.get("AWS_S3_BUCKET_NAME", "")
)
AWS_S3_REGION_NAME = (
    os.environ.get("AWS_S3_REGION_NAME")
    or os.environ.get("AWS_DEFAULT_REGION")
    or "us-east-1"
)

# Custom S3 endpoint. Set for any S3-compatible object store that isn't AWS
# itself — e.g. Railway's bucket / MinIO. Empty → real AWS S3.
AWS_S3_ENDPOINT_URL = (
    os.environ.get("AWS_S3_ENDPOINT_URL")
    or os.environ.get("AWS_ENDPOINT_URL")
    or None
)

AWS_DEFAULT_ACL = None
AWS_QUERYSTRING_AUTH = True
AWS_QUERYSTRING_EXPIRE = 3600
AWS_S3_FILE_OVERWRITE = False
AWS_S3_SIGNATURE_VERSION = "s3v4"
# MinIO / Railway buckets serve on a single host and need path-style URLs
# (https://endpoint/bucket/key); real AWS uses virtual-hosted style.
AWS_S3_ADDRESSING_STYLE = "path" if AWS_S3_ENDPOINT_URL else "virtual"
AWS_S3_OBJECT_PARAMETERS = {"CacheControl": "max-age=86400"}

# Use S3 whenever a bucket is configured (works in DEBUG too, so the upload
# path can be exercised locally against the same bucket). No bucket name set
# → local filesystem storage, which is the right default for dev.
_USE_S3 = bool(AWS_STORAGE_BUCKET_NAME)

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
