from django.contrib import admin

from .models import (
    AppPermission, CensusSnapshot, Company, Employee, Scenario, ScenarioPosition,
)


@admin.register(Company)
class CompanyAdmin(admin.ModelAdmin):
    list_display  = ("name", "is_active", "created_at")
    search_fields = ("name",)
    prepopulated_fields = {"slug": ("name",)}


@admin.register(CensusSnapshot)
class CensusSnapshotAdmin(admin.ModelAdmin):
    list_display  = ("company", "label", "effective_date", "upload_date", "employee_count", "is_current", "status")
    list_filter   = ("company", "status", "is_current")
    list_editable = ("is_current",)


@admin.register(Employee)
class EmployeeAdmin(admin.ModelAdmin):
    list_display  = ("full_name", "employee_id", "job_title", "management_level", "snapshot")
    list_filter   = ("snapshot", "management_level")
    search_fields = ("first_name", "last_name", "employee_id")

    def full_name(self, obj):
        return obj.full_name
    full_name.short_description = "Name"


@admin.register(AppPermission)
class AppPermissionAdmin(admin.ModelAdmin):
    list_display = ("user", "company", "role", "is_active")
    list_filter  = ("company", "role")


@admin.register(Scenario)
class ScenarioAdmin(admin.ModelAdmin):
    list_display  = ("name", "company", "base_snapshot", "status", "created_by", "updated_at")
    list_filter   = ("company", "status")
    search_fields = ("name",)


@admin.register(ScenarioPosition)
class ScenarioPositionAdmin(admin.ModelAdmin):
    list_display  = ("full_name", "employee_id", "job_title", "change_type", "is_vacant", "scenario")
    list_filter   = ("scenario", "change_type", "is_vacant")
    search_fields = ("first_name", "last_name", "employee_id", "job_title")
