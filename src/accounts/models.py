from django.contrib.auth.models import User
from django.db import models


class AppDefinition(models.Model):
    class Section(models.TextChoices):
        ADMINISTRATIVE = "administrative", "Administrative"
        COMMERCIAL_SALES = "commercial_sales", "Commercial & Sales"
        BUSINESS_PERFORMANCE = "business_performance", "Business Performance and Reporting"

    class Status(models.TextChoices):
        AVAILABLE = "available", "Available"
        COMING_SOON = "coming_soon", "Coming Soon"
        BETA = "beta", "Beta"

    name = models.CharField(max_length=100, unique=True)
    slug = models.SlugField(unique=True)
    description = models.TextField(blank=True)
    url_name = models.CharField(max_length=100)
    section = models.CharField(max_length=30, choices=Section.choices)
    section_description = models.TextField(blank=True)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.AVAILABLE)
    is_active = models.BooleanField(default=True)
    display_order = models.IntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return self.name

    class Meta:
        ordering = ["display_order", "name"]


class CompanyProfile(models.Model):
    name = models.CharField(max_length=200, unique=True)
    available_apps = models.ManyToManyField(AppDefinition, blank=True, related_name="companies")
    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return self.name

    class Meta:
        ordering = ["name"]


class UserProfile(models.Model):
    class Role(models.TextChoices):
        SUPERADMIN = "superadmin", "Superadmin"
        COMPANY_ADMIN = "company_admin", "Company Admin"
        USER = "user", "User"

    user = models.OneToOneField(User, on_delete=models.CASCADE, related_name="profile")
    company = models.ForeignKey(CompanyProfile, on_delete=models.CASCADE, related_name="members")
    role = models.CharField(max_length=20, choices=Role.choices, default=Role.USER)
    assigned_apps = models.ManyToManyField(AppDefinition, blank=True, related_name="users")
    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return f"{self.user.username} ({self.get_role_display()})"

    class Meta:
        ordering = ["user__username"]
