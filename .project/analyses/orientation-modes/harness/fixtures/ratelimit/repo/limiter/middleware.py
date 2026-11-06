"""Request admission."""


def make_key(tenant, route):
    """Return the bucket key for a tenant and route."""
    raise NotImplementedError


def check_request(tenant, route, tier="standard", clock=None):
    """Admit or reject one request; return (status, headers, body). `body` is a dict."""
    raise NotImplementedError
    