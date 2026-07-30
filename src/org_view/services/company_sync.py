"""Keep OrgView's Company list in step with the accounts app.

OrgView has its own ``Company`` table (URLs/permissions/snapshots hang off it),
distinct from ``accounts.CompanyProfile``. This module is the single sync path
used by both the ``sync_org_view_companies`` command (initial backfill) and the
``post_save`` signal on ``CompanyProfile`` (going forward), so a company added in
the admin panel automatically appears in OrgView (e.g. the census-upload dropdown).

Match is by slug (``slugify(name)``). Purely additive: missing rows are created;
existing OrgView companies are left untouched (so a row manually deactivated in
OrgView stays that way).
"""
import logging

from django.utils.text import slugify

logger = logging.getLogger(__name__)


def ensure_org_view_company(name: str, *, is_active: bool = True):
    """Create an ``org_view.Company`` for ``name`` if one doesn't exist.

    Returns ``(company, created)``. No-op (returns the existing row) when a
    company with the same slug is already present.
    """
    from ..models import Company

    name = (name or "").strip()
    if not name:
        return None, False
    slug = slugify(name)
    if not slug:
        return None, False
    company, created = Company.objects.get_or_create(
        slug=slug, defaults={"name": name, "is_active": is_active},
    )
    return company, created


def sync_from_accounts(*, dry_run: bool = False):
    """Ensure every active ``CompanyProfile`` has a matching OrgView company.

    Returns ``(created_names, existing_names)``. Idempotent — safe to re-run.
    """
    from accounts.models import CompanyProfile

    created, existing = [], []
    for cp in CompanyProfile.objects.filter(is_active=True).order_by("name"):
        if dry_run:
            from ..models import Company
            if Company.objects.filter(slug=slugify(cp.name)).exists():
                existing.append(cp.name)
            else:
                created.append(cp.name)
            continue
        _, was_created = ensure_org_view_company(cp.name, is_active=True)
        (created if was_created else existing).append(cp.name)
    return created, existing
