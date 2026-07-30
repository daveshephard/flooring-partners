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
