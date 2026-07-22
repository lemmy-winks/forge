"""Link-preview (Open Graph / Twitter) tags in the SPA shell: the committed
web/index.html carries the card tags, and main._render_index resolves the
__ORIGIN__ placeholder to the request's own allowed host so WhatsApp & co. build
a card from an absolute image that tracks the shared-from domain.

Static-build-independent: the test env has no web/dist, so it points the shell
route at a temp copy of the real web/index.html rather than the built bundle."""
import os
import shutil
import tempfile
from pathlib import Path

os.environ.setdefault("DATABASE_URL", f"sqlite:///{tempfile.mkdtemp()}/test.db")
os.environ.setdefault("SESSION_SECRET", "test-secret")
os.environ.setdefault("ALLOWED_USERS", "james@test.dev:James,shelby@test.dev:Shelby")
os.environ.setdefault("DEV_AUTH", "true")

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import main  # noqa: E402
from app.config import get_settings  # noqa: E402

_WEB = Path(__file__).resolve().parents[2] / "web"
_saved = {}


def setup_module():
    s = get_settings()
    _saved.update(base_url=s.base_url, allowed_hosts=s.allowed_hosts)
    s.base_url = "https://forge.example.com"
    s.allowed_hosts = "get-forged.com"


def teardown_module():
    s = get_settings()
    s.base_url = _saved["base_url"]
    s.allowed_hosts = _saved["allowed_hosts"]


@pytest.fixture()
def shell(monkeypatch):
    """Serve the real committed web/index.html through the shell route."""
    tmp = Path(tempfile.mkdtemp())
    shutil.copy(_WEB / "index.html", tmp / "index.html")
    monkeypatch.setattr(main, "_static", tmp)
    return TestClient(main.app)


def test_committed_index_has_card_tags_and_placeholder():
    # Scrapers don't run JS — the tags must be in the static shell, with the
    # runtime-resolved origin token still present in the source.
    src = (_WEB / "index.html").read_text(encoding="utf-8")
    assert '<meta property="og:title"' in src
    assert '<meta name="twitter:card" content="summary_large_image">' in src
    assert "__ORIGIN__/og-image.png" in src


def test_shell_resolves_placeholder(shell):
    html = shell.get("/").text
    assert '<meta property="og:image"' in html
    assert "__ORIGIN__" not in html  # a scraper never sees the raw token


def test_og_image_is_absolute_to_the_requesting_allowed_host(monkeypatch):
    tmp = Path(tempfile.mkdtemp())
    shutil.copy(_WEB / "index.html", tmp / "index.html")
    monkeypatch.setattr(main, "_static", tmp)
    # A link shared from get-forged.com must preview with a get-forged.com image,
    # not the canonical BASE_URL — an absolute URL to the wrong host could 404.
    html = TestClient(main.app, base_url="https://get-forged.com").get("/").text
    assert '<meta property="og:image" content="https://get-forged.com/og-image.png">' in html
    assert '<meta property="og:url" content="https://get-forged.com/">' in html


def test_spoofed_host_falls_back_to_canonical_base_url(monkeypatch):
    tmp = Path(tempfile.mkdtemp())
    shutil.copy(_WEB / "index.html", tmp / "index.html")
    monkeypatch.setattr(main, "_static", tmp)
    html = TestClient(main.app, base_url="https://evil.example.com").get("/").text
    assert "https://forge.example.com/og-image.png" in html
    assert "evil.example.com" not in html


def test_og_image_source_asset_ships_as_png():
    # vite copies web/public/* to the dist root, so this is what gets served at
    # /og-image.png in production. WhatsApp needs a raster image, not the SVG.
    p = _WEB / "public" / "og-image.png"
    assert p.exists()
    assert p.read_bytes()[:8] == b"\x89PNG\r\n\x1a\n"
