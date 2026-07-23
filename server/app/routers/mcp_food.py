"""External MCP endpoint (food surface) — lets outside automations log what was
eaten on the spot (orders out: venue, cost, macros, photos), import recipes into
the shared library (source URL, imagery, ratings, done-when steps), and maintain
the shared pantry: the canonical per-100g ingredient reference that recipe
imports draw on (bulk import, list, update, delete).

Deliberately hand-rolled: a stateless Streamable-HTTP MCP server is one POST
endpoint speaking JSON-RPC (initialize / tools list / tools call), which keeps
the runtime image dependency-free and the whole surface testable with the
sqlite smoke tests. No sessions, no SSE — every response is a single JSON body,
which the spec allows and Claude clients accept.

Auth mirrors /ingest: the per-user ingest token IS the identity (Settings →
Connections). The demo seat may log its own meals but can never write the
household-shared recipe library."""

import json
import logging
import re
from datetime import datetime
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from sqlalchemy.orm import Session

from ..config import get_settings, local_today
from ..db import get_db
from ..media import store_images
from ..models import MACRO_FIELDS, Ingredient, MealLog, Recipe, User
from ..security import user_for_ingest_token
from .mcp_oauth import user_for_mcp_token
from .food import SLOT_ORDER, query_recipes, recipe_card, targets_for
from .training import parse_date

log = logging.getLogger("forge.mcp")

router = APIRouter(tags=["mcp"])

PROTOCOL_VERSIONS = {"2025-06-18", "2025-03-26", "2024-11-05"}
SERVER_INFO = {"name": "forge-food", "version": "1.0.0"}
INSTRUCTIONS = (
    "Forge nutrition tools for two-seat self-hosted use. log_food records something "
    "eaten right now (restaurant/store orders welcome: venue, cost, photos); macros are "
    "totals for the portion eaten — estimate honestly and set estimated=true when unsure. "
    "import_recipe adds to the shared recipe library: macros are PER SERVING and "
    "cross-checked against the source where possible; steps must be REWRITTEN in Forge's "
    "done-when voice (each step states the cue that tells you it's done) — never paste "
    "source prose verbatim; always keep source_url attribution. The pantry tools "
    "(list/bulk_import/update/delete_ingredients) maintain the shared per-100g ingredient "
    "reference; keep it stocked so recipe imports don't park as incomplete."
)

_MACRO_PROPS = {k: {"type": "number", "description": ("kilocalories" if k == "kcal" else
                                                      "milligrams" if k.endswith("_mg") else "grams")}
                for k in MACRO_FIELDS}

# Ingredient-table columns mirror MACRO_FIELDS, per 100 g/ml: kcal→kcal_100,
# protein_g→protein_100, sodium_mg→sodium_100.
ING_MACROS = tuple(k.removesuffix("_g").removesuffix("_mg") + "_100" for k in MACRO_FIELDS)
AISLES = ("produce", "protein", "dairy", "cupboard", "frozen")
_ING_MACRO_PROPS = {k: {"type": "number",
                        "description": ("kcal" if k == "kcal_100" else "mg" if k == "sodium_100" else "grams")
                                       + " per 100 g/ml (per item when unit is 'x')"}
                    for k in ING_MACROS}
UNITS = ("g", "ml", "x")
# One ingredient's reference fields — shared by import_recipe (inline creation)
# and the dedicated pantry tools. Values are per 100 g/ml from a trusted
# nutrition source (USDA FoodData Central / McCance & Widdowson).
_ING_ITEM_PROPS = {
    "name": {"type": "string", "description": "Canonical ingredient name — this is the identity (re-import updates in place)"},
    "aisle": {"type": "string", "enum": list(AISLES)},
    "unit": {"type": "string", "enum": list(UNITS), "description": "g | ml | per-item (x)"},
    "pack": {"type": "string", "description": "Typical shop pack, e.g. '400 g tin'"},
    "pantry": {"type": "boolean", "description": "Staple that never lands on a shopping list"},
    **_ING_MACRO_PROPS,
}


def _ingredient_dict(i: Ingredient) -> dict:
    return {"name": i.name, "aisle": i.aisle, "unit": i.unit, "pack": i.pack,
            "pantry": bool(i.pantry), **{c: getattr(i, c) for c in ING_MACROS}}


def _apply_ingredient_fields(row: Ingredient, d: dict) -> None:
    """Set only the reference fields present in `d` — safe for partial updates
    (an omitted field is left untouched; a new row falls to the model defaults)."""
    if d.get("aisle") in AISLES:
        row.aisle = d["aisle"]
    if d.get("unit") in UNITS:
        row.unit = d["unit"]
    if "pack" in d:
        row.pack = (d.get("pack") or "")[:40]
    if "pantry" in d:
        row.pantry = 1 if d.get("pantry") else 0
    for c in ING_MACROS:
        if d.get(c) is not None:
            setattr(row, c, round(float(d[c]), 1))


def _new_ingredient(name: str, d: dict) -> Ingredient:
    row = Ingredient(name=name[:80])
    _apply_ingredient_fields(row, d)
    return row


class ToolError(Exception):
    pass


# ---------------------------------------------------------------- tools

TOOLS: list[dict] = [
    {
        "name": "log_food",
        "description": (
            "Log something eaten at (or near) the moment — a meal out, a store-bought "
            "snack, an off-plan extra. Macros are totals for what was actually eaten. "
            "If macros are estimates, say so with estimated=true (the app shows an "
            "'estimated' tag). Photos may be https URLs or data: URIs; they are stored "
            "on the Forge box, private to this user."),
        "inputSchema": {
            "type": "object",
            "properties": {
                "description": {"type": "string", "description": "What was eaten, e.g. 'Chicken burrito bowl, no rice'"},
                "date": {"type": "string", "description": "YYYY-MM-DD; omit for today"},
                "slot": {"type": "string", "enum": SLOT_ORDER,
                         "description": "Omit to infer from the current time of day"},
                "venue": {"type": "string", "description": "Restaurant/store name, if bought out"},
                "cost": {"type": "number", "description": "What it cost, in `currency`"},
                "currency": {"type": "string", "description": "e.g. USD, GBP, EUR"},
                "servings": {"type": "number", "default": 1},
                **_MACRO_PROPS,
                "estimated": {"type": "boolean", "default": True},
                "photos": {"type": "array", "items": {"type": "string"},
                           "description": "Image URLs or data: URIs"},
                "note": {"type": "string"},
                "client_id": {"type": "string", "description": "Idempotency key — retries with the same id never double-log"},
            },
            "required": ["description", "kcal"],
        },
    },
    {
        "name": "get_food_log",
        "description": "What's been logged (and the day's macro totals vs targets) for a date or short range.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "date": {"type": "string", "description": "YYYY-MM-DD; omit for today"},
                "days": {"type": "integer", "minimum": 1, "maximum": 14, "default": 1,
                         "description": "How many days from `date` inclusive"},
            },
        },
    },
    {
        "name": "delete_food_log",
        "description": "Remove a previously logged entry by its id (from log_food or get_food_log).",
        "inputSchema": {
            "type": "object",
            "properties": {"log_id": {"type": "string"}},
            "required": ["log_id"],
        },
    },
    {
        "name": "import_recipe",
        "description": (
            "Import a recipe into the shared Forge library. Macros are PER SERVING — "
            "recompute from the ingredients and cross-check against the source's "
            "published nutrition when available. Steps must be rewritten in Forge's "
            "done-when voice: each step's detail states the sensory cue that tells the "
            "cook it's done ('until the onions are translucent, ~5 min') — NEVER copy "
            "source prose verbatim. source_url is required and kept as attribution. "
            "Re-importing the same slug or source_url updates the existing entry. "
            "Ingredients unknown to Forge's pantry reference park the recipe as "
            "incomplete (never proposed by the coach, still browsable) UNLESS the "
            "ingredient entry carries per-100g reference macros (kcal_100 at minimum "
            "— look them up from the source or a nutrition database), which adds it "
            "to the canonical reference. Difficulty above medium also parks."),
        "inputSchema": {
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "slug": {"type": "string", "description": "kebab-case id; omit to derive from name"},
                "kind": {"type": "string", "enum": ["dinner", "breakfast", "lunch", "snack"], "default": "dinner"},
                "minutes": {"type": "integer", "description": "Active + passive time to plate"},
                "difficulty": {"type": "string", "enum": ["easy", "medium", "hard"], "default": "easy"},
                "serves": {"type": "integer", "default": 2},
                "batch": {"type": "integer", "default": 0,
                          "description": "Extra servings boxed for a zero-cook night"},
                **_MACRO_PROPS,
                "why": {"type": "string", "description": "One-liner: why this earns a place in the week"},
                "ingredients": {"type": "array", "items": {
                    "type": "object",
                    "properties": {"name": {"type": "string"}, "qty": {"type": "number"},
                                   "unit": {"type": "string", "description": "g | ml | x"},
                                   "disp": {"type": "string", "description": "Human amount, e.g. '1 tin'"},
                                   "note": {"type": "string"},
                                   **_ING_MACRO_PROPS,
                                   "aisle": {"type": "string", "enum": list(AISLES)},
                                   "pantry": {"type": "boolean",
                                              "description": "Staple that never hits a shopping list"}},
                    "required": ["name"]}},
                "steps": {"type": "array", "items": {
                    "type": "object",
                    "properties": {"title": {"type": "string"}, "detail": {"type": "string",
                                   "description": "Done-when voice, your own words"},
                                   "minutes": {"type": "integer"},
                                   "timer": {"type": "boolean", "description": "Show a countdown for `minutes` in cook mode"},
                                   "parallel": {"type": "boolean", "description": "Background step: the cook starts its "
                                                "timer and moves on to later steps while it runs (e.g. a simmer or a "
                                                "bake that cooks unattended). Implies timer."},
                                   "image": {"type": "string", "description": "Step photo URL or data: URI"}},
                    "required": ["title", "detail"]}},
                "tags": {"type": "array", "items": {"type": "string"}},
                "images": {"type": "array", "items": {"type": "string"},
                           "description": "Hero/gallery image URLs or data: URIs (first = hero)"},
                "rating": {"type": "number", "minimum": 0, "maximum": 5,
                           "description": "Source-site rating out of 5"},
                "rating_count": {"type": "integer"},
                "source": {"type": "string", "description": "Short origin label, e.g. 'bbc-good-food'"},
                "source_url": {"type": "string", "description": "Original recipe URL — required attribution"},
            },
            "required": ["name", "source_url", "ingredients", "steps", "kcal", "protein_g"],
        },
    },
    {
        "name": "search_recipes",
        "description": "Search the Forge recipe library by name/tag/kind. Use before importing — the recipe may already exist.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Matches name and tags, case-insensitive"},
                "kind": {"type": "string", "enum": ["dinner", "breakfast", "lunch", "snack"]},
                "include_incomplete": {"type": "boolean", "default": False},
            },
        },
    },
    {
        "name": "get_recipe",
        "description": "Full detail for one recipe: per-serving macros, ingredients, done-when steps, images, rating, source attribution.",
        "inputSchema": {
            "type": "object",
            "properties": {"slug": {"type": "string"}},
            "required": ["slug"],
        },
    },
    {
        "name": "list_ingredients",
        "description": (
            "Browse the shared pantry — Forge's canonical ingredient reference (per-100g "
            "macros, aisle, pantry-staple flag). Recipe imports draw on it; an ingredient "
            "missing here parks a recipe as incomplete. Call before bulk_import_ingredients "
            "to see what's already stocked."),
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Case-insensitive name substring"},
                "aisle": {"type": "string", "enum": list(AISLES)},
                "pantry_only": {"type": "boolean", "description": "Only staples that skip the shopping list"},
                "limit": {"type": "integer", "minimum": 1, "maximum": 500, "default": 200},
            },
        },
    },
    {
        "name": "bulk_import_ingredients",
        "description": (
            "Add or refresh many pantry items at once. Each item's `name` is its identity; "
            "an existing name is updated in place (only the fields you supply change) unless "
            "overwrite=false, which skips it. Supply per-100g macros from a trusted source "
            "(USDA FoodData Central / McCance & Widdowson) so imports that use the ingredient "
            "can complete. Household-shared, like the recipe library."),
        "inputSchema": {
            "type": "object",
            "properties": {
                "ingredients": {"type": "array", "items": {
                    "type": "object", "properties": _ING_ITEM_PROPS, "required": ["name"]}},
                "overwrite": {"type": "boolean", "default": True,
                              "description": "Update existing names in place (false = skip them)"},
            },
            "required": ["ingredients"],
        },
    },
    {
        "name": "update_ingredient",
        "description": "Patch one pantry item by name — only the fields you pass change. Errors if the name isn't stocked (use bulk_import_ingredients to add).",
        "inputSchema": {
            "type": "object",
            "properties": _ING_ITEM_PROPS,
            "required": ["name"],
        },
    },
    {
        "name": "delete_ingredient",
        "description": "Remove a pantry item by name. Reports how many recipes still reference it (they fall back to a plain 'cupboard' aisle at read time).",
        "inputSchema": {
            "type": "object",
            "properties": {"name": {"type": "string"}},
            "required": ["name"],
        },
    },
]


def _infer_slot() -> str:
    hour = datetime.now(ZoneInfo(get_settings().coach_tz)).hour
    if hour < 11:
        return "breakfast"
    if hour < 15:
        return "lunch"
    if hour < 21:
        return "dinner"
    return "snack"


def _day_summary(db: Session, user: User, day) -> dict:
    rows = (db.query(MealLog).filter(MealLog.user_id == user.id, MealLog.day == day)
            .order_by(MealLog.ts).all())
    totals = {k: round(sum(getattr(r, k) or 0 for r in rows), 1) for k in MACRO_FIELDS}
    return {
        "date": str(day),
        "logged": [{"id": r.id, "slot": r.slot, "label": r.label, "servings": r.servings,
                    **{k: getattr(r, k) or 0 for k in MACRO_FIELDS},
                    "venue": r.venue or "", "cost": r.cost or 0, "currency": r.currency or "",
                    "estimated": bool(r.estimated), "recipe": r.recipe_slug or None,
                    "photos": r.photos or []} for r in rows],
        "totals": totals,
    }


def _tool_log_food(db: Session, user: User, a: dict) -> dict:
    slot = a.get("slot") or _infer_slot()
    if slot not in SLOT_ORDER:
        raise ToolError(f"slot must be one of {SLOT_ORDER}")
    day = parse_date(a.get("date"))
    if a.get("client_id"):
        existing = (db.query(MealLog)
                    .filter(MealLog.user_id == user.id, MealLog.client_id == a["client_id"]).first())
        if existing:
            return {"id": existing.id, "duplicate": True, **_day_summary(db, user, day),
                    "targets": targets_for(user)}
    photos, warnings = store_images(db, user.id, a.get("photos") or [])
    row = MealLog(user_id=user.id, day=day, slot=slot,
                  label=(a.get("description") or "")[:120],
                  servings=a.get("servings") or 1, source="mcp",
                  estimated=1 if a.get("estimated", True) else 0,
                  client_id=a.get("client_id"),
                  venue=(a.get("venue") or "")[:80], cost=a.get("cost") or 0,
                  currency=(a.get("currency") or "")[:8], note=a.get("note") or "",
                  photos=photos,
                  **{k: a.get(k) or 0 for k in MACRO_FIELDS})
    db.add(row)
    db.commit()
    out = {"id": row.id, "duplicate": False, **_day_summary(db, user, day),
           "targets": targets_for(user)}
    if warnings:
        out["warnings"] = warnings
    return out


def _tool_get_food_log(db: Session, user: User, a: dict) -> dict:
    from datetime import timedelta
    start = parse_date(a.get("date"))
    n = min(max(int(a.get("days") or 1), 1), 14)
    return {"days": [_day_summary(db, user, start + timedelta(days=i)) for i in range(n)],
            "targets": targets_for(user), "today": str(local_today())}


def _tool_delete_food_log(db: Session, user: User, a: dict) -> dict:
    row = (db.query(MealLog)
           .filter(MealLog.id == a.get("log_id", ""), MealLog.user_id == user.id).first())
    if not row:
        raise ToolError("log entry not found")
    day = row.day
    db.delete(row)
    db.commit()
    return {"ok": True, **_day_summary(db, user, day)}


def _slugify(name: str) -> str:
    return re.sub(r"-{2,}", "-", re.sub(r"[^a-z0-9]+", "-", name.lower())).strip("-")[:60]


def _tool_import_recipe(db: Session, user: User, a: dict) -> dict:
    if user.role == "demo":
        raise ToolError("the demo seat cannot write the shared recipe library")
    name = (a.get("name") or "").strip()
    source_url = (a.get("source_url") or "").strip()
    if not name or not source_url:
        raise ToolError("name and source_url are required")
    if not source_url.startswith(("http://", "https://")):
        raise ToolError("source_url must be an http(s) URL back to the original recipe")
    slug = _slugify(a.get("slug") or name)
    if not slug:
        raise ToolError("could not derive a slug — pass one explicitly")
    kind = a.get("kind") or "dinner"
    if kind not in SLOT_ORDER:
        raise ToolError(f"kind must be one of {SLOT_ORDER}")
    difficulty = a.get("difficulty") or "easy"
    steps_in = a.get("steps") or []
    ingredients = a.get("ingredients") or []
    if not steps_in or not ingredients:
        raise ToolError("steps and ingredients must be non-empty")
    for s in steps_in:
        if not (s.get("title") and s.get("detail")):
            raise ToolError("every step needs a title and a done-when detail")

    warnings: list[str] = []
    names = [i.get("name", "") for i in ingredients]
    known = {n for (n,) in db.query(Ingredient.name).filter(Ingredient.name.in_(names)).all()}
    # an unknown ingredient joins the canonical reference iff the import supplies
    # per-100g macros for it (kcal_100 is the gate) — otherwise it parks the recipe
    created: list[str] = []
    unknown: list[str] = []
    for i in ingredients:
        n = i.get("name", "")
        if not n or n in known:
            continue
        if i.get("kcal_100") is None:
            unknown.append(n)
            continue
        db.add(_new_ingredient(n, i))
        known.add(n)
        created.append(n)
    if unknown:
        warnings.append("unknown ingredients (recipe parked as incomplete — re-import with "
                        f"per-100g macros to add them): {', '.join(unknown)}")
    if difficulty == "hard":
        warnings.append("difficulty 'hard' is above the library ceiling — parked as incomplete")
    if not a.get("kcal"):
        warnings.append("kcal is zero — parked as incomplete")
    complete = 0 if warnings else 1

    # recipe imagery is household-shared, like the library itself
    images, img_warn = store_images(db, None, a.get("images") or [])
    warnings += img_warn
    steps = []
    for s in steps_in:
        step = {"title": s["title"], "detail": s["detail"]}
        if s.get("minutes") is not None:
            step["minutes"] = s["minutes"]
        if s.get("timer") or s.get("parallel"):
            step["timer"] = True  # a background step always needs its countdown
        if s.get("parallel"):
            step["parallel"] = True
        if s.get("image"):
            ref, warn = store_images(db, None, [s["image"]])
            if ref:
                step["image"] = ref[0]
            if warn:
                warnings += warn
        steps.append(step)

    # the source page is the import's identity — same URL always updates in place,
    # whatever slug was derived this time; only then does a slug clash matter
    existing = db.query(Recipe).filter(Recipe.source_url == source_url).first()
    if existing:
        slug = existing.slug
    else:
        existing = db.query(Recipe).filter(Recipe.slug == slug).first()
    if existing and existing.source == "seed":
        raise ToolError(f"'{slug}' is a curated seed recipe — pick a different slug")

    updated = existing is not None
    r = existing or Recipe(slug=slug)
    r.name = name[:120]
    r.kind = kind
    r.minutes = int(a.get("minutes") or 0)
    r.difficulty = difficulty
    r.serves = max(int(a.get("serves") or 2), 1)
    r.batch = int(a.get("batch") or 0)
    for k in MACRO_FIELDS:
        setattr(r, k, round(float(a.get(k) or 0), 1))
    r.why = a.get("why") or ""
    r.steps = steps
    r.ingredients = [{"name": i.get("name", ""), "qty": i.get("qty"), "unit": i.get("unit", ""),
                      "disp": i.get("disp", ""), "note": i.get("note", "")} for i in ingredients]
    r.tags = a.get("tags") or []
    r.platefig = r.platefig or "plate"
    r.source = (a.get("source") or "import")[:24]
    r.source_url = source_url
    r.images = images or (r.images or [])
    r.rating = min(max(float(a.get("rating") or 0), 0), 5)
    r.rating_count = int(a.get("rating_count") or 0)
    r.complete = complete
    db.add(r)
    db.commit()
    out = {"slug": r.slug, "updated": updated, "complete": bool(complete),
           "images_stored": len(images), "app_path": f"/api/food/recipes/{r.slug}"}
    if created:
        out["ingredients_added"] = created
    if warnings:
        out["warnings"] = warnings
    return out


def _tool_search_recipes(db: Session, user: User, a: dict) -> dict:
    rows = query_recipes(db, a.get("kind"), a.get("query") or "",
                         bool(a.get("include_incomplete")))
    return {"count": len(rows),
            "recipes": [{**recipe_card(r), "tags": r.tags or [], "source": r.source,
                         "source_url": r.source_url, "complete": bool(r.complete)} for r in rows]}


def _tool_get_recipe(db: Session, user: User, a: dict) -> dict:
    r = db.query(Recipe).filter(Recipe.slug == a.get("slug", "")).first()
    if not r:
        raise ToolError("unknown recipe slug")
    return {**recipe_card(r), "steps": r.steps or [], "ingredients": r.ingredients or [],
            "tags": r.tags or [], "images": r.images or [], "rating": r.rating or 0,
            "rating_count": r.rating_count or 0, "source": r.source,
            "source_url": r.source_url, "complete": bool(r.complete)}


def _reject_demo_pantry(user: User) -> None:
    if user.role == "demo":
        raise ToolError("the demo seat cannot write the shared pantry reference")


def _tool_list_ingredients(db: Session, user: User, a: dict) -> dict:
    q = db.query(Ingredient)
    if a.get("aisle") in AISLES:
        q = q.filter(Ingredient.aisle == a["aisle"])
    if a.get("pantry_only"):
        q = q.filter(Ingredient.pantry == 1)
    rows = q.order_by(Ingredient.aisle, Ingredient.name).all()
    term = (a.get("query") or "").lower().strip()
    if term:
        rows = [r for r in rows if term in r.name.lower()]
    limit = min(max(int(a.get("limit") or 200), 1), 500)
    return {"count": len(rows), "ingredients": [_ingredient_dict(r) for r in rows[:limit]]}


def _tool_bulk_import_ingredients(db: Session, user: User, a: dict) -> dict:
    _reject_demo_pantry(user)
    items = a.get("ingredients") or []
    if not items:
        raise ToolError("ingredients must be a non-empty array")
    overwrite = a.get("overwrite", True)
    wanted = [(x.get("name") or "").strip()[:80] for x in items]
    have = {i.name: i for i in
            db.query(Ingredient).filter(Ingredient.name.in_([n for n in wanted if n])).all()}
    created: list[str] = []
    updated: list[str] = []
    skipped: list[str] = []
    for x in items:
        n = (x.get("name") or "").strip()[:80]
        if not n:
            skipped.append("(unnamed)")
            continue
        row = have.get(n)
        if row:
            if not overwrite:
                skipped.append(n)
                continue
            _apply_ingredient_fields(row, x)
            updated.append(n)
        else:
            row = _new_ingredient(n, x)
            db.add(row)
            have[n] = row  # dedupe repeats within one payload
            created.append(n)
    db.commit()
    return {"count": len(created) + len(updated),
            "created": created, "updated": updated, "skipped": skipped}


def _tool_update_ingredient(db: Session, user: User, a: dict) -> dict:
    _reject_demo_pantry(user)
    name = (a.get("name") or "").strip()
    row = db.query(Ingredient).filter(Ingredient.name == name).first()
    if not row:
        raise ToolError(f"no pantry item named '{name}' — add it with bulk_import_ingredients")
    _apply_ingredient_fields(row, a)
    db.commit()
    return {"ok": True, "ingredient": _ingredient_dict(row)}


def _tool_delete_ingredient(db: Session, user: User, a: dict) -> dict:
    _reject_demo_pantry(user)
    name = (a.get("name") or "").strip()
    row = db.query(Ingredient).filter(Ingredient.name == name).first()
    if not row:
        raise ToolError(f"no pantry item named '{name}'")
    refs = sum(1 for r in db.query(Recipe.ingredients).all()
               if any((ing or {}).get("name") == name for ing in (r[0] or [])))
    db.delete(row)
    db.commit()
    return {"deleted": True, "recipes_referencing": refs}


HANDLERS = {
    "log_food": _tool_log_food,
    "get_food_log": _tool_get_food_log,
    "delete_food_log": _tool_delete_food_log,
    "import_recipe": _tool_import_recipe,
    "search_recipes": _tool_search_recipes,
    "get_recipe": _tool_get_recipe,
    "list_ingredients": _tool_list_ingredients,
    "bulk_import_ingredients": _tool_bulk_import_ingredients,
    "update_ingredient": _tool_update_ingredient,
    "delete_ingredient": _tool_delete_ingredient,
}


# ---------------------------------------------------------------- transport

def _rpc_error(rid, code: int, message: str, status: int = 200) -> JSONResponse:
    return JSONResponse({"jsonrpc": "2.0", "id": rid, "error": {"code": code, "message": message}},
                        status_code=status)


def _rpc_result(rid, result: dict) -> JSONResponse:
    return JSONResponse({"jsonrpc": "2.0", "id": rid, "result": result})


def _www_auth(request: Request) -> dict:
    """401 header pointing at the resource metadata — this is what makes Claude's
    connector UI discover the OAuth flow instead of giving up (RFC 9728 §5.1)."""
    from ..security import public_base_url
    base = public_base_url(request)
    return {"WWW-Authenticate":
            f'Bearer resource_metadata="{base}/.well-known/oauth-protected-resource/mcp"'}


@router.post("/mcp")
async def mcp_endpoint(request: Request, db: Session = Depends(get_db)):
    token = request.headers.get("authorization", "").removeprefix("Bearer ").strip()
    user = user_for_mcp_token(db, token)  # OAuth access token (connector UI)
    if not user:
        tok = user_for_ingest_token(db, token)  # ingest token (mcp-remote / config file)
        user = db.get(User, tok.user_id) if tok else None
    if not user:
        return JSONResponse({"error": "missing or unknown bearer token — connect via OAuth "
                                      "or use your Forge ingest token"},
                            status_code=401, headers=_www_auth(request))

    try:
        msg = json.loads(await request.body())
    except (json.JSONDecodeError, UnicodeDecodeError):
        return _rpc_error(None, -32700, "parse error", status=400)
    if isinstance(msg, list):
        return _rpc_error(None, -32600, "batch requests are not supported", status=400)
    method = msg.get("method", "")
    rid = msg.get("id")
    params = msg.get("params") or {}

    if method.startswith("notifications/"):
        return Response(status_code=202)
    if method == "initialize":
        asked = params.get("protocolVersion", "")
        return _rpc_result(rid, {
            "protocolVersion": asked if asked in PROTOCOL_VERSIONS else "2025-06-18",
            "capabilities": {"tools": {}},
            "serverInfo": SERVER_INFO,
            "instructions": INSTRUCTIONS,
        })
    if method == "ping":
        return _rpc_result(rid, {})
    if method == "tools/list":
        return _rpc_result(rid, {"tools": TOOLS})
    if method == "tools/call":
        name = params.get("name", "")
        handler = HANDLERS.get(name)
        if not handler:
            return _rpc_error(rid, -32602, f"unknown tool: {name}")
        try:
            result = handler(db, user, params.get("arguments") or {})
        except ToolError as e:
            return _rpc_result(rid, {"content": [{"type": "text", "text": str(e)}], "isError": True})
        except HTTPException as e:  # reused route helpers raise these (e.g. bad date)
            return _rpc_result(rid, {"content": [{"type": "text", "text": str(e.detail)}], "isError": True})
        except Exception:
            log.exception("mcp tool %s failed for %s", name, user.email)
            db.rollback()
            return _rpc_result(rid, {"content": [{"type": "text", "text": "internal error — see server logs"}],
                                     "isError": True})
        return _rpc_result(rid, {"content": [{"type": "text", "text": json.dumps(result)}],
                                 "structuredContent": result, "isError": False})
    return _rpc_error(rid, -32601, f"method not found: {method}")


@router.get("/mcp")
async def mcp_get():
    # stateless server: no server-initiated SSE stream to offer
    return Response(status_code=405, headers={"Allow": "POST"})
