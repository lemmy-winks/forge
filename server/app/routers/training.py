from datetime import date as ddate
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..db import get_db
from ..fitting import epley_e1rm, est_minutes, fit_day, plate_breakdown, warmup_ramp
from ..models import (EquipmentProfile, Exercise, LoggedSet, Metric, Niggle, Plan,
                      PlanRevision, Record, User, WorkoutSession, utcnow)
from ..security import current_user

router = APIRouter(prefix="/api", tags=["training"])

DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]


# ---------- helpers ----------

def active_revision(db: Session, user_id: str) -> PlanRevision | None:
    return (db.query(PlanRevision).join(Plan)
            .filter(Plan.user_id == user_id, Plan.domain == "training",
                    PlanRevision.status == "active")
            .order_by(PlanRevision.num.desc()).first())


def active_profile(db: Session, user: User) -> EquipmentProfile | None:
    if user.active_profile_id:
        prof = db.get(EquipmentProfile, user.active_profile_id)
        if prof:
            return prof
    return (db.query(EquipmentProfile)
            .filter((EquipmentProfile.user_id == user.id) | (EquipmentProfile.user_id.is_(None)))
            .first())


def exercise_map(db: Session, slugs: list[str]) -> dict[str, Exercise]:
    rows = db.query(Exercise).filter(Exercise.slug.in_(slugs)).all()
    return {e.slug: e for e in rows}


def active_niggles(db: Session, user_id: str) -> list[Niggle]:
    return db.query(Niggle).filter(Niggle.user_id == user_id, Niggle.status == "active").all()


def last_time(db: Session, user_id: str, slug: str) -> dict | None:
    last_set = (db.query(LoggedSet).join(WorkoutSession, LoggedSet.session_id == WorkoutSession.id)
                .filter(LoggedSet.user_id == user_id, LoggedSet.exercise_slug == slug,
                        WorkoutSession.status == "completed")
                .order_by(LoggedSet.ts.desc()).first())
    if not last_set:
        return None
    sets = (db.query(LoggedSet)
            .filter(LoggedSet.session_id == last_set.session_id, LoggedSet.exercise_slug == slug)
            .order_by(LoggedSet.set_no).all())
    return {
        "weight": last_set.weight,
        "reps": [s.reps for s in sets],
        "rpe": [s.rpe for s in sets if s.rpe],
        "when": str(last_set.ts.date()),
    }


def parse_date(raw: str | None) -> ddate:
    if not raw:
        return datetime.now(timezone.utc).date()
    try:
        return ddate.fromisoformat(raw)
    except ValueError:
        raise HTTPException(status_code=400, detail="bad date")


def latest_metric(db: Session, user_id: str, mtype: str) -> dict | None:
    m = (db.query(Metric).filter(Metric.user_id == user_id, Metric.type == mtype)
         .order_by(Metric.ts.desc()).first())
    return {"value": m.value, "unit": m.unit, "ts": m.ts.isoformat()} if m else None


def _cooldown_for(db: Session, user: User, day: dict) -> list[dict]:
    """Plan cool-down with niggle-targeted mobility injected at the front."""
    items = [dict(c) for c in day.get("cooldown", [])]
    slugs = [c["slug"] for c in items]
    for n in active_niggles(db, user.id):
        if n.mobility_slug and n.mobility_slug in slugs:
            for c in items:
                if c["slug"] == n.mobility_slug:
                    c["why"] = f"targets your {n.body_part.lower()} niggle"
        elif n.mobility_slug:
            items.insert(0, {"slug": n.mobility_slug, "hold": "45 s each side",
                             "why": f"targets your {n.body_part.lower()} niggle"})
    exmap = exercise_map(db, [c["slug"] for c in items])
    for c in items:
        c["name"] = exmap[c["slug"]].name if c["slug"] in exmap else c["slug"]
    return items


# ---------- today ----------

@router.get("/today")
def today(date: str | None = None, budget: int | None = Query(default=None, ge=25, le=120),
          user: User = Depends(current_user), db: Session = Depends(get_db)):
    day_date = parse_date(date)
    rev = active_revision(db, user.id)
    days = (rev.content or {}).get("days", {}) if rev else {}
    entry = days.get(str(day_date.weekday()))
    prof = active_profile(db, user)

    existing = (db.query(WorkoutSession)
                .filter(WorkoutSession.user_id == user.id, WorkoutSession.day == day_date,
                        WorkoutSession.kind == "strength")
                .order_by(WorkoutSession.started_at.desc()).first())

    base = {
        "date": str(day_date), "day_name": DAY_NAMES[day_date.weekday()],
        "rationale": rev.rationale if rev else "",
        "session": None if not existing else {
            "id": existing.id, "status": existing.status, "stats": existing.stats,
            "cooldown_status": existing.cooldown_status,
        },
    }

    if not entry:
        nxt = None
        for ahead in range(1, 8):
            d2 = day_date + timedelta(days=ahead)
            e2 = days.get(str(d2.weekday()))
            if e2:
                nxt = {"day_name": DAY_NAMES[d2.weekday()], "name": e2.get("name"),
                       "kind": e2.get("kind"), "cardio": e2.get("cardio")}
                break
        return {**base, "kind": "rest",
                "recovery": {"sleep_h": latest_metric(db, user.id, "sleep_h"),
                             "weight": latest_metric(db, user.id, "weight"),
                             "resting_hr": latest_metric(db, user.id, "resting_hr")},
                "tomorrow": nxt}

    if entry.get("kind") == "cardio":
        return {**base, "kind": "cardio", "name": entry.get("name"),
                "focus": entry.get("focus", []), "cardio": entry.get("cardio", {})}

    entries = [dict(e) for e in entry.get("exercises", [])]
    exmap = exercise_map(db, [e["slug"] for e in entries])
    fit = fit_day(entries, budget)
    out_ex = []
    for e in entries:
        ex = exmap.get(e["slug"])
        n = fit["sets"][e["slug"]]
        item = {
            "slug": e["slug"], "name": ex.name if ex else e["slug"], "kind": ex.kind if ex else "bb",
            "sets": n, "base_sets": e["sets"], "reps": e["reps"], "weight": e.get("weight", 0),
            "rest": e.get("rest", 90), "priority": e.get("priority", 2),
            "dropped": n == 0, "note": e.get("note", ""),
            "last": last_time(db, user.id, e["slug"]),
        }
        if ex and ex.kind == "bb" and prof and prof.plates_kg:
            item["plate"] = plate_breakdown(e.get("weight", 0), prof.bar_kg, prof.plates_kg)
            if e.get("priority", 2) == 1:
                item["warmups"] = warmup_ramp(e.get("weight", 0), prof.bar_kg)
        elif ex and ex.kind == "db" and e.get("weight"):
            item["plate"] = f"2 × {e['weight']:g} kg dumbbells"
        out_ex.append(item)

    return {**base, "kind": "strength", "name": entry.get("name"),
            "focus": entry.get("focus", []),
            "budget": budget, "est": fit["est"], "cd": fit["cd"], "trims": fit["trims"],
            "full_est": est_minutes(entries, {e["slug"]: e["sets"] for e in entries}, "full"),
            "exercises": out_ex,
            "cooldown": _cooldown_for(db, user, entry),
            "profile": {"name": prof.name, "bar_kg": prof.bar_kg, "plates_kg": prof.plates_kg}
            if prof else None,
            "tonnage_est": round(sum(fit["sets"][e["slug"]] * e["reps"] * e.get("weight", 0)
                                     for e in entries) / 1000, 1)}


@router.get("/week")
def week(date: str | None = None, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Rolling 7-day view: today first, then the six days ahead."""
    base = parse_date(date)
    actual_today = datetime.now(timezone.utc).date()
    rev = active_revision(db, user.id)
    days = ((rev.content or {}).get("days", {}) or {}) if rev else {}

    sessions = (db.query(WorkoutSession)
                .filter(WorkoutSession.user_id == user.id,
                        WorkoutSession.day >= base,
                        WorkoutSession.day <= base + timedelta(days=6))
                .order_by(WorkoutSession.started_at).all())
    by_day: dict[str, dict] = {}
    for s in sessions:
        cur = by_day.get(str(s.day))
        # prefer strength/completed over unplanned cardio when both exist
        if cur is None or (s.kind == "strength" and cur["kind"] != "strength"):
            by_day[str(s.day)] = {"id": s.id, "kind": s.kind, "status": s.status,
                                  "stats": s.stats or {}, "name": s.name}

    out = []
    for i in range(7):
        d = base + timedelta(days=i)
        e = days.get(str(d.weekday()))
        item: dict = {"date": str(d), "day_name": DAY_NAMES[d.weekday()],
                      "is_today": d == actual_today,
                      "kind": (e or {}).get("kind", "rest"), "name": (e or {}).get("name"),
                      "focus": (e or {}).get("focus", []), "session": by_day.get(str(d))}
        if e and e.get("kind") == "strength":
            entries = e.get("exercises", [])
            item["est"] = est_minutes(entries, {x["slug"]: x["sets"] for x in entries}, "full")
            item["exercise_count"] = len(entries)
        elif e and e.get("kind") == "cardio":
            item["minutes"] = (e.get("cardio") or {}).get("minutes")
        out.append(item)
    return {"start": str(base), "rationale": rev.rationale if rev else "", "days": out}


# ---------- sessions & sets ----------

class StartSession(BaseModel):
    date: str | None = None
    budget: int | None = None
    # Override which plan day to run (weekday key "0".."6") — lets the user pull
    # e.g. Friday's Upper A forward and do it today. The session is still
    # recorded on `date` (default: today).
    plan_day: str | None = None


@router.post("/sessions")
def start_session(body: StartSession, user: User = Depends(current_user), db: Session = Depends(get_db)):
    day_date = parse_date(body.date)
    rev = active_revision(db, user.id)
    days = ((rev.content or {}).get("days", {}) or {}) if rev else {}
    entry = days.get(body.plan_day) if body.plan_day else days.get(str(day_date.weekday()))
    if not entry or entry.get("kind") != "strength":
        raise HTTPException(status_code=400, detail="no strength session planned for this day")

    existing = (db.query(WorkoutSession)
                .filter(WorkoutSession.user_id == user.id, WorkoutSession.day == day_date,
                        WorkoutSession.kind == "strength", WorkoutSession.status == "active").first())
    if existing:
        return {"id": existing.id, "fitted": existing.fitted, "resumed": True}

    entries = [dict(e) for e in entry.get("exercises", [])]
    fit = fit_day(entries, body.budget)
    fitted = {
        "name": entry.get("name"), "budget": body.budget, "est": fit["est"], "cd": fit["cd"],
        "targets": [{**e, "sets": fit["sets"][e["slug"]]} for e in entries],
        "cooldown": _cooldown_for(db, user, entry),
    }
    session = WorkoutSession(user_id=user.id, day=day_date, name=entry.get("name", "Session"),
                             kind="strength", status="active", time_budget_min=body.budget,
                             fitted=fitted)
    db.add(session)
    db.commit()
    return {"id": session.id, "fitted": fitted, "resumed": False}


class SetIn(BaseModel):
    slug: str
    substituted_for: str | None = None
    set_no: int
    weight: float = 0
    reps: int
    rpe: int | None = None


def _update_records(db: Session, user: User, s: SetIn, day: ddate) -> list[dict]:
    pbs = []
    e1 = epley_e1rm(s.weight, s.reps)
    checks = []
    if e1 > 0:
        checks.append(("e1rm", e1, f"{s.weight:g} × {s.reps}"))
    if s.weight > 0:
        checks.append(("best_set", s.weight, f"{s.weight:g} × {s.reps}"))
    for kind, value, detail in checks:
        rec = (db.query(Record)
               .filter(Record.user_id == user.id, Record.exercise_slug == s.slug, Record.kind == kind)
               .first())
        if rec is None:
            db.add(Record(user_id=user.id, exercise_slug=s.slug, kind=kind, value=value,
                          detail=detail, achieved_on=day))
        elif value > rec.value:
            rec.value, rec.detail, rec.achieved_on = value, detail, day
            pbs.append({"kind": kind, "slug": s.slug, "value": value, "detail": detail})
    return pbs


@router.post("/sessions/{sid}/sets")
def log_set(sid: str, body: SetIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    session = db.get(WorkoutSession, sid)
    if not session or session.user_id != user.id:
        raise HTTPException(status_code=404, detail="session not found")
    if session.status != "active":
        raise HTTPException(status_code=409, detail="session is not active")
    db.add(LoggedSet(session_id=sid, user_id=user.id, exercise_slug=body.slug,
                     substituted_for=body.substituted_for, set_no=body.set_no,
                     weight=body.weight, reps=body.reps, rpe=body.rpe))
    pbs = _update_records(db, user, body, session.day)
    db.commit()
    return {"ok": True, "pbs": pbs}


class CompleteIn(BaseModel):
    cooldown_status: str = "skipped"  # done | partial | skipped
    cooldown_min: int = 5
    notes: str = ""


@router.post("/sessions/{sid}/complete")
def complete_session(sid: str, body: CompleteIn, user: User = Depends(current_user),
                     db: Session = Depends(get_db)):
    session = db.get(WorkoutSession, sid)
    if not session or session.user_id != user.id:
        raise HTTPException(status_code=404, detail="session not found")
    sets = db.query(LoggedSet).filter(LoggedSet.session_id == sid).all()
    planned = sum(t["sets"] for t in (session.fitted or {}).get("targets", []))
    rpes = [s.rpe for s in sets if s.rpe]
    now = utcnow()
    started = session.started_at
    if started is not None and started.tzinfo is None:
        started = started.replace(tzinfo=timezone.utc)
    session.stats = {
        "tonnage": round(sum(s.weight * s.reps for s in sets) / 1000, 2),
        "sets_done": len(sets), "sets_planned": planned,
        "avg_rpe": round(sum(rpes) / len(rpes), 1) if rpes else None,
        "duration_s": int((now - started).total_seconds()) if started else None,
    }
    session.status = "completed"
    session.completed_at = now
    session.cooldown_status = body.cooldown_status
    session.notes = body.notes
    session.fitted = {**(session.fitted or {}), "cooldown_min": body.cooldown_min}
    db.commit()
    return {"ok": True, "stats": session.stats, "cooldown_status": session.cooldown_status}


@router.get("/sessions/{sid}")
def session_detail(sid: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    session = db.get(WorkoutSession, sid)
    if not session or session.user_id != user.id:
        raise HTTPException(status_code=404, detail="session not found")
    sets = (db.query(LoggedSet).filter(LoggedSet.session_id == sid)
            .order_by(LoggedSet.ts).all())
    exmap = exercise_map(db, list({s.exercise_slug for s in sets}))
    grouped: dict[str, dict] = {}
    for s in sets:
        g = grouped.setdefault(s.exercise_slug, {
            "slug": s.exercise_slug,
            "name": exmap[s.exercise_slug].name if s.exercise_slug in exmap else s.exercise_slug,
            "substituted_for": s.substituted_for, "sets": []})
        g["sets"].append({"set_no": s.set_no, "weight": s.weight, "reps": s.reps, "rpe": s.rpe})
    return {"id": session.id, "day": str(session.day), "name": session.name, "kind": session.kind,
            "status": session.status, "stats": session.stats, "notes": session.notes,
            "cooldown_status": session.cooldown_status, "fitted": session.fitted,
            "exercises": list(grouped.values())}


class NotesIn(BaseModel):
    notes: str


@router.patch("/sessions/{sid}/notes")
def annotate_session(sid: str, body: NotesIn, user: User = Depends(current_user),
                     db: Session = Depends(get_db)):
    """Annotate any owned session — e.g. confirm/comment a Watch-synced run (E5.2)."""
    session = db.get(WorkoutSession, sid)
    if not session or session.user_id != user.id:
        raise HTTPException(status_code=404, detail="session not found")
    session.notes = body.notes.strip()
    db.commit()
    return {"ok": True}


# ---------- exercises / swap ----------

@router.get("/exercises")
def list_exercises(q: str = "", user: User = Depends(current_user), db: Session = Depends(get_db)):
    query = db.query(Exercise).order_by(Exercise.name)
    if q:
        query = query.filter(Exercise.name.ilike(f"%{q}%"))
    return [{"slug": e.slug, "name": e.name, "kind": e.kind, "media_tier": e.media_tier,
             "primary_muscles": e.primary_muscles} for e in query.all()]


@router.get("/exercises/{slug}")
def exercise_detail(slug: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    e = db.query(Exercise).filter(Exercise.slug == slug).first()
    if not e:
        raise HTTPException(status_code=404, detail="exercise not found")
    return {"slug": e.slug, "name": e.name, "kind": e.kind,
            "primary_muscles": e.primary_muscles, "secondary_muscles": e.secondary_muscles,
            "equipment": e.equipment, "cues": e.cues, "dont": e.dont, "patterns": e.patterns,
            "benefit": e.benefit or "", "media_tier": e.media_tier, "media_url": e.media_url}


@router.get("/exercises/{slug}/alternatives")
def alternatives(slug: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    base = db.query(Exercise).filter(Exercise.slug == slug).first()
    if not base:
        raise HTTPException(status_code=404, detail="exercise not found")
    prof = active_profile(db, user)
    available = {i["name"] for i in (prof.items if prof else []) if i.get("available")}
    avoid: set[str] = set()
    niggle_names: dict[str, str] = {}
    for n in active_niggles(db, user.id):
        for p in n.avoid_patterns or []:
            avoid.add(p)
            niggle_names[p] = n.body_part
    out = []
    for e in db.query(Exercise).filter(Exercise.kind != "mobility").all():
        if e.slug == slug:
            continue
        shared = set(e.primary_muscles or []) & set(base.primary_muscles or [])
        if not shared:
            continue
        hit = set(e.patterns or []) & avoid
        if hit:
            part = niggle_names[next(iter(hit))]
            out.append({"slug": e.slug, "name": e.name, "excluded": True,
                        "why": f"excluded: {part.lower()} niggle ({next(iter(hit)).replace('_', ' ')})"})
            continue
        missing = [req for req in (e.equipment or []) if req not in available]
        if missing:
            continue
        out.append({"slug": e.slug, "name": e.name, "kind": e.kind, "excluded": False,
                    "why": "same primary: " + ", ".join(sorted(shared)).lower()})
    out.sort(key=lambda a: a["excluded"])
    return out


# ---------- history / progress / records ----------

@router.get("/history")
def history(user: User = Depends(current_user), db: Session = Depends(get_db)):
    rows = (db.query(WorkoutSession)
            .filter(WorkoutSession.user_id == user.id,
                    WorkoutSession.status.in_(["completed", "unplanned"]))
            .order_by(WorkoutSession.day.desc(), WorkoutSession.started_at.desc())
            .limit(60).all())
    return [{"id": s.id, "day": str(s.day), "name": s.name, "kind": s.kind,
             "status": s.status, "stats": s.stats or {}} for s in rows]


def _e1rm_series(db: Session, user_id: str) -> dict:
    """Per-lift e1RM series: best set per completed-session day."""
    sets = (db.query(LoggedSet).join(WorkoutSession, LoggedSet.session_id == WorkoutSession.id)
            .filter(LoggedSet.user_id == user_id, WorkoutSession.status == "completed",
                    LoggedSet.weight > 0).all())
    series: dict[str, dict[str, float]] = {}
    for s in sets:
        day_key = str(s.ts.date())
        e1 = epley_e1rm(s.weight, s.reps)
        cur = series.setdefault(s.exercise_slug, {})
        cur[day_key] = max(cur.get(day_key, 0), e1)
    exmap = exercise_map(db, list(series.keys()))
    return {slug: {"name": exmap[slug].name if slug in exmap else slug,
                   "points": sorted([{"d": d, "v": v} for d, v in days.items()], key=lambda p: p["d"])}
            for slug, days in series.items()}


def _metric_series(db: Session, user_id: str, mtype: str, days: int = 120) -> list[dict]:
    since = utcnow() - timedelta(days=days)
    rows = (db.query(Metric).filter(Metric.user_id == user_id, Metric.type == mtype,
                                    Metric.ts >= since).order_by(Metric.ts).all())
    return [{"d": str(m.ts.date()), "v": m.value} for m in rows]


def _smooth(points: list[dict], window: int = 5) -> list[dict]:
    """Centered rolling mean — VO2max renders raw dots + this trend, never deltas."""
    out = []
    for i in range(len(points)):
        lo, hi = max(0, i - window // 2), min(len(points), i + window // 2 + 1)
        vals = [p["v"] for p in points[lo:hi]]
        out.append({"d": points[i]["d"], "v": round(sum(vals) / len(vals), 2)})
    return out


def _zone2_target_min(rev: PlanRevision | None) -> int:
    """Weekly Zone-2 minutes the plan asks for: cardio days prescribed at low HR."""
    total = 0
    for day in (((rev.content or {}).get("days", {}) or {}) if rev else {}).values():
        c = day.get("cardio") or {}
        if day.get("kind") == "cardio" and (c.get("hr_high") or 999) <= 150:
            total += int(c.get("minutes") or 0)
    return total


def _zone2_week_min(db: Session, user_id: str, week_start: ddate) -> float:
    rows = (db.query(WorkoutSession)
            .filter(WorkoutSession.user_id == user_id, WorkoutSession.kind == "cardio",
                    WorkoutSession.day >= week_start,
                    WorkoutSession.day < week_start + timedelta(days=7)).all())
    return round(sum((s.stats or {}).get("zone2_min", 0) for s in rows), 0)


def _bodycomp(db: Session, user_id: str, days: int = 365) -> dict:
    """Body-composition series (Withings/HAE): fat %, muscle, bone, derived water %."""
    weight = _metric_series(db, user_id, "weight", days)
    weight_by_day = {p["d"]: p["v"] for p in weight}
    water_mass = _metric_series(db, user_id, "water_mass", days)
    water_pct = []
    last_w = None
    for p in water_mass:
        w = weight_by_day.get(p["d"], last_w)
        if w:
            last_w = w
            water_pct.append({"d": p["d"], "v": round(100 * p["v"] / w, 1)})
    return {
        "fat_pct": _metric_series(db, user_id, "body_fat_pct", days),
        "muscle": _metric_series(db, user_id, "muscle_mass", days),
        "bone": _metric_series(db, user_id, "bone_mass", days),
        "water_pct": water_pct,
        "height_cm": (m := _metric_series(db, user_id, "height", 3650)) and m[-1]["v"] or None,
    }


@router.get("/progress")
def progress(user: User = Depends(current_user), db: Session = Depends(get_db)):
    today_d = datetime.now(timezone.utc).date()
    week_start = today_d - timedelta(days=today_d.weekday())
    week_sessions = (db.query(WorkoutSession)
                     .filter(WorkoutSession.user_id == user.id,
                             WorkoutSession.status.in_(["completed", "unplanned"]),
                             WorkoutSession.day >= week_start).count())
    rev = active_revision(db, user.id)
    planned = len(((rev.content or {}).get("days", {}) or {})) if rev else 0
    vo2 = _metric_series(db, user.id, "vo2max", 365)

    return {"e1rm": _e1rm_series(db, user.id),
            "weight": _metric_series(db, user.id, "weight"),
            "vo2max": vo2,
            "vo2max_smooth": _smooth(vo2),
            "resting_hr": _metric_series(db, user.id, "resting_hr"),
            "sleep_h": _metric_series(db, user.id, "sleep_h", 30),
            "zone2": {"done": _zone2_week_min(db, user.id, week_start),
                      "target": _zone2_target_min(rev)},
            "bodycomp": _bodycomp(db, user.id),
            "week": {"done": week_sessions, "planned": planned}}


@router.get("/dashboard")
def dashboard(user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Everything the desktop dashboard renders (E14.1) — same queries the agent uses."""
    from ..models import LabPanel
    today_d = datetime.now(timezone.utc).date()
    this_monday = today_d - timedelta(days=today_d.weekday())
    weeks = [this_monday - timedelta(weeks=i) for i in range(11, -1, -1)]
    rev = active_revision(db, user.id)
    plan_days = ((rev.content or {}).get("days", {}) or {}) if rev else {}

    since = weeks[0]
    sessions = (db.query(WorkoutSession)
                .filter(WorkoutSession.user_id == user.id, WorkoutSession.day >= since,
                        WorkoutSession.status.in_(["completed", "unplanned"])).all())
    by_week_tonnage: dict[str, float] = {str(w): 0.0 for w in weeks}
    by_week_zone2: dict[str, float] = {str(w): 0.0 for w in weeks}
    done_days = set()
    for s in sessions:
        wk = str(s.day - timedelta(days=s.day.weekday()))
        if wk in by_week_tonnage:
            if s.kind == "strength":
                by_week_tonnage[wk] += (s.stats or {}).get("tonnage", 0) or 0
            else:
                by_week_zone2[wk] += (s.stats or {}).get("zone2_min", 0) or 0
        done_days.add(str(s.day))

    # consistency heatmap: 12 weeks × 7 days — planned / done / missed / off
    heatmap = []
    for w in weeks:
        row = []
        for i in range(7):
            d = w + timedelta(days=i)
            planned = str(i) in plan_days
            done = str(d) in done_days
            cell = "future" if d > today_d else \
                   "done" if done else ("missed" if planned else "off")
            row.append({"d": str(d), "s": cell})
        heatmap.append({"week": str(w), "days": row})

    vo2 = _metric_series(db, user.id, "vo2max", 365)
    zone2_target = _zone2_target_min(rev)
    labs = (db.query(LabPanel).filter(LabPanel.user_id == user.id)
            .order_by(LabPanel.drawn_on).all())
    lipids: dict[str, list] = {}
    for p in labs:
        for r in p.results:
            lipids.setdefault(r.marker, []).append(
                {"d": str(p.drawn_on), "v": r.value, "ref_low": r.ref_low, "ref_high": r.ref_high})

    goal_weight = (user.prefs or {}).get("goal_weight_kg")
    prefs = user.prefs or {}
    return {
        "name": user.name, "units": user.units,
        "unit_load": prefs.get("unit_load", "lb"),
        "unit_lipids": prefs.get("unit_lipids", "mmol"),
        "load_units": prefs.get("load_units", {}),
        "bodycomp": _bodycomp(db, user.id),
        "e1rm": _e1rm_series(db, user.id),
        "weight": _metric_series(db, user.id, "weight", 365),
        "goal_weight_kg": goal_weight,
        "vo2max": vo2, "vo2max_smooth": _smooth(vo2),
        "resting_hr": _metric_series(db, user.id, "resting_hr", 180),
        "sleep_h": _metric_series(db, user.id, "sleep_h", 30),
        "tonnage_weekly": [{"week": str(w), "v": round(by_week_tonnage[str(w)], 2)} for w in weeks],
        "zone2_weekly": [{"week": str(w), "v": by_week_zone2[str(w)]} for w in weeks],
        "zone2_target": zone2_target,
        "heatmap": heatmap,
        "lipids": lipids,
        "week": {"done": sum(1 for s in sessions if s.day >= this_monday),
                 "planned": len(plan_days)},
        "records": records(user=user, db=db),
    }


@router.get("/records")
def records(user: User = Depends(current_user), db: Session = Depends(get_db)):
    rows = db.query(Record).filter(Record.user_id == user.id).order_by(Record.exercise_slug).all()
    exmap = exercise_map(db, list({r.exercise_slug for r in rows}))
    return [{"slug": r.exercise_slug,
             "name": exmap[r.exercise_slug].name if r.exercise_slug in exmap else r.exercise_slug,
             "kind": r.kind, "value": r.value, "detail": r.detail,
             "achieved_on": str(r.achieved_on)} for r in rows]
