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
