from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, RedirectResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import get_db
from ..models import User
from ..security import clear_session, current_user, set_session

router = APIRouter(prefix="/auth", tags=["auth"])

_oauth = None


def _google():
    global _oauth
    if _oauth is None:
        from authlib.integrations.starlette_client import OAuth

        settings = get_settings()
        _oauth = OAuth()
        _oauth.register(
            "google",
            client_id=settings.google_client_id,
            client_secret=settings.google_client_secret,
            server_metadata_url="https://accounts.google.com/.well-known/openid-configuration",
            client_kwargs={"scope": "openid email profile"},
        )
    return _oauth.google


@router.get("/mode")
def mode(db: Session = Depends(get_db)):
    s = get_settings()
    out = {"google": s.google_enabled, "dev": s.dev_login_enabled, "users": [],
           "demo": db.query(User.id).filter(User.role == "demo").first() is not None}
    if s.dev_login_enabled:
        out["users"] = [{"email": u.email, "name": u.name}
                        for u in db.query(User).filter(User.role != "demo").order_by(User.created_at)]
    return out


@router.post("/demo")
def demo_login(db: Session = Depends(get_db)):
    """Open the demo account (Bruce). Enabled the moment the admin creates it —
    the session is scoped to demo data only, like any other user's."""
    user = db.query(User).filter(User.role == "demo").first()
    if not user:
        raise HTTPException(status_code=404, detail="demo not enabled")
    resp = JSONResponse({"ok": True, "name": user.name})
    set_session(resp, user.id)
    return resp


class DevLogin(BaseModel):
    email: str


@router.post("/dev")
def dev_login(body: DevLogin, db: Session = Depends(get_db)):
    s = get_settings()
    if not s.dev_login_enabled:
        raise HTTPException(status_code=403, detail="dev sign-in disabled")
    email = body.email.strip().lower()
    # the users table IS the allowlist (env ALLOWED_USERS only seeds it once)
    user = db.query(User).filter(User.email == email).first()
    if not user:
        raise HTTPException(status_code=403, detail="not on the list")
    resp = JSONResponse({"ok": True, "name": user.name})
    set_session(resp, user.id)
    return resp


@router.get("/login")
async def login(request: Request):
    if not get_settings().google_enabled:
        raise HTTPException(status_code=404, detail="google not configured")
    redirect_uri = get_settings().base_url.rstrip("/") + "/auth/callback"
    return await _google().authorize_redirect(request, redirect_uri)


@router.get("/callback")
async def callback(request: Request, db: Session = Depends(get_db)):
    if not get_settings().google_enabled:
        raise HTTPException(status_code=404, detail="google not configured")
    token = await _google().authorize_access_token(request)
    info = token.get("userinfo") or {}
    email = (info.get("email") or "").lower()
    user = db.query(User).filter(User.email == email).first()
    if not user:
        return RedirectResponse("/?denied=" + email)
    resp = RedirectResponse("/")
    set_session(resp, user.id)
    return resp


@router.post("/logout")
def logout():
    resp = JSONResponse({"ok": True})
    clear_session(resp)
    return resp


@router.get("/me")
def me(user: User = Depends(current_user)):
    return {"id": user.id, "email": user.email, "name": user.name, "role": user.role,
            "units": user.units, "prefs": user.prefs or {}}
