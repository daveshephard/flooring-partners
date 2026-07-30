from django import template

register = template.Library()


@register.simple_tag
def dict_get(d, key):
    """Look up *key* in dict *d*, return empty string on miss."""
    if isinstance(d, dict):
        return d.get(key, "")
    return ""
