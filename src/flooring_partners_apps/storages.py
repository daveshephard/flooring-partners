"""Static-file storage.

Split out so the reasoning has somewhere to live.
"""
from whitenoise.storage import CompressedManifestStaticFilesStorage


class HashedStaticFilesStorage(CompressedManifestStaticFilesStorage):
    """Content-hashed static filenames, with ES module imports rewritten to match.

    The plain ``CompressedStaticFilesStorage`` serves every file at a stable URL,
    so WhiteNoise's long cache headers meant a browser could keep running last
    week's JavaScript indefinitely. That bit us: a release shipped a new template
    and a new module together, and the browser took the template but kept the
    cached module — which looks, from the outside, like the feature simply not
    working.

    Hashing alone would not have been enough. Org View's front end is plain ES
    modules with no bundler, so ``edit-shell.js`` does ``import "./chart.js"`` and
    the *browser* resolves that specifier. Hashing only the entry point would
    leave every imported module on its old cached URL.
    ``support_js_module_import_aggregation`` makes collectstatic rewrite those
    import specifiers to the hashed names too, which is what actually closes the
    hole.
    """

    support_js_module_import_aggregation = True
