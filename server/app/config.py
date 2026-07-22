from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "sqlite:///./forge.db"
    session_secret: str = "dev-secret-change-me"

    # Comma-separated "email:Display Name" pairs; the entire allowlist.
    allowed_users: str = "you@example.com:You,partner@example.com:Partner"

    # Google OIDC. When unset, dev sign-in buttons are shown instead.
    google_client_id: str = ""
    google_client_secret: str = ""
    # Force-enable dev sign-in even when Google is configured (never in production).
    dev_auth: bool = False

    base_url: str = "http://localhost:8000"
    # Extra public hostnames the app is served on (comma-separated, bare hostnames
    # or full URLs). Requests from these hosts complete Google OAuth on their own
    # domain instead of bouncing to BASE_URL; every entry also needs its
    # https://host/auth/callback added to the Google OAuth client's redirect URIs.
    # BASE_URL's host is always allowed and stays the canonical home for Withings.
    allowed_hosts: str = ""
    media_dir: str = "/data/media"

    # Phase 4 — Withings OAuth (per-user link; webhooks need public ingress)
    withings_client_id: str = ""
    withings_client_secret: str = ""

    # Phase 4 — Web Push (generate once: `python -m app.vapid`)
    vapid_public_key: str = ""
    vapid_private_key: str = ""
    vapid_subject: str = "mailto:forge@localhost"

    # Planned-day reminder: fires from this hour (coach_tz), never in quiet hours.
    reminder_hour: int = 16
    quiet_start: int = 8   # no pushes before
    quiet_end: int = 21    # or from this hour on

    # Run-detail basemap (E5.4 follow-up). A MapTiler publishable key — restrict
    # it to the app's domains in the MapTiler dashboard. Empty = the SVG trace.
    maptiler_key: str = ""

    # Phase 3 — the coach
    anthropic_api_key: str = ""
    coach_model: str = "claude-sonnet-5"
    coach_tz: str = "Europe/London"
    review_weekday: int = 6  # Sunday
    review_hour: int = 20

    @property
    def allowlist(self) -> dict[str, str]:
        out: dict[str, str] = {}
        for pair in self.allowed_users.split(","):
            pair = pair.strip()
            if not pair:
                continue
            email, _, name = pair.partition(":")
            out[email.strip().lower()] = name.strip() or email.split("@")[0].title()
        return out

    @property
    def host_allowlist(self) -> set[str]:
        from urllib.parse import urlsplit

        hosts = {(urlsplit(self.base_url).hostname or "").lower()}
        for entry in self.allowed_hosts.split(","):
            entry = entry.strip().lower()
            if not entry:
                continue
            if "//" in entry:
                entry = urlsplit(entry).hostname or ""
            hosts.add(entry.split(":")[0])
        hosts.discard("")
        return hosts

    @property
    def google_enabled(self) -> bool:
        return bool(self.google_client_id and self.google_client_secret)

    @property
    def dev_login_enabled(self) -> bool:
        return self.dev_auth or not self.google_enabled


@lru_cache
def get_settings() -> Settings:
    return Settings()


def local_today():
    """Today in the instance's home timezone (COACH_TZ) — never the UTC date,
    which is yesterday's date for the first hour after midnight in summer."""
    from datetime import datetime
    from zoneinfo import ZoneInfo

    return datetime.now(ZoneInfo(get_settings().coach_tz)).date()


# Settings the admin can manage in-app (Settings → Server). Stored in the
# app_settings table; a stored value overrides the environment on the cached
# singleton, so every get_settings() call site sees it without a restart.
# Google OAuth is deliberately NOT here — it must exist before anyone can sign in.
OVERRIDABLE = (
    "anthropic_api_key",
    "coach_model",
    "withings_client_id",
    "withings_client_secret",
    "vapid_public_key",
    "vapid_private_key",
    "maptiler_key",
)

_env_defaults: dict[str, str] = {}


def apply_overrides(db) -> None:
    """Load stored overrides onto the settings singleton (startup)."""
    from .models import AppSetting

    s = get_settings()
    for key in OVERRIDABLE:
        _env_defaults.setdefault(key, getattr(s, key))
    for row in db.query(AppSetting).filter(AppSetting.key.in_(OVERRIDABLE)):
        setattr(s, row.key, row.value)


def set_override(db, key: str, value: str) -> None:
    """Persist one override and apply it live. Empty value reverts to the env."""
    from .models import AppSetting

    if key not in OVERRIDABLE:
        raise KeyError(key)
    s = get_settings()
    _env_defaults.setdefault(key, getattr(s, key))
    row = db.get(AppSetting, key)
    if value:
        if row is None:
            db.add(AppSetting(key=key, value=value))
        else:
            row.value = value
        setattr(s, key, value)
    else:
        if row is not None:
            db.delete(row)
        setattr(s, key, _env_defaults[key])
