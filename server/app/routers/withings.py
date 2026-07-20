"""Withings OAuth link + webhook ingest (E2.2). Per-user link: tokens are stored
against the signed-in user only; webhook notifications resolve the Withings user
id back to our user, and unlinked webhooks are ignored (logged, 200 OK).

Measurements land in `metrics` with source='withings', idempotent on
(user, type, ts, source) like every other ingest path.
"""

from __future__ import annotations

import logging
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import RedirectResponse
from itsdangerous import BadSignature, URLSafeTimedSerializer
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import get_db
from ..models import Metric, User, WithingsLink, utcnow
from ..security import current_user

log = logging.getLogger("forge")
router = APIRouter(tags=["withings"])

AUTHORIZE_URL = "https://account.withings.com/oauth2_user/authorize2"
API_BASE = "https://wbsapi.withings.net"

# Withings meastype -> (canonical metric type, unit, extra scale on top of 10^unit)
# Full body composition: weight, height, fat %, fat/fat-free/muscle/water/bone mass.
MEASTYPES = {
    1: ("weight", "kg", 1),
    4: ("height", "cm", 100),  # Withings reports metres
    5: ("fat_free_mass", "kg", 1),
    6: ("body_fat_pct", "%", 1),
    8: ("fat_mass", "kg", 1),
    76: ("muscle_mass", "kg", 1),
    77: ("water_mass", "kg", 1),
    88: ("bone_mass", "kg", 1),
}


def store_measuregrps(db: Session, user_id: str, grps: list) -> int:
    """Map Withings measure groups into idempotent metric rows. Returns stored count."""
    stored = 0
    for grp in grps or []:
        ts = datetime.fromtimestamp(int(grp.get("date", 0)), tz=timezone.utc)
        for m in grp.get("measures", []) or []:
            mapped = MEASTYPES.get(m.get("type"))
            if not mapped:
                continue
            mtype, unit, scale = mapped
            value = round(m.get("value", 0) * (10 ** m.get("unit", 0)) * scale, 2)
            exists = (db.query(Metric.id)
                      .filter(Metric.user_id == user_id, Metric.type == mtype,
                              Metric.ts == ts, Metric.source == "withings").first())
            if not exists:
                db.add(Metric(user_id=user_id, type=mtype, value=value, unit=unit,
                              ts=ts, source="withings"))
                db.flush()  # session is autoflush=False — make the row visible to the dedupe query
                stored += 1
    return stored


def _state_signer() -> URLSafeTimedSerializer:
    return URLSafeTimedSerializer(get_settings().session_secret, salt="withings-state")


def _redirect_uri() -> str:
    return get_settings().base_url.rstrip("/") + "/api/withings/callback"


def _configured() -> bool:
    s = get_settings()
    return bool(s.withings_client_id and s.withings_client_secret)


def _token_request(db: Session, params: dict) -> dict | None:
    """Call the Withings token endpoint. Returns the body dict or None on error."""
    s = get_settings()
    data = {"action": "requesttoken", "client_id": s.withings_client_id,
            "client_secret": s.withings_client_secret, **params}
    try:
        r = httpx.post(f"{API_BASE}/v2/oauth2", data=data, timeout=20)
        out = r.json()
    except Exception as e:
        log.warning("withings token request failed: %s", e)
        return None
    if out.get("status") != 0:
        log.warning("withings token error: %s", out)
        return None
    return out.get("body") or {}


def _apply_tokens(link: WithingsLink, body: dict) -> None:
    link.access_token = body["access_token"]
    link.refresh_token = body["refresh_token"]
    link.expires_at = utcnow() + timedelta(seconds=int(body.get("expires_in", 10800)))
    link.status = "ok"


def _fresh_token(db: Session, link: WithingsLink) -> str | None:
    """Access token, auto-refreshed. A failed refresh flags the link (E2.2 AC3)."""
    expires = link.expires_at
    if expires is not None and expires.tzinfo is None:
        expires = expires.replace(tzinfo=timezone.utc)
    if expires is None or expires <= utcnow() + timedelta(minutes=2):
        body = _token_request(db, {"grant_type": "refresh_token",
                                   "refresh_token": link.refresh_token})
        if not body:
            link.status = "refresh_failed"
            db.commit()
            return None
        _apply_tokens(link, body)
        db.commit()
    return link.access_token


def sync_link(db: Session, link: WithingsLink) -> int:
    """Fetch new measurements for one link. Returns rows stored."""
    token = _fresh_token(db, link)
    if not token:
        return 0
    last = link.last_sync_at
    if last is not None and last.tzinfo is None:
        last = last.replace(tzinfo=timezone.utc)
    params = {"action": "getmeas", "meastypes": ",".join(str(t) for t in MEASTYPES),
              "category": 1}
    if last:
        params["lastupdate"] = int(last.timestamp())
    else:
        params["startdate"] = int((utcnow() - timedelta(days=365)).timestamp())
        params["enddate"] = int(time.time())
    try:
        r = httpx.post(f"{API_BASE}/measure", data=params,
                       headers={"Authorization": f"Bearer {token}"}, timeout=20)
        out = r.json()
    except Exception as e:
        log.warning("withings getmeas failed: %s", e)
        return 0
    if out.get("status") != 0:
        log.warning("withings getmeas error: %s", out)
        return 0
    stored = store_measuregrps(db, link.user_id, (out.get("body") or {}).get("measuregrps", []))
    link.last_sync_at = utcnow()
    db.commit()
    return stored


def _subscribe_notify(db: Session, link: WithingsLink) -> None:
    """Best-effort webhook subscription (appli 1 = weight). Needs public ingress."""
    token = _fresh_token(db, link)
    if not token:
        return
    try:
        r = httpx.post(f"{API_BASE}/notify",
                       data={"action": "subscribe", "callbackurl": _redirect_uri()
                             .replace("/callback", "/webhook"), "appli": 1},
                       headers={"Authorization": f"Bearer {token}"}, timeout=20)
        if r.json().get("status") != 0:
            log.info("withings notify subscribe declined (LAN-only base_url?): %s", r.text[:200])
    except Exception as e:
        log.info("withings notify subscribe failed: %s", e)


# ---------- link flow ----------

@router.get("/api/withings/connect")
def connect(user: User = Depends(current_user)):
    if not _configured():
        raise HTTPException(status_code=503, detail="Withings credentials not configured — "
                            "add them in Settings → Server")
    state = _state_signer().dumps({"uid": user.id})
    url = AUTHORIZE_URL + "?" + urlencode({
        "response_type": "code", "client_id": get_settings().withings_client_id,
        "scope": "user.metrics", "redirect_uri": _redirect_uri(), "state": state,
    })
    return {"url": url}


@router.get("/api/withings/callback")
def callback(code: str = "", state: str = "", db: Session = Depends(get_db)):
    if not code or not state:
        return RedirectResponse("/?withings=denied")
    try:
        uid = _state_signer().loads(state, max_age=600)["uid"]
    except (BadSignature, KeyError):
        raise HTTPException(status_code=400, detail="bad state")
    body = _token_request(db, {"grant_type": "authorization_code", "code": code,
                               "redirect_uri": _redirect_uri()})
    if not body:
        return RedirectResponse("/?withings=error")
    link = db.query(WithingsLink).filter(WithingsLink.user_id == uid).first()
    if not link:
        link = WithingsLink(user_id=uid, withings_user_id=str(body.get("userid", "")),
                            access_token="", refresh_token="", expires_at=utcnow())
        db.add(link)
    link.withings_user_id = str(body.get("userid", ""))
    _apply_tokens(link, body)
    link.last_sync_at = None
    db.commit()
    _subscribe_notify(db, link)
    sync_link(db, link)
    return RedirectResponse("/?withings=linked")


@router.post("/api/withings/sync")
def manual_sync(user: User = Depends(current_user), db: Session = Depends(get_db)):
    link = db.query(WithingsLink).filter(WithingsLink.user_id == user.id).first()
    if not link:
        raise HTTPException(status_code=404, detail="Withings not linked")
    stored = sync_link(db, link)
    return {"ok": link.status == "ok", "stored": stored, "status": link.status}


@router.post("/api/withings/unlink")
def unlink(user: User = Depends(current_user), db: Session = Depends(get_db)):
    link = db.query(WithingsLink).filter(WithingsLink.user_id == user.id).first()
    if link:
        db.delete(link)  # tokens gone — revocation on our side is deletion (E2.3)
        db.commit()
    return {"ok": True}


# ---------- webhook ----------

@router.head("/api/withings/webhook")
@router.get("/api/withings/webhook")
def webhook_probe():
    return {"ok": True}  # Withings probes the callback URL before subscribing


@router.post("/api/withings/webhook")
async def webhook(request: Request, db: Session = Depends(get_db)):
    try:
        form = await request.form()
    except Exception:
        form = {}
    wuid = str(form.get("userid", ""))
    link = (db.query(WithingsLink).filter(WithingsLink.withings_user_id == wuid).first()
            if wuid else None)
    if not link:
        log.info("withings webhook for unlinked user %r ignored", wuid)
        return {"ok": True, "ignored": True}
    stored = sync_link(db, link)
    return {"ok": True, "stored": stored}
