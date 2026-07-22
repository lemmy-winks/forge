"""Phase 3 — the coach: a server-side Claude agent loop with data tools.

The agent reads the user's real data through the same functions the API serves,
and writes only through guarded tools (proposals default to `proposed` status —
nothing goes live without approval unless the user opted into auto-apply).
"""

from __future__ import annotations

import json
import logging
import re
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from .config import get_settings, local_today
from .models import AgentRun, ChatMessage, Exercise, MealRevision, Niggle, Plan, PlanRevision, Recipe, User

log = logging.getLogger("forge.coach")

MAX_LOOPS = 12
HISTORY_MSGS = 24
# Big enough for propose_revision's full-week JSON: at 2000 the response used to
# truncate mid-tool-call (stop_reason=max_tokens, zero text blocks → "(no reply)").
MAX_TOKENS = 8000

TOOLS: list[dict] = [
    {"name": "get_today", "description": "Today's (or a given date's) plan with targets, last-time context and cool-down. Args: date (YYYY-MM-DD, optional).",
     "input_schema": {"type": "object", "properties": {"date": {"type": "string"}}}},
    {"name": "get_progress", "description": "e1RM series per lift, bodyweight/VO2max/resting-HR/sleep series, sessions this week.",
     "input_schema": {"type": "object", "properties": {}}},
    {"name": "get_history", "description": "Recent sessions (strength and cardio) with stats.",
     "input_schema": {"type": "object", "properties": {}}},
    {"name": "get_session", "description": "Full detail of one session: prescribed vs performed, notes, cool-down status. Args: session_id.",
     "input_schema": {"type": "object", "properties": {"session_id": {"type": "string"}}, "required": ["session_id"]}},
    {"name": "get_records", "description": "All-time bests per exercise.",
     "input_schema": {"type": "object", "properties": {}}},
    {"name": "get_niggles", "description": "The user's niggles (active and cleared).",
     "input_schema": {"type": "object", "properties": {}}},
    {"name": "get_labs", "description": "Lab panels (lipids) with reference ranges.",
     "input_schema": {"type": "object", "properties": {}}},
    {"name": "get_equipment", "description": "Equipment profiles and which is active — a hard constraint on what you may prescribe.",
     "input_schema": {"type": "object", "properties": {}}},
    {"name": "get_library", "description": "All exercises you may prescribe: slug, name, kind (bb/db/machine/bw/mobility), muscles, equipment needs, movement patterns.",
     "input_schema": {"type": "object", "properties": {}}},
    {"name": "get_active_plan", "description": "The active plan revision: goal, week content, rationale.",
     "input_schema": {"type": "object", "properties": {}}},
    {"name": "get_week", "description": "The current calendar week (Mon–Sun): each day's plan entry plus any logged session (status + stats). The fastest way to see what's done and what's left this week.",
     "input_schema": {"type": "object", "properties": {}}},
    {"name": "get_proposal", "description": "The pending proposed revision awaiting the user's approval (null if none). Read this before discussing or revising a proposal.",
     "input_schema": {"type": "object", "properties": {}}},
    {"name": "amend_week",
     "description": ("Change specific days of the CURRENT active week without touching the rest — for mid-week "
                     "adjustments (missed session, tight day, niggle flared, equipment change). "
                     "days = only the day keys you're changing ('0'..'6'), each a full day object in propose_revision format "
                     "(or null to make that day a rest day). Unlisted days stay exactly as they are. "
                     "changes + rationale required, same format as propose_revision. Creates a proposal unless auto mode."),
     "input_schema": {"type": "object", "properties": {"days": {"type": "object"}, "changes": {"type": "array"},
                      "rationale": {"type": "string"}}, "required": ["days", "rationale"]}},
    {"name": "update_goal", "description": "Update the user's training goal after they confirm the change in chat. Args: goal (one or two sentences).",
     "input_schema": {"type": "object", "properties": {"goal": {"type": "string"}}, "required": ["goal"]}},
    {"name": "log_body_metric", "description": "Record a body measurement the user states in chat (after confirming the number). Args: type ('weight'|'height'|'body_fat_pct'), value (kg / cm / %).",
     "input_schema": {"type": "object", "properties": {"type": {"type": "string"}, "value": {"type": "number"}},
                      "required": ["type", "value"]}},
    {"name": "propose_revision",
     "description": ("Propose next week's plan. content = {\"days\": {\"0\"..\"6\": day}, \"changes\": [...]}. "
                     "Strength day: {name, kind:'strength', focus:[...], why:'this session's note — see below', "
                     "exercises:[{slug, sets, reps, weight, rest, priority, min_sets}], "
                     "cooldown:[{slug, hold}]}. Exactly one exercise per strength day has priority 1 (the protected main lift); "
                     "min_sets 0 marks droppable accessories. Cardio day: {name, kind:'cardio', focus:[...], why:'...', "
                     "cardio:{type, minutes, hr_low, hr_high, note}}. "
                     "changes = the diff vs the current active week, each {sign:'+'|'-'|'~', what:'Bench Press 62.5 → 57.5 kg', "
                     "why:'deload after 2 stalled weeks'} — every meaningful change gets a row ('+' added/increased, "
                     "'-' removed/reduced, '~' swapped/moved). Only library slugs; cooldown slugs must be mobility kind; "
                     "cooldown never empty on strength days. rationale = 2-3 plain sentences on what THIS "
                     "WEEK ACHIEVES, written forward: the load/volume milestones it reaches, the weekly cardio "
                     "minutes it banks, what it sets up next ('Bench moves to 60 kg for the first time; 90 min "
                     "of Zone 2 keeps the aerobic block on track'). Real numbers, future tense. Do NOT restate "
                     "the diff — changes[] already carries per-change whys. "
                     "Each day's why is a SESSION note the user reads on that day's row: one line grounded in "
                     "that session's content this week — the main lift's progression state ('third week at 5×5 "
                     "60 kg; fast bar speed earns 62.5 next'), the specific stimulus ('extra pull set to balance "
                     "Monday's pressing'), or a watch point ('first squats since the knee niggle — stop short of "
                     "pain'). Never week-level copy, never the rationale rephrased, never last week's line, no "
                     "two days alike — the validator rejects all four."),
     "input_schema": {"type": "object", "properties": {"content": {"type": "object"}, "rationale": {"type": "string"}},
                      "required": ["content", "rationale"]}},
    {"name": "log_niggle", "description": "Record a new niggle after the user confirms. Args: body_part, severity (mild/moderate), note, avoid_patterns (e.g. ['deep_lunge','overhead_press']), mobility_slug (optional cool-down stretch to inject).",
     "input_schema": {"type": "object", "properties": {"body_part": {"type": "string"}, "severity": {"type": "string"},
                      "note": {"type": "string"}, "avoid_patterns": {"type": "array", "items": {"type": "string"}},
                      "mobility_slug": {"type": "string"}}, "required": ["body_part"]}},
    {"name": "clear_niggle", "description": "Mark a niggle cleared after the user confirms. Args: niggle_id.",
     "input_schema": {"type": "object", "properties": {"niggle_id": {"type": "string"}}, "required": ["niggle_id"]}},
    {"name": "get_food_week", "description": "The current calendar food week (Mon–Sun): each day's planned slots (recipes with per-serving macros), what the user has logged, day totals, and their nutrition targets. Read this before any food conversation.",
     "input_schema": {"type": "object", "properties": {}}},
    {"name": "get_recipes", "description": "The recipe pool you may plan food weeks from: slug, name, kind (dinner/breakfast/lunch/snack), per-serving macros, minutes, difficulty, batch servings. Proposals draw ONLY from this pool — never invent recipes. Args: kind (optional filter).",
     "input_schema": {"type": "object", "properties": {"kind": {"type": "string"}}}},
    {"name": "get_food_proposal", "description": "The pending food-week proposal awaiting approval (null if none). Read this before discussing or revising a food proposal.",
     "input_schema": {"type": "object", "properties": {}}},
    {"name": "propose_food_week",
     "description": ("Propose next week's food for the household. content = {\"days\": {\"0\"..\"6\": {\"slots\": "
                     "{breakfast, lunch, dinner, snack}}}}. Every slot on every day must be planned. A slot is one of: "
                     "{recipe: slug, why?: '...'} · {order: true, note: 'target macros + budget'} (lunches only) · "
                     "{out: true, note: '...'} (dinner only — the planned night out) · {leftover_of: '0'} (inherits that "
                     "day's dinner; at least one dinner per week must be zero-cook via leftover or out). Every cooked "
                     "dinner needs a why one-liner about THAT plate that night — its macro job in the day, its "
                     "batch/leftover role, or the carry-over it uses ('lentils do the fiber lifting on a low-veg day', "
                     "'boxes two lunches for the office run') — never the week's goals rephrased, never the line the "
                     "current week already shows for a changed dinner, no two days alike. "
                     "Validators enforce: complete recipes only, weekly-average protein/fiber "
                     "at target, sat-fat cap honored with headroom banked for a night out, difficulty ≤ medium. "
                     "changes = diff vs the current food week, each {sign:'+'|'-'|'~', what, why}. rationale = 2-3 "
                     "sentences on what the week achieves (averages hit, carry-overs used, what the night out costs)."),
     "input_schema": {"type": "object", "properties": {"content": {"type": "object"}, "changes": {"type": "array"},
                      "rationale": {"type": "string"}}, "required": ["content", "changes", "rationale"]}},
    {"name": "log_meal",
     "description": ("Log something the user ate AFTER echoing your macro estimate and getting a yes. Off-plan food "
                     "(described or photographed in chat) needs label + kcal + protein_g + fiber_g + satfat_g with "
                     "estimated: true — also estimate carbs_g, sugar_g, fat_g and sodium_mg (the app tracks the "
                     "full label set). Planned/known recipes: pass recipe (slug) + servings instead. "
                     "Args: date (YYYY-MM-DD, optional = today), slot (breakfast|lunch|dinner|snack)."),
     "input_schema": {"type": "object", "properties": {"date": {"type": "string"}, "slot": {"type": "string"},
                      "recipe": {"type": "string"}, "servings": {"type": "number"}, "label": {"type": "string"},
                      "kcal": {"type": "number"}, "protein_g": {"type": "number"}, "carbs_g": {"type": "number"},
                      "sugar_g": {"type": "number"}, "fiber_g": {"type": "number"}, "fat_g": {"type": "number"},
                      "satfat_g": {"type": "number"}, "sodium_mg": {"type": "number"},
                      "estimated": {"type": "boolean"}},
                      "required": ["slot"]}},
    {"name": "get_carryovers", "description": "Leftover shop items from previous food weeks (the waste loop): item, qty, use-by, status (open|kept|binned|consumed). Kept items must be consumed by the next proposal or excused in its rationale.",
     "input_schema": {"type": "object", "properties": {}}},
    {"name": "update_carryovers",
     "description": ("Record the Sunday keep/bin confirm and new leftovers. updates = [{id, status: open|kept|binned|consumed}]; "
                     "add = [{item, qty, use_by?: YYYY-MM-DD}]. Binned items are waste — learn from the formats that get binned."),
     "input_schema": {"type": "object", "properties": {"updates": {"type": "array"}, "add": {"type": "array"}}}},
    {"name": "log_lab_panel",
     "description": "Save a lab panel AFTER echoing the parsed values and getting the user's confirmation. Args: drawn_on (YYYY-MM-DD), results:[{marker, value, unit, ref_low, ref_high}].",
     "input_schema": {"type": "object", "properties": {"drawn_on": {"type": "string"},
                      "results": {"type": "array", "items": {"type": "object"}}}, "required": ["drawn_on", "results"]}},
]


def _validate_content(db: Session, content: dict) -> str | None:
    days = content.get("days")
    if not isinstance(days, dict) or not days:
        return "content.days must be a non-empty object keyed '0'..'6'"
    slugs = {e.slug: e for e in db.query(Exercise).all()}
    for key, day in days.items():
        if key not in {"0", "1", "2", "3", "4", "5", "6"}:
            return f"bad day key {key!r} — use '0' (Mon) .. '6' (Sun)"
        kind = day.get("kind")
        if kind == "cardio":
            if not isinstance(day.get("cardio"), dict):
                return f"day {key}: cardio day needs a cardio object"
            continue
        if kind != "strength":
            return f"day {key}: kind must be 'strength' or 'cardio'"
        exs = day.get("exercises") or []
        if not exs:
            return f"day {key}: strength day has no exercises"
        mains = [e for e in exs if e.get("priority") == 1]
        if len(mains) != 1:
            return f"day {key}: exactly one exercise must have priority 1 (got {len(mains)})"
        for e in exs:
            slug = e.get("slug")
            if slug not in slugs:
                return f"day {key}: unknown exercise slug {slug!r} — use get_library"
            if slugs[slug].kind == "mobility":
                return f"day {key}: {slug} is mobility — it belongs in cooldown"
            if not isinstance(e.get("sets"), int) or not isinstance(e.get("reps"), int):
                return f"day {key}: {slug} needs integer sets and reps"
        cds = day.get("cooldown") or []
        if not cds:
            return f"day {key}: strength day needs a non-empty cooldown"
        for c in cds:
            cslug = c.get("slug")
            if cslug not in slugs or slugs[cslug].kind != "mobility":
                return f"day {key}: cooldown slug {cslug!r} must be a mobility exercise"
    return None


def _norm_note(s: str) -> str:
    return " ".join(re.sub(r"[^a-z0-9 ]", " ", (s or "").lower()).split())


def _day_sig(day: dict) -> str:
    """A day's content identity, ignoring its note — used to tell 'this day
    changed' from 'this day is carried over'."""
    return json.dumps({k: v for k, v in (day or {}).items() if k != "why"},
                      sort_keys=True, default=str)


def _validate_day_notes(db: Session, user: User, content: dict, rationale: str) -> str | None:
    """Day whys are per-session coaching notes, not week copy. Enforced: a day
    whose content changed carries a note, and that note is fresh (not last
    week's line for the day), specific (no two days share one), and not a
    restatement of the weekly rationale — the user reads note and rationale
    side by side on the proposal card."""
    prev = (db.query(PlanRevision).join(Plan)
            .filter(Plan.user_id == user.id, Plan.domain == "training",
                    PlanRevision.status == "active")
            .order_by(PlanRevision.num.desc()).first())
    prev_days = ((prev.content or {}).get("days", {}) or {}) if prev else {}
    rat = _norm_note(rationale)
    seen: dict[str, str] = {}
    for key in sorted(content.get("days") or {}):
        day = (content["days"].get(key)) or {}
        prev_day = prev_days.get(key) or {}
        changed = _day_sig(day) != _day_sig(prev_day)
        n = _norm_note(day.get("why") or "")
        if changed and not n:
            return (f"day {key}: changed but has no why — write this session's note: one specific "
                    "line grounded in its content (the main lift's progression state, the stimulus "
                    "it adds, what to watch), not a week-level statement")
        if not n:
            continue
        if n in seen.values():
            dup = next(k for k, v in seen.items() if v == n)
            return (f"days {dup} and {key} share the same why — each day's note must speak to "
                    "that session specifically")
        if rat and (n in rat or rat in n):
            return (f"day {key}: the why restates the weekly rationale — the rationale tells the "
                    f"week's story once; this note tells day {key}'s story")
        if changed and prev_day and n == _norm_note(prev_day.get("why") or ""):
            return (f"day {key}: the session changed but its why is last week's line — rewrite "
                    "the note from what actually changed this week")
        seen[key] = n
    return None


def create_proposal(db: Session, user: User, content: dict, rationale: str) -> dict:
    err = _validate_content(db, content) or _validate_day_notes(db, user, content, rationale)
    if err:
        return {"error": err}
    plan = (db.query(Plan).filter(Plan.user_id == user.id, Plan.domain == "training")
            .order_by(Plan.status.desc()).first())
    if not plan:
        plan = Plan(user_id=user.id, goal="", status="active")
        db.add(plan)
        db.flush()
    max_num = max((r.num for r in db.query(PlanRevision).filter(PlanRevision.plan_id == plan.id)), default=0)
    auto = (user.prefs or {}).get("coach_approval") == "auto"
    # a new proposal always supersedes older unapproved ones — exactly one pending at a time
    (db.query(PlanRevision)
     .filter(PlanRevision.plan_id == plan.id, PlanRevision.status == "proposed")
     .update({"status": "superseded"}))
    rev = PlanRevision(plan_id=plan.id, num=max_num + 1, content=content, rationale=rationale,
                       status="active" if auto else "proposed")
    db.add(rev)
    if auto:
        (db.query(PlanRevision)
         .filter(PlanRevision.plan_id == plan.id, PlanRevision.status == "active",
                 PlanRevision.num <= max_num)
         .update({"status": "superseded"}))
    db.commit()
    return {"ok": True, "revision": rev.num, "status": rev.status,
            "note": "applied immediately (auto mode)" if auto else "awaiting user approval in the app"}


def amend_week(db: Session, user: User, days: dict, changes: list, rationale: str) -> dict:
    """Merge changed days into the active week and propose the result — the safe
    path for mid-week adjustments (a partial propose_revision would drop days)."""
    from .routers.training import active_revision
    rev = active_revision(db, user.id)
    if not rev:
        return {"error": "no active plan to amend — use propose_revision"}
    merged_days = dict((rev.content or {}).get("days", {}) or {})
    for key, day in (days or {}).items():
        if day is None:
            merged_days.pop(key, None)  # explicit rest day
        else:
            merged_days[key] = day
    content = {**(rev.content or {}), "days": merged_days, "changes": changes or []}
    return create_proposal(db, user, content, rationale)


def _exec_tool(db: Session, user: User, name: str, args: dict) -> object:
    # Route handlers are plain functions — call them directly with user/db.
    from .routers import misc, training

    try:
        if name == "get_today":
            return training.today(date=args.get("date"), budget=None, user=user, db=db)
        if name == "get_progress":
            out = training.progress(user=user, db=db)
            # Year-long series inflate every later loop iteration's input — trim
            # to what a weekly coaching decision needs (trends still visible).
            for k in ("weight", "vo2max", "vo2max_smooth", "resting_hr", "sleep_h"):
                if isinstance(out.get(k), list):
                    out[k] = out[k][-60:]
            for series in (out.get("e1rm") or {}).values():
                if isinstance(series.get("points"), list):
                    series["points"] = series["points"][-26:]
            bc = out.get("bodycomp")
            if isinstance(bc, dict):
                for k, v in bc.items():
                    if isinstance(v, list):
                        bc[k] = v[-60:]
            return out
        if name == "get_history":
            return training.history(user=user, db=db)[:30]
        if name == "get_session":
            return training.session_detail(args["session_id"], user=user, db=db)
        if name == "get_records":
            return training.records(user=user, db=db)
        if name == "get_niggles":
            return misc.niggles(user=user, db=db)
        if name == "get_labs":
            return misc.labs(user=user, db=db)
        if name == "get_equipment":
            return misc.equipment(user=user, db=db)
        if name == "get_library":
            return [{"slug": e.slug, "name": e.name, "kind": e.kind,
                     "primary_muscles": e.primary_muscles, "equipment": e.equipment,
                     "patterns": e.patterns} for e in db.query(Exercise).all()]
        if name == "get_active_plan":
            rev = training.active_revision(db, user.id)
            plan = db.get(Plan, rev.plan_id) if rev else None
            return {"goal": plan.goal if plan else "", "revision": rev.num if rev else None,
                    "content": rev.content if rev else None, "rationale": rev.rationale if rev else ""}
        if name == "get_week":
            return training.week(date=None, user=user, db=db)
        if name == "get_proposal":
            from .routers.coach_api import get_proposal as gp
            return gp(user=user, db=db)
        if name == "amend_week":
            return amend_week(db, user, args.get("days") or {}, args.get("changes") or [],
                              args.get("rationale") or "")
        if name == "update_goal":
            plan = (db.query(Plan).filter(Plan.user_id == user.id, Plan.domain == "training").first())
            if not plan:
                return {"error": "no plan yet"}
            plan.goal = str(args.get("goal", "")).strip()
            db.commit()
            return {"ok": True, "goal": plan.goal}
        if name == "log_body_metric":
            from .routers.misc import BodyIn, add_body_metric
            return add_body_metric(BodyIn(type=args["type"], value=args["value"]), user=user, db=db)
        if name == "propose_revision":
            return create_proposal(db, user, args.get("content") or {}, args.get("rationale") or "")
        if name == "log_niggle":
            db.add(Niggle(user_id=user.id, body_part=args["body_part"],
                          severity=args.get("severity", "mild"), note=args.get("note", ""),
                          avoid_patterns=args.get("avoid_patterns", []),
                          mobility_slug=args.get("mobility_slug", "")))
            db.commit()
            return {"ok": True}
        if name == "clear_niggle":
            n = db.get(Niggle, args["niggle_id"])
            if not n or n.user_id != user.id:
                return {"error": "niggle not found"}
            n.status = "cleared"
            db.commit()
            return {"ok": True}
        if name == "get_food_week":
            from .routers import food
            return food.food_week(date=None, user=user, db=db)
        if name == "get_recipes":
            kind = args.get("kind")
            rows = db.query(Recipe).all()
            from .models import MACRO_FIELDS
            return [{"slug": r.slug, "name": r.name, "kind": r.kind, "minutes": r.minutes,
                     "difficulty": r.difficulty, "serves": r.serves, "batch": r.batch,
                     **{k: getattr(r, k) for k in MACRO_FIELDS},
                     "tags": r.tags, "complete": bool(r.complete)}
                    for r in rows if not kind or r.kind == kind]
        if name == "get_food_proposal":
            from .routers.food import food_proposal
            return food_proposal(user=user, db=db)
        if name == "propose_food_week":
            from .food_coach import create_food_proposal
            return create_food_proposal(db, user, args.get("content") or {},
                                        args.get("changes") or [], args.get("rationale") or "")
        if name == "log_meal":
            from .routers.food import LogIn, log_meal
            from .models import MACRO_FIELDS
            body = LogIn(date=args.get("date"), slot=args["slot"], recipe=args.get("recipe"),
                         servings=args.get("servings") or 1, label=args.get("label"),
                         estimated=bool(args.get("estimated")),
                         source="plan" if args.get("recipe") else "chat",
                         **{k: args.get(k) for k in MACRO_FIELDS})
            return log_meal(body, user=user, db=db)
        if name == "get_carryovers":
            from .food_coach import list_carryovers
            return list_carryovers(db, user)
        if name == "update_carryovers":
            from .food_coach import update_carryovers
            return update_carryovers(db, user, args.get("updates"), args.get("add"))
        if name == "log_lab_panel":
            from .routers.misc import LabPanelIn, LabResultIn, add_panel
            body = LabPanelIn(drawn_on=args["drawn_on"], source="coach-chat",
                              results=[LabResultIn(**r) for r in args.get("results", [])])
            return add_panel(body, user=user, db=db)
        return {"error": f"unknown tool {name}"}
    except Exception as e:  # tool errors go back to the model, never crash the loop
        return {"error": str(e)}


def _week_so_far(db: Session, user: User) -> str:
    """One grounding line so the coach never opens blind: sessions this week + pending proposal."""
    from datetime import timedelta

    from .models import PlanRevision as PR
    from .models import WorkoutSession
    from .routers.training import active_revision
    today = local_today()
    monday = today - timedelta(days=today.weekday())
    rows = (db.query(WorkoutSession)
            .filter(WorkoutSession.user_id == user.id, WorkoutSession.day >= monday,
                    WorkoutSession.status.in_(["completed", "unplanned"]))
            .order_by(WorkoutSession.day).all())
    done = "; ".join(f"{s.day} {s.name} ({s.kind}, {s.status})" for s in rows) or "nothing logged yet"
    rev = active_revision(db, user.id)
    planned = len(((rev.content or {}).get("days", {}) or {}) if rev else {})
    pending = (db.query(PR).join(Plan)
               .filter(Plan.user_id == user.id, PR.status == "proposed").first())
    return (f"This week so far (Mon {monday}): {len(rows)}/{planned} planned days done — {done}."
            + (" A proposed plan revision is awaiting their approval (get_proposal)." if pending else ""))


def _food_context(db: Session, user: User) -> str:
    """One grounding line for the food half: daily targets + pending proposal."""
    from .food_coach import food_scope
    from .routers.food import targets_for
    t = targets_for(user)
    prefs = user.prefs or {}
    scope = food_scope(user)
    q = db.query(MealRevision).filter(MealRevision.status == "proposed")
    q = q.filter(MealRevision.user_id == scope) if scope else q.filter(MealRevision.user_id.is_(None))
    pending = q.first() is not None
    return (f"Nutrition targets (daily): {t['kcal']} kcal · protein {t['protein_g']} g · "
            f"carbs {t.get('carbs_g', 250)} g · fiber {t['fiber_g']} g · fat {t.get('fat_g', 80)} g. "
            f"Caps: sat fat {t['satfat_g']} g · sugar {t.get('sugar_g', 65)} g · "
            f"sodium {t.get('sodium_mg', 2300)} mg. "
            f"Cook nights: {prefs.get('cook_nights', 4)}/week; grocery budget {prefs.get('budget_grocery', '?')}; "
            f"lunch cap {prefs.get('budget_lunch', '?')}."
            + (" A proposed food week is awaiting approval (get_food_proposal)." if pending else ""))


# Static half of the system prompt: identical for every user and every request,
# so the prompt cache can share it (together with the TOOLS schemas that render
# before it). Anything user- or day-specific belongs in _system_prompt below.
STATIC_SYSTEM = """You are the Forge coach — the athlete's personal strength & conditioning coach inside the Forge app. Their profile and current context follow these rules.

Rules:
- Read before you speak: use tools to check real data before answering training questions; cite actual numbers ("bench 8/8/8 at 57.5 twice"), never invent them.
- Progression: hold or increase the main lift only when the last exposure was clean (all reps, RPE <= 8). Stalls two weeks running -> deload ~10% and rebuild. The athlete's progression style (in their profile) sets how eagerly you add load.
- Respect niggle avoid_patterns absolutely; inject their mobility work into cool-downs. Cool-downs are never removed.
- Place hard cardio away from heavy lower days. Zone 2 volume ramps gently.
- Writes need consent: for labs and niggles, echo what you parsed and get a yes BEFORE calling the tool (if the user already clearly confirmed, proceed).
- Hard boundary: you are not a doctor. Never advise on medication or dosing. Lab trends: describe the data, connect it to training/weight changes, and suggest discussing decisions with their GP.
- Plan rationales sell the week ahead, not the edit log: lead with what the athlete will achieve by Sunday (loads reached, minutes banked, what it unlocks). The changes list handles the diff.
- Mid-week changes use amend_week (only the affected days); full next-week plans use propose_revision. When the user asks to tweak a pending proposal, read get_proposal first, then propose the revised version.
- You also coach the household's food week (the Food tab). The cholesterol trio leads: protein up, fiber up, sat fat capped — coached on WEEKLY AVERAGES, never single meals, and macro numbers are estimates (never imply lab precision). Dinners are household-shared (one plan; each person logs their own plate against their own targets). Food proposals draw only from the in-app recipe pool (get_recipes) — never invent recipes or fetch the internet at proposal time. Full food weeks use propose_food_week; to tweak a pending one, read get_food_proposal first, then propose the revised version.
- Off-plan food described in chat: estimate macros from what they tell you, echo the estimate, and log_meal it (estimated: true) once they confirm. Same consent rule as labs.
- Messages may end with a bracketed context tag like "[re: session 2026-07-21 · Lower A]" — attached data for that item follows the message; treat it as what the user is looking at.
- Voice: short, concrete, warm, zero fluff. You're read on a phone between sets."""


def _system_prompt(db: Session, user: User) -> str:
    """The dynamic half: athlete profile + today's context. Stable within a run."""
    from .routers import training
    plan = db.query(Plan).filter(Plan.user_id == user.id).first()
    nigs = [n for n in db.query(Niggle).filter(Niggle.user_id == user.id, Niggle.status == "active")]
    prof = training.active_profile(db, user)
    prefs = user.prefs or {}
    style = prefs.get("coach_style", "standard")
    approval = prefs.get("coach_approval", "propose")
    nig_txt = "; ".join(f"{n.body_part} ({n.severity}; avoid {', '.join(n.avoid_patterns or []) or 'nothing specific'})"
                        for n in nigs) or "none"
    intake = ""
    if not (user.prefs or {}).get("onboarded"):
        intake = f"""

INTAKE MODE — this is {user.name}'s first conversation with you. Interview them warmly,
one or two questions per message: (1) what they're training for, (2) days per week and which
days fit their life, (3) training experience, (4) injuries or movements to avoid — log
confirmed ones with log_niggle, (5) anything else you should know. Check get_equipment for
what they actually have. When you have goal + schedule + experience + the injury check, call
propose_revision with their real first week: conservative starting loads (this week is
calibration — say so in the rationale), their equipment only, cool-downs included. Then tell
them it's waiting on the Today screen for approval. Do not lecture; keep it light."""
    return f"""Athlete: {user.name}. Today is {local_today().isoformat()}. Display units: {user.units}.{intake}

Goal: {plan.goal if plan else 'not set'}
{_week_so_far(db, user)}
{_food_context(db, user)}
Active niggles: {nig_txt}
Active equipment profile: {prof.name if prof else 'unknown'} — prescribe only what get_equipment shows available.
Progression style: {style}. Plan changes: {approval} mode{' — your proposals apply immediately, so be conservative' if approval == 'auto' else ' — proposals wait for approval in the app'}."""


def _system_blocks(db: Session, user: User) -> list[dict]:
    """Cached system prompt: marking the static block also caches the TOOLS
    schemas that render before it; marking the dynamic block extends the cached
    prefix per user/day. Built once per run so it stays byte-identical across
    loop iterations even if a tool writes mid-run."""
    return [
        {"type": "text", "text": STATIC_SYSTEM, "cache_control": {"type": "ephemeral"}},
        {"type": "text", "text": _system_prompt(db, user), "cache_control": {"type": "ephemeral"}},
    ]


class CoachUnavailable(RuntimeError):
    pass


def _client():
    settings = get_settings()
    if not settings.anthropic_api_key:
        raise CoachUnavailable("ANTHROPIC_API_KEY not configured")
    import anthropic
    return anthropic.Anthropic(api_key=settings.anthropic_api_key)


def run_agent(db: Session, user: User, messages: list[dict], kind: str) -> str:
    settings = get_settings()
    client = _client()
    run = AgentRun(user_id=user.id, kind=kind, model=settings.coach_model,
                   input_tokens=0, output_tokens=0, tool_calls=0, ok=1)
    text = ""
    last_text = ""
    # Built once per run: byte-identical system across iterations is what lets the
    # prompt cache do its job (the marked blocks also cover the TOOLS prefix).
    system = _system_blocks(db, user)
    cache_read = cache_write = 0
    marked: dict | None = None  # the tool_result currently carrying the rolling cache marker
    try:
        resp = None
        for loop_n in range(MAX_LOOPS):
            resp = client.messages.create(
                model=settings.coach_model, max_tokens=MAX_TOKENS,
                system=system, tools=TOOLS, messages=messages,
            )
            run.input_tokens += resp.usage.input_tokens
            run.output_tokens += resp.usage.output_tokens
            cache_read += getattr(resp.usage, "cache_read_input_tokens", 0) or 0
            cache_write += getattr(resp.usage, "cache_creation_input_tokens", 0) or 0
            log.debug("coach %s loop %d: stop=%s blocks=%s out=%d", kind, loop_n,
                      resp.stop_reason, [b.type for b in resp.content], resp.usage.output_tokens)
            text = "".join(b.text for b in resp.content if b.type == "text")
            if text.strip():
                last_text = text
            if resp.stop_reason != "tool_use":
                break
            results = []
            for block in resp.content:
                if block.type == "tool_use":
                    run.tool_calls += 1
                    out = _exec_tool(db, user, block.name, dict(block.input or {}))
                    results.append({"type": "tool_result", "tool_use_id": block.id,
                                    "content": json.dumps(out, default=str)[:20000]})
            # Roll the transcript cache marker forward (max 4 breakpoints per
            # request: 2 on system + this one). Next iteration then re-reads the
            # whole prior transcript from cache instead of re-processing it.
            if marked is not None:
                marked.pop("cache_control", None)
            results[-1]["cache_control"] = {"type": "ephemeral"}
            marked = results[-1]
            messages = messages + [{"role": "assistant", "content": resp.content},
                                   {"role": "user", "content": results}]
        # Tool budget exhausted mid-thought: force a plain-text wrap-up so the user
        # never receives silence after the agent did real work.
        if resp is not None and resp.stop_reason == "tool_use":
            cancelled = [{"type": "tool_result", "tool_use_id": b.id,
                          "content": "(tool budget reached — stop reading and reply to the user "
                                     "in plain text now, summarising what you found and did)"}
                         for b in resp.content if b.type == "tool_use"]
            log.info("coach %s: tool budget (%d loops) exhausted — forcing wrap-up", kind, MAX_LOOPS)
            resp = client.messages.create(
                model=settings.coach_model, max_tokens=2000,
                system=system, tools=TOOLS,
                tool_choice={"type": "none"},
                messages=messages + [{"role": "assistant", "content": resp.content},
                                     {"role": "user", "content": cancelled}],
            )
            run.input_tokens += resp.usage.input_tokens
            run.output_tokens += resp.usage.output_tokens
            text = "".join(b.text for b in resp.content if b.type == "text")
        # Truncated by the output limit with nothing readable (classic case: a big
        # tool call swallowed the whole budget): ask again for a short plain-text
        # reply. The partial turn is dropped — its tool_use JSON is incomplete.
        if resp is not None and resp.stop_reason == "max_tokens" and not text.strip():
            log.warning("coach %s: truncated at max_tokens with no text — recovering", kind)
            nudge = ("(system: your previous reply was cut off by the output limit before any "
                     "text reached the user. Reply now in plain text only — a short summary of "
                     "where you got to; no tool calls.)")
            recovery = list(messages)
            last = recovery[-1]
            if last["role"] == "user":  # merge — roles must alternate
                extra = [{"type": "text", "text": nudge}] if isinstance(last["content"], list) else "\n\n" + nudge
                recovery[-1] = {**last, "content": last["content"] + extra}
            else:
                recovery.append({"role": "user", "content": nudge})
            resp = client.messages.create(
                model=settings.coach_model, max_tokens=2000,
                system=system, tools=TOOLS,
                tool_choice={"type": "none"}, messages=recovery,
            )
            run.input_tokens += resp.usage.input_tokens
            run.output_tokens += resp.usage.output_tokens
            text = "".join(b.text for b in resp.content if b.type == "text")
        if not text.strip():
            text = last_text
        if not text.strip():
            run.ok = 0
            run.note = f"empty reply (stop={getattr(resp, 'stop_reason', None)})"
            log.warning("coach %s for user %s: empty reply — stop=%s blocks=%s after %d tool calls",
                        kind, user.id, getattr(resp, "stop_reason", None),
                        [b.type for b in resp.content] if resp else [], run.tool_calls)
    except CoachUnavailable:
        raise
    except Exception as e:
        run.ok = 0
        run.note = str(e)[:500]
        db.add(run)
        db.commit()
        log.exception("coach %s for user %s failed after %d tool calls", kind, user.id, run.tool_calls)
        raise
    db.add(run)
    db.commit()
    log.info("coach %s for user %s: ok=%d tools=%d tokens=%d/%d cache_read=%d cache_write=%d stop=%s",
             kind, user.id, run.ok, run.tool_calls, run.input_tokens, run.output_tokens,
             cache_read, cache_write, getattr(resp, "stop_reason", None))
    return text or "(no reply)"


def run_chat(db: Session, user: User, text: str, extra_context: str = "") -> str:
    history = (db.query(ChatMessage).filter(ChatMessage.user_id == user.id)
               .order_by(ChatMessage.created_at.desc()).limit(HISTORY_MSGS).all())
    messages: list[dict] = []
    for m in reversed(history):
        role = "user" if m.who == "me" else "assistant"
        if messages and messages[-1]["role"] == role:
            messages[-1]["content"] += "\n" + m.text
        else:
            messages.append({"role": role, "content": m.text})
    if not messages or messages[-1]["role"] != "user":
        messages.append({"role": "user", "content": text})
    if extra_context:
        # attach full data for the screen the user sent this from (history keeps only the short tag)
        messages[-1] = {**messages[-1], "content": messages[-1]["content"] + "\n\n" + extra_context}
    reply = run_agent(db, user, messages, "chat")
    return reply


REVIEW_INSTRUCTION = """Run my weekly review. Steps:
1. Read the week: get_history (and get_session on this week's sessions), get_progress, get_niggles, get_today's active plan via get_active_plan, get_records, get_equipment. Check recovery trends (sleep, resting HR, weight) and cool-down/substitution patterns. Cover cardio too: Watch-synced runs vs their prescriptions (time, pace, % in zone), and Zone-2 minutes vs the weekly target — coach the inputs weekly; treat VO2max as a quarterly trend only, never week-to-week deltas.
2. Decide next week: progress what was earned, hold or deload what wasn't, respect every rule.
3. Call propose_revision with the full week, per-day why lines, the changes diff vs the
   current week (every load change, swap, and volume move gets a row), and a rationale that
   says what next week achieves — the loads it reaches, the minutes it banks, what it sets
   up — in real numbers, not a recap of the edits. Day whys are session notes, not week
   copy: each one speaks to that day's actual content this week and must differ from last
   week's note on that day — write them fresh from this review's data.
4. Food: read get_food_week (what got logged vs planned, day totals vs my targets) and
   get_carryovers. If a food proposal is already pending (get_food_proposal), review it and
   only re-propose if it needs changes. Otherwise call propose_food_week for next week:
   recipes from get_recipes only, at least one zero-cook dinner (batch a recipe), open
   carry-overs consumed or excused in the rationale, sat-fat headroom banked for any planned
   night out, the changes diff and per-dinner why lines included. Report food adherence with
   verifiable numbers ("fiber averaged 41 g; the cap slipped twice").
5. Reply with a summary I can read in 30 seconds: what went well, what changes and why, anything you're watching. Mention that both proposals (training + food) are waiting in the app (unless auto mode applied them)."""


def run_review(db: Session, user: User) -> str:
    summary = run_agent(db, user, [{"role": "user", "content": REVIEW_INSTRUCTION}], "review")
    db.add(ChatMessage(user_id=user.id, who="coach", text=summary))
    db.commit()
    return summary
