from django.urls import path

from . import views

app_name = "accounts"

urlpatterns = [
    path("", views.admin_dashboard, name="dashboard"),
    path("users/", views.user_list, name="user_list"),
    path("users/add/", views.user_add, name="user_add"),
    path("users/<int:user_id>/edit/", views.user_edit, name="user_edit"),
    path("users/<int:user_id>/reset-password/", views.user_reset_password, name="user_reset_password"),
    path("companies/", views.company_list, name="company_list"),
    path("companies/add/", views.company_add, name="company_add"),
    path("companies/<int:company_id>/edit/", views.company_edit, name="company_edit"),
]
