from django.conf import settings
from django.db.models.signals import post_save
from django.dispatch import receiver

from .models import CompanyProfile, UserProfile

DEFAULT_COMPANY_NAME = "Flooring Partners"


@receiver(post_save, sender=settings.AUTH_USER_MODEL)
def ensure_superuser_profile(sender, instance, **kwargs):
    if not instance.is_superuser:
        return
    if UserProfile.objects.filter(user=instance).exists():
        return
    company, _ = CompanyProfile.objects.get_or_create(name=DEFAULT_COMPANY_NAME)
    UserProfile.objects.create(
        user=instance,
        company=company,
        role=UserProfile.Role.SUPERADMIN,
    )
