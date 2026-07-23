"""First-time-visitor landing page routing.

The landing page ships as a static web/public/welcome.html. Once the PWA
service worker is installed, Workbox's cleanURLs serves the extensionless
/welcome straight from the precached welcome.html — but a brand-new visitor
has no service worker, so /welcome reaches the server. StaticFiles only knows
welcome.html and would answer the extensionless path with {"detail":"Not
Found"}. main.welcome_page mirrors the client cleanURLs mapping so the very
first, un-cached visit resolves too."""
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

_WEB = Path(__file__).resolve().parents[2] / "web"


@pytest.fixture()
def served(monkeypatch):
    """Point the static routes at a temp dir with the real shell + welcome page."""
    tmp = Path(tempfile.mkdtemp())
    shutil.copy(_WEB / "index.html", tmp / "index.html")
    shutil.copy(_WEB / "public" / "welcome.html", tmp / "welcome.html")
    monkeypatch.setattr(main, "_static", tmp)
    return TestClient(main.app)


def test_extensionless_welcome_serves_landing_page(served):
    # This is the first-visit path that used to 404 before the service worker
    # existed to map it via cleanURLs.
    r = served.get("/welcome")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/html")
    assert "Open Forge" in r.text  # landing-page CTA, not the SPA shell


def test_welcome_html_still_served(served):
    r = served.get("/welcome.html")
    assert r.status_code == 200
    assert "Open Forge" in r.text


def test_welcome_falls_back_to_spa_when_page_absent(monkeypatch):
    # Legacy vanilla client (no welcome.html shipped): don't 500, serve the shell.
    tmp = Path(tempfile.mkdtemp())
    shutil.copy(_WEB / "index.html", tmp / "index.html")
    monkeypatch.setattr(main, "_static", tmp)
    r = TestClient(main.app).get("/welcome")
    assert r.status_code == 200
    assert "Open Forge" not in r.text  # SPA shell, not the landing page


def test_committed_welcome_page_ships_as_static_asset():
    # vite copies web/public/* to the dist root, so this is what production
    # serves. Guards against the landing page being moved out of public/.
    p = _WEB / "public" / "welcome.html"
    assert p.exists()
    assert "Open Forge" in p.read_text(encoding="utf-8")
