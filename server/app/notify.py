"""Web Push, hard-limited to the three notification kinds (E12.1).

`send_push` is the ONLY way a push leaves this server, and it raises on any kind
outside the allowlist — new notification types are a code change here, not a
convention. Quiet hours and per-kind preference toggles are enforced centrally.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime
from zoneinfo import ZoneInfo

from sqlalchemy.orm import Session

from .config import get_settings
from .models import PushSub, User

log = logging.getLogger("forge")

# kind -> the user pref that toggles it. Nothing else may be pushed.
# ("film" was retired with the media pipeline — form media is curated, not self-shot.)
ALLOWED_KINDS = {
    "proposal": "notif_proposal",
    "reminder": "notif_reminder",
}


def push_enabled() -> bool:
    s = get_settings()
    return bool(s.vapid_public_key and s.vapid_private_key)


def in_quiet_hours(now: datetime | None = None) -> bool:
    s = get_settings()
    hour = (now or datetime.now(ZoneInfo(s.coach_tz))).hour
    return not (s.quiet_start <= hour < s.quiet_end)


def send_push(db: Session, user: User, kind: str, title: str, body: str, url: str = "/") -> int:
    """Send to all of the user's subscriptions. Returns the number delivered."""
    if kind not in ALLOWED_KINDS:
        raise ValueError(f"push kind {kind!r} is not one of the three allowed kinds")
    if (user.prefs or {}).get(ALLOWED_KINDS[kind]) is False:
        return 0
    if not push_enabled() or in_quiet_hours():
        return 0
    subs = db.query(PushSub).filter(PushSub.user_id == user.id).all()
    if not subs:
        return 0
    try:
        from pywebpush import WebPushException, webpush
    except ImportError:
        log.warning("pywebpush not installed — push skipped")
        return 0
    settings = get_settings()
    payload = json.dumps({"kind": kind, "title": title, "body": body, "url": url})
    sent = 0
    for sub in subs:
        try:
            webpush(
                subscription_info={"endpoint": sub.endpoint,
                                   "keys": {"p256dh": sub.p256dh, "auth": sub.auth}},
                data=payload,
                vapid_private_key=settings.vapid_private_key,
                vapid_claims={"sub": settings.vapid_subject},
            )
            sent += 1
        except WebPushException as e:
            status = getattr(getattr(e, "response", None), "status_code", None)
            if status in (404, 410):  # subscription expired — drop it
                db.delete(sub)
            else:
                log.warning("push to %s failed: %s", user.email, e)
    db.commit()
    return sent
