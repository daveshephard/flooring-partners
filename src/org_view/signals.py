"""Auto-sync OrgView companies when the accounts app changes.

A ``CompanyProfile`` saved as active gets a matching ``org_view.Company`` created
if one doesn't exist yet, so newly-added companies show up in OrgView (census
upload, permissions) without a manual step. Never blocks the CompanyProfile save.
"""
import logging

from django.db.models.signals import post_save
from django.dispatch import receiver

from accounts.models import CompanyProfile

from .services.company_sync import ensure_org_view_company

logger = logging.getLogger(__name__)


@receiver(post_save, sender=CompanyProfile, dispatch_uid="org_view_sync_company")
def sync_company_to_org_view(sender, instance, **kwargs):
    if not instance.is_active:
        return
    try:
        ensure_org_view_company(instance.name, is_active=True)
    except Exception:  # noqa: BLE001 — a sync hiccup must never fail the save.
        logger.exception("Failed to sync CompanyProfile '%s' to org_view.Company", instance.name)
