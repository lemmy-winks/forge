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
    def google_enabled(self) -> bool:
        return bool(self.google_client_id and self.google_client_secret)

    @property
    def dev_login_enabled(self) -> bool:
        return self.dev_auth or not self.google_enabled


@lru_cache
def get_settings() -> Settings:
    return Settings()
