from django.urls import path

from . import api, views

app_name = "org_view"

urlpatterns = [
    # ── UI views ────────────────────────────────────────────────────────
    path("",                          views.index,             name="index"),
    path("c/<slug:slug>/",            views.company_detail,    name="company_detail"),
    path("c/<slug:slug>/trends/",     views.trends,            name="trends"),

    # ── Scenario planning ───────────────────────────────────────────────
    path("c/<slug:slug>/scenarios/",                             views.scenario_list,   name="scenario_list"),
    path("c/<slug:slug>/scenarios/new/",                         views.scenario_create, name="scenario_create"),
    path("c/<slug:slug>/scenarios/<int:scenario_id>/",           views.scenario_detail, name="scenario_detail"),
    path("c/<slug:slug>/scenarios/<int:scenario_id>/action/",    views.scenario_action, name="scenario_action"),
    path("c/<slug:slug>/scenarios/<int:scenario_id>/delete/",    views.scenario_delete, name="scenario_delete"),
    path("upload/",                   views.upload,            name="upload"),
    path("upload/mapping/",           views.mapping,           name="mapping"),
    path("upload/quality-report/",    views.quality_report,    name="quality_report"),
    path("upload/bulk-edit/",         views.bulk_edit,         name="bulk_edit"),
    path("upload/save/",              views.save_snapshot,     name="save_snapshot"),
    path("download-template/",        views.download_template, name="download_template"),

    # ── Admin ───────────────────────────────────────────────────────────
    path("admin/permissions/",                    views.permissions_list,       name="permissions_list"),
    path("admin/permissions/add/",                views.permission_add,         name="permission_add"),
    path("admin/permissions/<int:pk>/edit/",      views.permission_edit,        name="permission_edit"),
    path("admin/permissions/<int:pk>/delete/",    views.permission_delete,      name="permission_delete"),
    path("admin/permissions/quick-setup/",        views.permission_quick_setup, name="permission_quick_setup"),

    # ── JSON API ────────────────────────────────────────────────────────
    path("api/companies/",                              api.api_companies,       name="api_companies"),
    path("api/companies/<slug:slug>/org-tree/",         api.api_org_tree,        name="api_org_tree"),
    path("api/companies/<slug:slug>/snapshots/",        api.api_snapshots,       name="api_snapshots"),
    path("api/companies/<slug:slug>/employees/search/", api.api_employee_search, name="api_employee_search"),
    path("api/companies/<slug:slug>/trends/",           api.api_trends,          name="api_trends"),
    path("api/companies/<slug:slug>/scenarios/<int:scenario_id>/org-tree/", api.api_scenario_tree, name="api_scenario_tree"),
    path("api/companies/<slug:slug>/snapshots/<int:pk>/set-active/", api.api_set_active, name="api_set_active"),
    path("api/companies/<slug:slug>/snapshots/<int:pk>/edit/",       api.api_edit_snapshot, name="api_edit_snapshot"),
    path("api/companies/<slug:slug>/snapshots/<int:pk>/delete/",     api.api_delete_snapshot, name="api_delete_snapshot"),
]
