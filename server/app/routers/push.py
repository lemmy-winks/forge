"""Web Push subscription management. Delivery itself lives in app/notify.py,
which enforces the three-kinds rule — this router only stores subscriptions."""

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import get_db
from ..models import PushSub, User
from ..notify import push_enabled
from ..security import current_user

router = APIRouter(prefix="/api/push", tags=["push"])


@router.get("/config")
def config(user: User = Depends(current_user)):
    return {"enabled": push_enabled(), "public_key": get_settings().vapid_public_key}


class SubIn(BaseModel):
    endpoint: str
    keys: dict  # {p256dh, auth}


@router.post("/subscribe")
def subscribe(body: SubIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    existing = (db.query(PushSub)
                .filter(PushSub.user_id == user.id, PushSub.endpoint == body.endpoint).first())
    if existing:
        existing.p256dh = body.keys.get("p256dh", "")
        existing.auth = body.keys.get("auth", "")
    else:
        db.add(PushSub(user_id=user.id, endpoint=body.endpoint,
                       p256dh=body.keys.get("p256dh", ""), auth=body.keys.get("auth", "")))
    db.commit()
    return {"ok": True}


class UnsubIn(BaseModel):
    endpoint: str


@router.post("/unsubscribe")
def unsubscribe(body: UnsubIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    (db.query(PushSub)
     .filter(PushSub.user_id == user.id, PushSub.endpoint == body.endpoint)
     .delete())
    db.commit()
    return {"ok": True}
