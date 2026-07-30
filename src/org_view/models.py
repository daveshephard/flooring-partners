from django.conf import settings
from django.db import models


class Company(models.Model):
    name = models.CharField(max_length=200)
    slug = models.SlugField(unique=True)
    description = models.TextField(blank=True)
    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name_plural = "companies"
        ordering = ["name"]

    def __str__(self):
        return self.name


class CensusSnapshot(models.Model):
    class Status(models.TextChoices):
        PROCESSING = "processing", "Processing"
        ACTIVE     = "active",     "Active"
        ARCHIVED   = "archived",   "Archived"

    company           = models.ForeignKey(Company, on_delete=models.CASCADE, related_name="snapshots")
    label             = models.CharField(max_length=100, blank=True)
    uploaded_by       = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True)
    upload_date       = models.DateTimeField(auto_now_add=True)
    effective_date    = models.DateField(
        null=True, blank=True,
        help_text="The date this census data represents (e.g., end of quarter).",
    )
    is_current        = models.BooleanField(
        default=False,
        help_text="The active snapshot used for the org chart. Only one per company.",
    )
    original_filename = models.CharField(max_length=255)
    file              = models.FileField(upload_to="census_uploads/", blank=True)
    employee_count    = models.IntegerField(default=0)
    warnings_count    = models.IntegerField(default=0)
    column_mapping    = models.JSONField(default=dict)
    status            = models.CharField(max_length=20, choices=Status.choices, default=Status.PROCESSING)
    notes             = models.TextField(blank=True)

    class Meta:
        ordering = ["-effective_date", "-upload_date"]
        get_latest_by = "effective_date"

    def __str__(self):
        label = f" — {self.label}" if self.label else ""
        dt = self.effective_date or self.upload_date.date()
        return f"{self.company.name}{label} ({dt})"

    def save(self, *args, **kwargs):
        if self.is_current:
            CensusSnapshot.objects.filter(
                company=self.company, is_current=True,
            ).exclude(pk=self.pk).update(is_current=False)
        super().save(*args, **kwargs)


class Employee(models.Model):
    snapshot         = models.ForeignKey(CensusSnapshot, on_delete=models.CASCADE, related_name="employees")
    employee_id      = models.CharField(max_length=50)
    first_name       = models.CharField(max_length=100)
    last_name        = models.CharField(max_length=100)
    raw_supervisor_id = models.CharField(max_length=50, blank=True, null=True)
    supervisor       = models.ForeignKey(
        "self",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="direct_reports",
    )
    job_title        = models.CharField(max_length=200, blank=True)
    management_level = models.CharField(max_length=100, blank=True)
    department       = models.CharField(max_length=200, blank=True)
    site_location    = models.CharField(max_length=200, blank=True)
    city             = models.CharField(max_length=100, blank=True)
    state            = models.CharField(max_length=100, blank=True)
    employee_status  = models.CharField(max_length=50, blank=True)
    employee_type    = models.CharField(max_length=50, blank=True)
    pay_type         = models.CharField(max_length=50, blank=True)
    annual_salary    = models.DecimalField(max_digits=12, decimal_places=2, null=True, blank=True)
    fully_loaded_cost = models.DecimalField(max_digits=12, decimal_places=2, null=True, blank=True)
    is_overhead      = models.BooleanField(null=True, blank=True)
    hire_date        = models.DateField(null=True, blank=True)
    revenue_attribution = models.DecimalField(max_digits=14, decimal_places=2, null=True, blank=True)
    cost_center      = models.CharField(max_length=100, blank=True)
    entity           = models.CharField(max_length=200, blank=True)
    union_affiliation = models.CharField(max_length=200, blank=True)
    flsa_status      = models.CharField(max_length=50, blank=True)
    raw_data         = models.JSONField(default=dict)

    class Meta:
        ordering = ["last_name", "first_name"]
        unique_together = [("snapshot", "employee_id")]
        indexes = [
            models.Index(fields=["snapshot"]),
            models.Index(fields=["raw_supervisor_id"]),
            models.Index(fields=["supervisor"]),
            models.Index(fields=["management_level"]),
            models.Index(fields=["entity"]),
        ]

    def __str__(self):
        return f"{self.full_name} ({self.employee_id})"

    @property
    def full_name(self):
        return f"{self.first_name} {self.last_name}"

    @property
    def is_manager(self):
        return self.direct_reports.exists()


class AppPermission(models.Model):
    class Role(models.TextChoices):
        ADMIN  = "admin",  "Admin"
        VIEWER = "viewer", "Viewer"

    user                   = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="org_view_permissions")
    company                = models.ForeignKey(Company, on_delete=models.CASCADE, related_name="permissions")
    role                   = models.CharField(max_length=20, choices=Role.choices, default=Role.VIEWER)
    branch_root_employee_id = models.CharField(max_length=50, blank=True, null=True)
    is_active              = models.BooleanField(default=True)
    created_at             = models.DateTimeField(auto_now_add=True)
    updated_at             = models.DateTimeField(auto_now=True)

    class Meta:
        unique_together = [("user", "company")]

    def __str__(self):
        return f"{self.user.username} → {self.company.name} ({self.get_role_display()})"
