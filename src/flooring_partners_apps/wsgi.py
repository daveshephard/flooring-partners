"""
WSGI config for flooring_partners_apps project.
"""

import os

from django.core.wsgi import get_wsgi_application

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "flooring_partners_apps.settings")

application = get_wsgi_application()
