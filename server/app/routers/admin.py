"""Admin-only server management: instance settings and the user list.

Secrets are write-only through this API — responses carry a masked tail at
most, never the stored value (ANTHROPIC_API_KEY must never reach the frontend).
Google OAuth is deliberately absent: it has to exist before anyone can sign in,
so it stays in the compose environment.
"""

import re

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .. import vapid
from ..config import OVERRIDABLE, get_settings, set_override
from ..db import get_db
from ..models import AppSetting, IngestToken, User
from ..security import admin_user, new_ingest_token
from ..seed import seed_user_defaults

router = APIRouter(prefix="/api/admin", tags=["admin"])

# key → (is_secret, label). Non-secret values are returned in full.
FIELDS: dict[str, tuple[bool, str]] = {
    "anthropic_api_key": (True, "Anthropic API key"),
    "coach_model": (False, "Coach model"),
    "withings_client_id": (False, "Withings client ID"),
    "withings_client_secret": (True, "Withings client secret"),
    "vapid_public_key": (False, "Web push public key"),
    "vapid_private_key": (True, "Web push private key"),
    # Publishable by design — it ships to every signed-in browser to fetch
    # tiles, so there is nothing to hide from the admin who set it.
    "maptiler_key": (False, "MapTiler API key"),
}


def _mask(value: str) -> str:
    if not value:
        return ""
    return "…" + value[-4:] if len(value) > 8 else "…"


@router.get("/settings")
def get_admin_settings(user: User = Depends(admin_user), db: Session = Depends(get_db)):
    s = get_settings()
    stored = {r.key for r in db.query(AppSetting).filter(AppSetting.key.in_(OVERRIDABLE))}
    out = {}
    for key, (secret, _label) in FIELDS.items():
        value = getattr(s, key)
        out[key] = {
            "set": bool(value),
            "value": _mask(value) if secret else value,
            "source": "app" if key in stored else ("env" if value else None),
        }
    return out


class SettingsPatch(BaseModel):
    values: dict[str, str]


@router.put("/settings")
def put_admin_settings(body: SettingsPatch, user: User = Depends(admin_user),
                       db: Session = Depends(get_db)):
    for key in body.values:
        if key not in OVERRIDABLE:
            raise HTTPException(status_code=422, detail=f"unknown setting {key}")
    for key, value in body.values.items():
        set_override(db, key, value.strip())
    db.commit()
    return get_admin_settings(user, db)


@router.post("/settings/vapid")
def generate_vapid(user: User = Depends(admin_user), db: Session = Depends(get_db)):
    """Generate a web-push keypair and store it. Existing subscriptions break if
    keys already existed — the UI warns before calling this on re-generate."""
    priv, pub = vapid.generate()
    set_override(db, "vapid_private_key", priv)
    set_override(db, "vapid_public_key", pub)
    db.commit()
    return {"public_key": pub}


EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _user_row(u: User) -> dict:
    return {"id": u.id, "email": u.email, "name": u.name, "role": u.role}


@router.get("/users")
def list_users(user: User = Depends(admin_user), db: Session = Depends(get_db)):
    return [_user_row(u) for u in
            db.query(User).filter(User.role != "demo").order_by(User.created_at)]


class UserPatch(BaseModel):
    email: str | None = None
    name: str | None = None


@router.patch("/users/{user_id}")
def update_user(user_id: str, body: UserPatch, user: User = Depends(admin_user),
                db: Session = Depends(get_db)):
    target = db.get(User, user_id)
    if target is None:
        raise HTTPException(status_code=404, detail="no such user")
    if body.email is not None:
        email = body.email.strip().lower()
        if not EMAIL_RE.match(email):
            raise HTTPException(status_code=422, detail="invalid email")
        clash = db.query(User).filter(User.email == email, User.id != user_id).first()
        if clash:
            raise HTTPException(status_code=409, detail="email already in use")
        target.email = email
    if body.name is not None:
        name = body.name.strip()
        if not name:
            raise HTTPException(status_code=422, detail="name required")
        target.name = name
    db.commit()
    return _user_row(target)


class UserCreate(BaseModel):
    email: str
    name: str


@router.post("/users")
def create_user(body: UserCreate, user: User = Depends(admin_user),
                db: Session = Depends(get_db)):
    # two users by design (the demo seat doesn't count) — this fills the second seat
    if db.query(User).filter(User.role != "demo").count() >= 2:
        raise HTTPException(status_code=409, detail="both seats are taken")
    email = body.email.strip().lower()
    if not EMAIL_RE.match(email):
        raise HTTPException(status_code=422, detail="invalid email")
    if db.query(User).filter(User.email == email).first():
        raise HTTPException(status_code=409, detail="email already in use")
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="name required")
    new = User(email=email, name=name, role="member",
               prefs={"notif_proposal": True, "notif_reminder": True})
    db.add(new)
    db.flush()
    db.add(IngestToken(user_id=new.id, token=new_ingest_token()))
    seed_user_defaults(db, new)  # equipment profiles + starter plan, ready immediately
    db.commit()
    return _user_row(new)


@router.get("/demo")
def demo_status(user: User = Depends(admin_user), db: Session = Depends(get_db)):
    from ..demo import demo_user as get_demo
    return {"exists": get_demo(db) is not None}


@router.post("/demo")
def demo_create(user: User = Depends(admin_user), db: Session = Depends(get_db)):
    """Create (or reset) Bruce Willis with a fresh year of data."""
    from ..demo import delete_demo, seed_demo
    delete_demo(db)
    seed_demo(db)
    return {"exists": True}


@router.post("/demo/enrich")
def demo_enrich(user: User = Depends(admin_user), db: Session = Depends(get_db)):
    """Top up an existing demo with data newer features expect (e.g. the food
    beta) without resetting its year of training history. No-op when current."""
    from ..demo import enrich_demo
    return enrich_demo(db)


@router.delete("/demo")
def demo_delete(user: User = Depends(admin_user), db: Session = Depends(get_db)):
    from ..demo import delete_demo
    delete_demo(db)
    return {"exists": False}


@router.delete("/recipes")
def wipe_recipes(user: User = Depends(admin_user), db: Session = Depends(get_db)):
    """Empty the recipe library — for running an MCP-populated library. Also
    retires the shared household food week that referenced the seeded recipes so
    the Food screen is a clean slate ("No food week yet"). Meal logs (which
    snapshot their own macros) are untouched, as is the pantry/ingredient
    reference. Pair with SEED_RECIPES=false so a boot never re-seeds them."""
    from ..models import MealRevision, Recipe
    recipes = db.query(Recipe).delete(synchronize_session=False)
    weeks = (db.query(MealRevision)
             .filter(MealRevision.user_id.is_(None), MealRevision.status == "active")
             .update({"status": "superseded"}, synchronize_session=False))
    db.commit()
    return {"recipes_deleted": recipes, "food_weeks_retired": weeks}
