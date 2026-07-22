"""Nutrition routes (beta track, Phase 7 — stories E16). The food week is
household-shared for members (meal_revisions.user_id IS NULL); the demo seat
only ever sees rows under its own user_id. Meal logs are strictly per-user."""

from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..config import local_today
from ..db import get_db
from ..food_seed import DEFAULT_TARGETS
from ..models import MACRO_FIELDS, Ingredient, MealLog, MealRevision, MediaBlob, Recipe, User
from ..security import current_user
from .training import DAY_NAMES, parse_date

router = APIRouter(prefix="/api/food", tags=["food"])

SLOT_ORDER = ["breakfast", "lunch", "dinner", "snack"]


def food_scope(user: User) -> str | None:
    """NULL scope = the member household; the demo seat is walled into its own."""
    return user.id if user.role == "demo" else None


def active_meal_revision(db: Session, user: User) -> MealRevision | None:
    scope = food_scope(user)
    q = db.query(MealRevision).filter(MealRevision.status == "active")
    q = q.filter(MealRevision.user_id == scope) if scope else q.filter(MealRevision.user_id.is_(None))
    return q.order_by(MealRevision.num.desc()).first()


def recipe_card(r: Recipe) -> dict:
    return {"slug": r.slug, "name": r.name, "kind": r.kind, "minutes": r.minutes,
            "difficulty": r.difficulty, "serves": r.serves, "batch": r.batch,
            "platefig": r.platefig, "why": r.why,
            "image": (r.images or [None])[0], "rating": r.rating or 0,
            **{k: getattr(r, k) for k in MACRO_FIELDS}}


def targets_for(user: User) -> dict:
    t = (user.prefs or {}).get("nutrition_targets") or {}
    return {**DEFAULT_TARGETS, **t}


def _resolve_slot(entry: dict, days: dict, recipes: dict[str, Recipe]) -> dict | None:
    """Resolve one planned slot entry into an API shape. Leftover slots inherit
    the referenced day's dinner recipe (dimmed by the UI)."""
    if not entry:
        return None
    out: dict = {"why": entry.get("why", "")}
    if entry.get("out"):
        return {**out, "out": True, "note": entry.get("note", "")}
    if entry.get("order"):
        return {**out, "order": True, "note": entry.get("note", "")}
    slug = entry.get("recipe")
    if entry.get("leftover_of") is not None:
        src_day = days.get(str(entry["leftover_of"])) or {}
        slug = ((src_day.get("slots") or {}).get("dinner") or {}).get("recipe")
        out["leftover"] = True
    r = recipes.get(slug or "")
    if not r:
        return {**out, "note": entry.get("note", "unplanned")}
    return {**out, "recipe": recipe_card(r)}


@router.get("/week")
def food_week(date: str | None = None, user: User = Depends(current_user),
              db: Session = Depends(get_db)):
    """Calendar-week food view (Mon–Sun), same contract as /api/week."""
    base = parse_date(date)
    base = base - timedelta(days=base.weekday())  # snap to Monday
    actual_today = local_today()
    rev = active_meal_revision(db, user)
    days = ((rev.content or {}).get("days", {}) or {}) if rev else {}

    slugs = {s.get("recipe") for d in days.values() for s in (d.get("slots") or {}).values()
             if s and s.get("recipe")}
    recipes = {r.slug: r for r in db.query(Recipe).filter(Recipe.slug.in_(slugs)).all()} if slugs else {}

    logs = (db.query(MealLog)
            .filter(MealLog.user_id == user.id, MealLog.day >= base,
                    MealLog.day <= base + timedelta(days=6))
            .order_by(MealLog.ts).all())
    by_day: dict[str, list[MealLog]] = {}
    for lg in logs:
        by_day.setdefault(str(lg.day), []).append(lg)

    out_days = []
    for i in range(7):
        d = base + timedelta(days=i)
        entry = days.get(str(d.weekday())) or {}
        slots_in = entry.get("slots") or {}
        day_logs = by_day.get(str(d), [])
        matched_ids: set[str] = set()
        slots_out = []
        for slot in SLOT_ORDER:
            resolved = _resolve_slot(slots_in.get(slot), days, recipes)
            if resolved is None:
                continue
            match = next((lg for lg in day_logs if lg.slot == slot and lg.id not in matched_ids), None)
            if match:
                matched_ids.add(match.id)
            resolved.update({"slot": slot, "logged": bool(match),
                             "log_id": match.id if match else None})
            slots_out.append(resolved)
        extras = [lg for lg in day_logs if lg.id not in matched_ids]
        totals = {k: round(sum(getattr(lg, k) or 0 for lg in day_logs), 1) for k in MACRO_FIELDS}
        out_days.append({
            "date": str(d), "day_name": DAY_NAMES[d.weekday()], "is_today": d == actual_today,
            "slots": slots_out,
            "extras": [{"id": lg.id, "slot": lg.slot, "label": lg.label,
                        **{k: getattr(lg, k) or 0 for k in MACRO_FIELDS},
                        "estimated": bool(lg.estimated), "venue": lg.venue or "",
                        "cost": lg.cost or 0, "currency": lg.currency or "",
                        "note": lg.note or "", "photos": lg.photos or []} for lg in extras],
            "totals": totals,
        })

    return {"start": str(base), "today": str(actual_today), "days": out_days,
            "targets": targets_for(user),
            "rationale": rev.rationale if rev else "", "has_plan": rev is not None}


@router.get("/proposal")
def food_proposal(user: User = Depends(current_user), db: Session = Depends(get_db)):
    """The pending food-week proposal for this household (Phase 8, E16.3).
    Ships a slug→card map so the UI renders names/plate art without N fetches."""
    scope = food_scope(user)
    q = db.query(MealRevision).filter(MealRevision.status == "proposed")
    q = q.filter(MealRevision.user_id == scope) if scope else q.filter(MealRevision.user_id.is_(None))
    rev = q.order_by(MealRevision.num.desc()).first()
    if not rev:
        return {"proposal": None}
    days = (rev.content or {}).get("days", {}) or {}
    slugs = {s.get("recipe") for d in days.values() for s in (d.get("slots") or {}).values()
             if s and s.get("recipe")}
    cards = {r.slug: recipe_card(r) for r in db.query(Recipe).filter(Recipe.slug.in_(slugs)).all()} if slugs else {}
    return {"proposal": {"id": rev.id, "num": rev.num, "rationale": rev.rationale,
                         "changes": rev.changes or [], "content": rev.content,
                         "recipes": cards, "created_at": rev.created_at.isoformat()}}


def _owned_food_proposal(db: Session, user: User, rid: str) -> MealRevision:
    rev = db.get(MealRevision, rid)
    if not rev or rev.status != "proposed" or rev.user_id != food_scope(user):
        raise HTTPException(status_code=404, detail="proposal not found")
    return rev


@router.post("/proposal/{rid}/approve")
def approve_food_proposal(rid: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    rev = _owned_food_proposal(db, user, rid)
    scope = food_scope(user)
    q = db.query(MealRevision).filter(MealRevision.status == "active")
    q = q.filter(MealRevision.user_id == scope) if scope else q.filter(MealRevision.user_id.is_(None))
    q.update({"status": "superseded"})
    rev.status = "active"
    db.commit()
    return {"ok": True, "revision": rev.num}


@router.post("/proposal/{rid}/reject")
def reject_food_proposal(rid: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    rev = _owned_food_proposal(db, user, rid)
    rev.status = "superseded"
    db.commit()
    return {"ok": True}


@router.get("/recipes/{slug}")
def recipe_detail(slug: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    r = db.query(Recipe).filter(Recipe.slug == slug).first()
    if not r:
        raise HTTPException(status_code=404, detail="unknown recipe")
    names = [i.get("name") for i in (r.ingredients or [])]
    info = {i.name: i for i in db.query(Ingredient).filter(Ingredient.name.in_(names)).all()} if names else {}
    ingredients = []
    for i in (r.ingredients or []):
        meta = info.get(i.get("name"))
        ingredients.append({**i, "aisle": meta.aisle if meta else "cupboard",
                            "pantry": bool(meta.pantry) if meta else False})
    return {**recipe_card(r), "steps": r.steps or [], "ingredients": ingredients,
            "tags": r.tags or [], "source": r.source, "source_url": r.source_url,
            "images": r.images or [], "rating": r.rating or 0, "rating_count": r.rating_count or 0}


@router.get("/media/{blob_id}")
def food_media(blob_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Serve a stored food image. NULL owner = household-visible (recipe imagery,
    shared like the recipe library itself); owned blobs (meal photos) are private."""
    blob = db.get(MediaBlob, blob_id)
    if not blob or (blob.user_id and blob.user_id != user.id):
        raise HTTPException(status_code=404, detail="not found")
    return Response(content=blob.data, media_type=blob.mime,
                    headers={"Cache-Control": "private, max-age=31536000, immutable"})


class LogIn(BaseModel):
    date: str | None = None
    slot: str
    recipe: str | None = None
    servings: float = 1
    # off-plan entries (chat estimates land here in Phase 8) carry their own numbers
    label: str | None = None
    kcal: float | None = None
    protein_g: float | None = None
    carbs_g: float | None = None
    sugar_g: float | None = None
    fiber_g: float | None = None
    fat_g: float | None = None
    satfat_g: float | None = None
    sodium_mg: float | None = None
    estimated: bool = False
    source: str = "plan"
    client_id: str | None = None  # offline-queue idempotency
    # eaten-out context (MCP log_food / order logs); photos are stored refs, not raw uploads
    venue: str = ""
    cost: float = 0
    currency: str = ""
    note: str = ""
    photos: list[str] = []


def _day_totals(db: Session, user: User, day) -> dict:
    rows = db.query(MealLog).filter(MealLog.user_id == user.id, MealLog.day == day).all()
    return {k: round(sum(getattr(lg, k) or 0 for lg in rows), 1) for k in MACRO_FIELDS}


@router.post("/log")
def log_meal(body: LogIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    if body.slot not in SLOT_ORDER:
        raise HTTPException(status_code=400, detail=f"slot must be one of {SLOT_ORDER}")
    day = parse_date(body.date)
    if body.client_id:
        existing = (db.query(MealLog)
                    .filter(MealLog.user_id == user.id, MealLog.client_id == body.client_id)
                    .first())
        if existing:  # offline retry — already written
            return {"id": existing.id, "duplicate": True, "totals": _day_totals(db, user, day)}
    if body.recipe:
        r = db.query(Recipe).filter(Recipe.slug == body.recipe).first()
        if not r:
            raise HTTPException(status_code=400, detail="unknown recipe")
        n = body.servings
        row = MealLog(user_id=user.id, day=day, slot=body.slot, recipe_slug=r.slug,
                      label=r.name, servings=n, source=body.source, client_id=body.client_id,
                      **{k: round((getattr(r, k) or 0) * n, 1) for k in MACRO_FIELDS})
    else:
        if not body.label or body.kcal is None:
            raise HTTPException(status_code=400, detail="off-plan entries need label + kcal")
        row = MealLog(user_id=user.id, day=day, slot=body.slot, label=body.label,
                      servings=body.servings, source=body.source or "chat",
                      estimated=1 if body.estimated else 0, client_id=body.client_id,
                      **{k: getattr(body, k) or 0 for k in MACRO_FIELDS})
    row.venue, row.cost, row.currency = body.venue[:80], body.cost, body.currency[:8]
    row.note, row.photos = body.note, body.photos
    db.add(row)
    try:
        db.commit()
    except IntegrityError:
        # two retries raced past the existence check — the row is already there
        db.rollback()
        existing = (db.query(MealLog)
                    .filter(MealLog.user_id == user.id, MealLog.client_id == body.client_id)
                    .first())
        if existing:
            return {"id": existing.id, "duplicate": True, "totals": _day_totals(db, user, day)}
        raise
    return {"id": row.id, "duplicate": False, "totals": _day_totals(db, user, day)}


@router.delete("/log/{log_id}")
def unlog_meal(log_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    row = db.query(MealLog).filter(MealLog.id == log_id, MealLog.user_id == user.id).first()
    if not row:
        raise HTTPException(status_code=404, detail="not found")
    day = row.day
    db.delete(row)
    db.commit()
    return {"ok": True, "totals": _day_totals(db, user, day)}
