from django.contrib import admin

from .models import AppDefinition, CompanyProfile, UserProfile


@admin.register(AppDefinition)
class AppDefinitionAdmin(admin.ModelAdmin):
    list_display = ["name", "slug", "section", "status", "is_active", "display_order"]
    list_filter = ["section", "status", "is_active"]
    prepopulated_fields = {"slug": ["name"]}


@admin.register(CompanyProfile)
class CompanyProfileAdmin(admin.ModelAdmin):
    list_display = ["name", "is_active", "created_at"]
    filter_horizontal = ["available_apps"]


@admin.register(UserProfile)
class UserProfileAdmin(admin.ModelAdmin):
    list_display = ["user", "company", "role", "is_active", "created_at"]
    list_filter = ["role", "company", "is_active"]
    filter_horizontal = ["assigned_apps"]
