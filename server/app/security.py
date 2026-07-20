import secrets

from fastapi import Depends, HTTPException, Request
from itsdangerous import BadSignature, URLSafeTimedSerializer
from sqlalchemy.orm import Session

from .config import get_settings
from .db import get_db
from .models import IngestToken, User

COOKIE = "forge_session"
MAX_AGE = 60 * 60 * 24 * 90  # 90 days


def _serializer() -> URLSafeTimedSerializer:
    return URLSafeTimedSerializer(get_settings().session_secret, salt="forge-session")


def session_cookie_value(user_id: str) -> str:
    return _serializer().dumps({"uid": user_id})


def set_session(response, user_id: str) -> None:
    response.set_cookie(
        COOKIE,
        session_cookie_value(user_id),
        max_age=MAX_AGE,
        httponly=True,
        samesite="lax",
        secure=get_settings().base_url.startswith("https"),
    )


def clear_session(response) -> None:
    response.delete_cookie(COOKIE)


def current_user(request: Request, db: Session = Depends(get_db)) -> User:
    raw = request.cookies.get(COOKIE)
    if not raw:
        raise HTTPException(status_code=401, detail="not signed in")
    try:
        data = _serializer().loads(raw, max_age=MAX_AGE)
    except BadSignature:
        raise HTTPException(status_code=401, detail="invalid session")
    user = db.get(User, data.get("uid", ""))
    if not user:
        raise HTTPException(status_code=401, detail="unknown user")
    return user


def admin_user(user: User = Depends(current_user)) -> User:
    if user.role != "admin":
        raise HTTPException(status_code=403, detail="admin only")
    return user


def new_ingest_token() -> str:
    return "fg_" + secrets.token_urlsafe(24)


def user_for_ingest_token(db: Session, token: str) -> IngestToken | None:
    if not token or not token.startswith("fg_"):
        return None
    return db.query(IngestToken).filter(IngestToken.token == token).first()
