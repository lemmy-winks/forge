"""Phase 8 — coached food weeks (E16.3/E16.5): proposal validators + creation,
the food twin of `coach.create_proposal`. The coach writes the household's meal
plan only through here; nothing goes live without approval unless the acting
user opted into auto-apply.

Validator philosophy mirrors training: structural rules are hard errors the
model can fix and retry; the error strings say exactly what to change.
Macro checks run on WEEKLY AVERAGES of the planned week (the trio is coached
weekly, never per meal) with declared assumptions for order-out lunches.
"""

from __future__ import annotations

import json
import re
from datetime import date

from sqlalchemy.orm import Session

from .config import local_today
from .models import MACRO_FIELDS as MACROS
from .models import Carryover, MealRevision, Recipe, User

DAY_KEYS = ("0", "1", "2", "3", "4", "5", "6")
SLOTS = ("breakfast", "lunch", "dinner", "snack")

# What an order-assist lunch is coached to hit — counted into the weekly
# average so office days don't read as protein holes. Real numbers land when
# the meal is logged (chat estimate, flagged `estimated`).
ORDER_LUNCH_ASSUMED = {"kcal": 550.0, "protein_g": 40.0, "carbs_g": 45.0, "sugar_g": 8.0,
                       "fiber_g": 8.0, "fat_g": 20.0, "satfat_g": 6.0, "sodium_mg": 900.0}


def food_scope(user: User) -> str | None:
    from .routers.food import food_scope as fs
    return fs(user)


def _slot_recipe(entry: dict, days: dict) -> str | None:
    """Slug a slot resolves to — leftover slots inherit the source day's dinner."""
    if entry.get("leftover_of") is not None:
        src = days.get(str(entry["leftover_of"])) or {}
        return ((src.get("slots") or {}).get("dinner") or {}).get("recipe")
    return entry.get("recipe")


def validate_food_content(db: Session, user: User, content: dict, changes: list) -> str | None:
    days = content.get("days")
    if not isinstance(days, dict):
        return "content.days must be an object keyed '0' (Mon) .. '6' (Sun)"
    missing = [k for k in DAY_KEYS if k not in days]
    if missing:
        return f"every day must be planned — missing day(s) {missing}"
    if set(days) - set(DAY_KEYS):
        return f"bad day key(s) {sorted(set(days) - set(DAY_KEYS))} — use '0' (Mon) .. '6' (Sun)"
    if not changes:
        return "changes[] is required — one {sign:'+'|'-'|'~', what, why} row per meaningful change vs the current week"
    for c in changes:
        if not isinstance(c, dict) or c.get("sign") not in {"+", "-", "~"} or not c.get("what"):
            return "each changes[] row needs sign ('+'|'-'|'~') and what"

    recipes = {r.slug: r for r in db.query(Recipe).all()}
    zero_cook = 0
    totals = {k: 0.0 for k in MACROS}
    has_out = False

    for key in DAY_KEYS:
        slots = (days[key] or {}).get("slots")
        if not isinstance(slots, dict):
            return f"day {key}: needs a slots object"
        for slot in SLOTS:
            entry = slots.get(slot)
            if not isinstance(entry, dict):
                return f"day {key}: every slot must be planned — {slot} is missing (E16.3 AC2)"
            is_order, is_out, is_left = bool(entry.get("order")), bool(entry.get("out")), entry.get("leftover_of") is not None
            if is_order:
                if slot != "lunch":
                    return f"day {key}: order-assist slots are lunches only ({slot} can't be an order)"
                if not entry.get("note"):
                    return f"day {key}: order lunch needs a note with the target macros + budget"
                for k in MACROS:
                    totals[k] += ORDER_LUNCH_ASSUMED[k]
                continue
            if is_out:
                if slot != "dinner":
                    return f"day {key}: only dinner can be a night out"
                if not entry.get("note"):
                    return f"day {key}: the night out needs a note (it's a planned exception — say so)"
                has_out = True
                zero_cook += 1
                continue
            slug = _slot_recipe(entry, days)
            if is_left:
                src = str(entry["leftover_of"])
                if src not in DAY_KEYS:
                    return f"day {key}: leftover_of must reference a day key '0'..'6'"
                if not slug:
                    return f"day {key}: leftover_of {src} — that day has no cooked dinner recipe to inherit"
                if slot == "dinner":
                    zero_cook += 1
            r = recipes.get(slug or "")
            if not r:
                return f"day {key} {slot}: unknown recipe slug {slug!r} — use get_recipes"
            if not r.complete:
                return f"day {key} {slot}: {slug} is an incomplete draft — only complete recipes are proposable"
            if r.difficulty not in {"easy", "medium"}:
                return f"day {key} {slot}: {slug} exceeds the difficulty ceiling (easy | medium only)"
            if slot == "dinner" and not is_left and r.kind != "dinner":
                return f"day {key}: {slug} is a {r.kind} recipe — dinners need kind 'dinner'"
            if slot == "dinner" and not (entry.get("why") or "").strip():
                return f"day {key}: the dinner needs a why one-liner (the UI renders it)"
            for k in MACROS:
                totals[k] += float(getattr(r, k) or 0)
    if zero_cook < 1:
        return "at least one dinner must be zero-cook (a leftover night or the night out) — batch a recipe"

    # Weekly averages vs the acting user's targets. The planned week is a
    # floor, not the whole diet — the night out and off-plan extras top it up
    # (the seeded baseline plans ~65% of kcal), so protein/fiber floors sit
    # below target. The sat-fat cap is absolute: extras only ever ADD sat fat,
    # so the planned week must leave room under it.
    from .routers.food import targets_for
    t = targets_for(user)
    avg = {k: totals[k] / 7 for k in MACROS}
    if avg["protein_g"] < 0.65 * t["protein_g"]:
        return (f"planned protein averages {avg['protein_g']:.0f} g/day — too far below the "
                f"{t['protein_g']} g target for extras to close (floor: {0.65 * t['protein_g']:.0f} g planned)")
    if avg["fiber_g"] < 0.75 * t["fiber_g"]:
        return (f"planned fiber averages {avg['fiber_g']:.0f} g/day vs the {t['fiber_g']} g target "
                "— work in more beans, lentils, oats or veg")
    cap = t["satfat_g"] - (1 if has_out else 0)
    if avg["satfat_g"] > cap:
        return (f"planned sat fat averages {avg['satfat_g']:.1f} g/day vs the {t['satfat_g']} g cap"
                + (" — and a night out needs banked headroom below the cap" if has_out else ""))
    if avg["kcal"] > 1.05 * t["kcal"]:
        return f"planned calories average {avg['kcal']:.0f}/day — over the {t['kcal']} target"
    return None


def _norm_note(s: str) -> str:
    return " ".join(re.sub(r"[^a-z0-9 ]", " ", (s or "").lower()).split())


def _dinner_sig(entry: dict) -> str:
    return json.dumps({k: v for k, v in (entry or {}).items() if k != "why"},
                      sort_keys=True, default=str)


def _validate_dinner_notes(db: Session, user: User, content: dict, rationale: str) -> str | None:
    """Dinner whys are plate notes, not week copy: about THAT dinner that night
    (its macro job, batch/leftover role, a carry-over it uses). No two alike,
    none a restatement of the rationale, and a changed dinner never keeps the
    line the current week already shows."""
    scope = food_scope(user)
    q = db.query(MealRevision).filter(MealRevision.status == "active")
    q = q.filter(MealRevision.user_id == scope) if scope else q.filter(MealRevision.user_id.is_(None))
    prev = q.order_by(MealRevision.num.desc()).first()
    prev_days = ((prev.content or {}).get("days", {}) or {}) if prev else {}
    rat = _norm_note(rationale)
    seen: dict[str, str] = {}
    for key in DAY_KEYS:
        entry = ((content.get("days", {}).get(key) or {}).get("slots") or {}).get("dinner") or {}
        prev_entry = ((prev_days.get(key) or {}).get("slots") or {}).get("dinner") or {}
        n = _norm_note(entry.get("why") or "")
        if not n:
            continue  # presence is enforced structurally in validate_food_content
        if n in seen.values():
            dup = next(k for k, v in seen.items() if v == n)
            return (f"days {dup} and {key} share the same dinner why — each note is about that "
                    "plate that night (its macro job, batch role, or the carry-over it uses)")
        if rat and (n in rat or rat in n):
            return (f"day {key}: the dinner why restates the weekly rationale — say what this "
                    "dinner does tonight instead")
        if _dinner_sig(entry) != _dinner_sig(prev_entry) and prev_entry \
                and n == _norm_note(prev_entry.get("why") or ""):
            return (f"day {key}: the dinner changed but its why is the current week's line — "
                    "write it fresh for the new plate")
        seen[key] = n
    return None


def create_food_proposal(db: Session, user: User, content: dict, changes: list,
                         rationale: str) -> dict:
    if not (rationale or "").strip():
        return {"error": "rationale is required — 2-3 sentences on what this week achieves"}
    err = (validate_food_content(db, user, content, changes or [])
           or _validate_dinner_notes(db, user, content, rationale))
    if err:
        return {"error": err}
    scope = food_scope(user)

    def scoped(q):
        return q.filter(MealRevision.user_id == scope) if scope else q.filter(MealRevision.user_id.is_(None))

    max_num = max((n for (n,) in scoped(db.query(MealRevision.num))), default=0)
    auto = (user.prefs or {}).get("coach_approval") == "auto"
    # exactly one pending food proposal per household at a time
    scoped(db.query(MealRevision)).filter(MealRevision.status == "proposed").update({"status": "superseded"})
    rev = MealRevision(user_id=scope, num=max_num + 1, content=content, changes=changes,
                       rationale=rationale, status="active" if auto else "proposed")
    db.add(rev)
    if auto:
        (scoped(db.query(MealRevision))
         .filter(MealRevision.status == "active", MealRevision.num <= max_num)
         .update({"status": "superseded"}))
    db.commit()
    return {"ok": True, "revision": rev.num, "status": rev.status,
            "note": "applied immediately (auto mode)" if auto else "awaiting approval in the Food tab"}


# ---------- carry-overs (E16.5 — the waste loop) ----------


def list_carryovers(db: Session, user: User) -> list[dict]:
    scope = food_scope(user)
    q = db.query(Carryover)
    q = q.filter(Carryover.user_id == scope) if scope else q.filter(Carryover.user_id.is_(None))
    rows = q.order_by(Carryover.week_start.desc()).limit(40).all()
    return [{"id": c.id, "week_start": str(c.week_start), "item": c.item, "qty": c.qty,
             "use_by": str(c.use_by) if c.use_by else None, "status": c.status} for c in rows]


def update_carryovers(db: Session, user: User, updates: list | None, add: list | None) -> dict:
    """Set statuses on existing rows (keep/bin/consumed) and/or record new
    leftovers. The coach learns from binned formats; kept items must show up
    in the next proposal or be excused in its rationale."""
    scope = food_scope(user)
    changed = 0
    for u in updates or []:
        c = db.get(Carryover, str(u.get("id", "")))
        if not c or c.user_id != scope:
            return {"error": f"carryover {u.get('id')!r} not found"}
        status = u.get("status")
        if status not in {"open", "kept", "binned", "consumed"}:
            return {"error": f"status must be open|kept|binned|consumed, got {status!r}"}
        c.status = status
        changed += 1
    added = 0
    for a in add or []:
        if not a.get("item"):
            return {"error": "each added carry-over needs an item name"}
        use_by = None
        if a.get("use_by"):
            try:
                use_by = date.fromisoformat(str(a["use_by"]))
            except ValueError:
                return {"error": f"bad use_by date {a['use_by']!r} — YYYY-MM-DD"}
        db.add(Carryover(user_id=scope, week_start=local_today(), item=str(a["item"]),
                         qty=str(a.get("qty", "")), use_by=use_by,
                         status=a.get("status", "open")))
        added += 1
    db.commit()
    return {"ok": True, "updated": changed, "added": added}
