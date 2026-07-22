"""Multi-domain hosting (ALLOWED_HOSTS): OAuth redirect origin follows the
requesting host when allowed, falls back to BASE_URL otherwise."""
import os
import tempfile

# This module imports app code first in the pytest run (alphabetical order), and
# app.db builds the engine at import — the test env must be in place before that.
os.environ.setdefault("DATABASE_URL", f"sqlite:///{tempfile.mkdtemp()}/test.db")
os.environ.setdefault("SESSION_SECRET", "test-secret")
os.environ.setdefault("ALLOWED_USERS", "james@test.dev:James,shelby@test.dev:Shelby")
os.environ.setdefault("DEV_AUTH", "true")

from starlette.requests import Request  # noqa: E402

from app.config import get_settings  # noqa: E402
from app.security import public_base_url  # noqa: E402

_saved = {}


def setup_module():
    s = get_settings()
    _saved.update(base_url=s.base_url, allowed_hosts=s.allowed_hosts)
    s.base_url = "https://forge.example.com"
    s.allowed_hosts = "forge.other.net, https://third.example.org,"


def teardown_module():
    s = get_settings()
    s.base_url = _saved["base_url"]
    s.allowed_hosts = _saved["allowed_hosts"]


def _request(host: str, scheme: str = "https") -> Request:
    return Request({
        "type": "http", "method": "GET", "scheme": scheme, "path": "/auth/login",
        "query_string": b"", "headers": [(b"host", host.encode())],
        "server": (host.split(":")[0], 443),
    })


def test_host_allowlist_includes_base_url_and_entries():
    hosts = get_settings().host_allowlist
    assert hosts == {"forge.example.com", "forge.other.net", "third.example.org"}


def test_allowed_host_keeps_its_own_origin():
    assert public_base_url(_request("forge.other.net")) == "https://forge.other.net"
    assert public_base_url(_request("third.example.org")) == "https://third.example.org"
    assert public_base_url(_request("forge.example.com")) == "https://forge.example.com"


def test_unknown_host_falls_back_to_base_url():
    assert public_base_url(_request("evil.example.com")) == "https://forge.example.com"


def test_allowed_host_with_port_is_recognised():
    assert public_base_url(_request("forge.other.net:8443")) == "https://forge.other.net:8443"
