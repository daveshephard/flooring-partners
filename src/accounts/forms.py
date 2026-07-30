from django import forms
from django.contrib.auth.models import User

from .models import AppDefinition, CompanyProfile, UserProfile


class AddUserForm(forms.Form):
    username = forms.CharField(max_length=150)
    first_name = forms.CharField(max_length=150, required=False)
    last_name = forms.CharField(max_length=150, required=False)
    email = forms.EmailField(required=False)
    password = forms.CharField(widget=forms.PasswordInput)
    company = forms.ModelChoiceField(queryset=CompanyProfile.objects.filter(is_active=True))
    role = forms.ChoiceField(choices=UserProfile.Role.choices)
    assigned_apps = forms.ModelMultipleChoiceField(
        queryset=AppDefinition.objects.none(),
        widget=forms.CheckboxSelectMultiple,
        required=False,
    )

    def __init__(self, *args, admin_profile=None, **kwargs):
        super().__init__(*args, **kwargs)
        self.admin_profile = admin_profile
        if admin_profile and admin_profile.role == "company_admin":
            self.fields["company"].queryset = CompanyProfile.objects.filter(
                pk=admin_profile.company.pk
            )
            self.fields["company"].initial = admin_profile.company
            self.fields["role"].choices = [
                (r, label)
                for r, label in UserProfile.Role.choices
                if r != "superadmin"
            ]
            self.fields["assigned_apps"].queryset = admin_profile.company.available_apps.filter(
                is_active=True
            )
        elif admin_profile:
            # Superadmin: apps populated via JS or show all initially
            self.fields["assigned_apps"].queryset = AppDefinition.objects.filter(is_active=True)

    def clean_username(self):
        username = self.cleaned_data["username"]
        if User.objects.filter(username=username).exists():
            raise forms.ValidationError("A user with that username already exists.")
        return username

    def clean(self):
        cleaned = super().clean()
        company = cleaned.get("company")
        assigned_apps = cleaned.get("assigned_apps")
        if company and assigned_apps:
            allowed_ids = set(company.available_apps.values_list("pk", flat=True))
            for app in assigned_apps:
                if app.pk not in allowed_ids:
                    self.add_error(
                        "assigned_apps",
                        f"'{app.name}' is not available for {company.name}.",
                    )
        return cleaned


class EditUserForm(forms.Form):
    first_name = forms.CharField(max_length=150, required=False)
    last_name = forms.CharField(max_length=150, required=False)
    email = forms.EmailField(required=False)
    company = forms.ModelChoiceField(queryset=CompanyProfile.objects.filter(is_active=True))
    role = forms.ChoiceField(choices=UserProfile.Role.choices)
    assigned_apps = forms.ModelMultipleChoiceField(
        queryset=AppDefinition.objects.none(),
        widget=forms.CheckboxSelectMultiple,
        required=False,
    )
    is_active = forms.BooleanField(required=False)

    def __init__(self, *args, admin_profile=None, target_company=None, **kwargs):
        super().__init__(*args, **kwargs)
        self.admin_profile = admin_profile
        if admin_profile and admin_profile.role == "company_admin":
            self.fields["company"].queryset = CompanyProfile.objects.filter(
                pk=admin_profile.company.pk
            )
            self.fields["company"].widget = forms.HiddenInput()
            self.fields["role"].choices = [
                (r, label)
                for r, label in UserProfile.Role.choices
                if r != "superadmin"
            ]
            self.fields["assigned_apps"].queryset = admin_profile.company.available_apps.filter(
                is_active=True
            )
        else:
            company = target_company or (admin_profile.company if admin_profile else None)
            if company:
                self.fields["assigned_apps"].queryset = company.available_apps.filter(
                    is_active=True
                )
            else:
                self.fields["assigned_apps"].queryset = AppDefinition.objects.filter(
                    is_active=True
                )

    def clean(self):
        cleaned = super().clean()
        company = cleaned.get("company")
        assigned_apps = cleaned.get("assigned_apps")
        if company and assigned_apps:
            allowed_ids = set(company.available_apps.values_list("pk", flat=True))
            for app in assigned_apps:
                if app.pk not in allowed_ids:
                    self.add_error(
                        "assigned_apps",
                        f"'{app.name}' is not available for {company.name}.",
                    )
        return cleaned


class CompanyForm(forms.ModelForm):
    class Meta:
        model = CompanyProfile
        fields = ["name", "available_apps", "is_active"]
        widgets = {"available_apps": forms.CheckboxSelectMultiple}

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.fields["available_apps"].queryset = AppDefinition.objects.filter(is_active=True)


class AdminPasswordResetForm(forms.Form):
    new_password = forms.CharField(widget=forms.PasswordInput, min_length=8)
    confirm_password = forms.CharField(widget=forms.PasswordInput)

    def clean(self):
        cleaned = super().clean()
        p1 = cleaned.get("new_password")
        p2 = cleaned.get("confirm_password")
        if p1 and p2 and p1 != p2:
            raise forms.ValidationError("Passwords do not match.")
        return cleaned
