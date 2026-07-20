"""Demo user: Bruce Willis, one year of believable training history.

Seeded deterministically (random.Random(42)) so every reset produces the same
story: a year of squat/bench progression with a mid-year holiday gap and a
bench stall + deload, steady weight loss, improving aerobic base and lipids,
one cleared and one active niggle, a chat history, and a pending proposal.

The demo user has role='demo': excluded from the two-seat cap, the admin user
list, dev sign-in buttons and the Sunday review scheduler. Anyone who can
reach the sign-in page can open the demo (that's the point) — their session
sees only Bruce's data, same user-scoping as everyone else.
"""

import math
import random
from datetime import date, datetime, time, timedelta, timezone

from sqlalchemy.orm import Session

from .fitting import epley_e1rm
from .models import (AgentRun, ChatMessage, EquipmentProfile, IngestToken, LabPanel, LabResult,
                     LoggedSet, Metric, Niggle, Plan, PlanRevision, Record, User,
                     WorkoutSeries, WorkoutSession)
from .security import new_ingest_token
from .seed import _week, seed_user_defaults

DEMO_EMAIL = "bruce@demo.forge"
DEMO_NAME = "Bruce Willis"


def demo_user(db: Session) -> User | None:
    return db.query(User).filter(User.email == DEMO_EMAIL).first()


def _run_series(rng: random.Random, dur: int, dist: float, avg_hr: int,
                intervals: bool) -> dict:
    """Believable HR trace + a riverside-loop route sized to the run distance."""
    hr, n = [], max(2, dur // 10)
    for i in range(n):
        t = i / (n - 1)
        ramp = min(1.0, t * 6)  # ~first sixth: warm-up climb
        bpm = 92 + (avg_hr - 92) * ramp + 3 * math.sin(t * 9) + rng.uniform(-3, 3)
        if intervals and t > 0.15:
            bpm += 14 * (1 if int(t * 14) % 2 else -1)  # work/rest surges
        hr.append([round(t * dur, 1), round(min(bpm, avg_hr + 22), 1)])
    lat0, lon0 = 53.3388, -6.3699  # Cherry Orchard, Dublin — loop through the park
    coslat = math.cos(math.radians(lat0))
    r_km = dist / (2 * math.pi)
    route, m = [], 240
    for i in range(m + 1):
        a = 2 * math.pi * i / m
        wobble = 1 + 0.16 * math.sin(3 * a) + 0.05 * math.sin(7 * a + 1.3)
        route.append([round(lat0 + (r_km * wobble / 111.0) * math.sin(a), 6),
                      round(lon0 + (r_km * wobble * 1.35 / (111.0 * coslat)) * math.cos(a), 6)])
    return {"hr": hr, "route": route}


def _ts(d: date, hh: int, mm: int) -> datetime:
    return datetime.combine(d, time(hh, mm), tzinfo=timezone.utc)


def _scale(week: int) -> float:
    """Training intensity over the year: steady climb, deload every 8th week,
    a two-week holiday dip around week 24, bench-stall handled separately."""
    s = 0.75 + week * 0.0105
    if week % 8 == 7:
        s -= 0.05
    if week in (24, 25):
        s -= 0.12
    return round(min(s, 1.3), 4)


def seed_demo(db: Session) -> User:
    """Create Bruce + his year. Idempotent — returns the existing user if present."""
    existing = demo_user(db)
    if existing:
        return existing
    rng = random.Random(42)
    today = date.today()
    monday0 = today - timedelta(days=today.weekday()) - timedelta(weeks=52)

    bruce = User(email=DEMO_EMAIL, name=DEMO_NAME, role="demo", units="kg",
                 prefs={"onboarded": True, "notif_proposal": False, "notif_reminder": False})
    db.add(bruce)
    db.flush()
    db.add(IngestToken(user_id=bruce.id, token=new_ingest_token()))

    # plan + revision history (one revision a month, latest active, one proposed)
    plan = Plan(user_id=bruce.id, goal="Rebuild strength after the layoff; drop to 88 kg; "
                                       "aerobic base for a spring half marathon.", status="active")
    db.add(plan)
    db.flush()
    seed_user_defaults(db, bruce)  # equipment only — plan already exists

    rev_weeks = list(range(0, 52, 4))
    for i, w in enumerate(rev_weeks):
        db.add(PlanRevision(plan_id=plan.id, num=i + 1,
                            status="active" if w == rev_weeks[-1] else "superseded",
                            content=_week(scale=_scale(w)),
                            rationale=f"Block {i + 1}: progression per the weekly reviews."))
    next_content = _week(scale=_scale(52))
    for k, day in next_content["days"].items():
        day["why"] = {"0": "Squat earned another 2.5 kg — all reps clean at RPE 7",
                      "2": "Zone 2 up 5 min; base is building nicely",
                      "4": "Bench holds after the deload — rebuild to 3×8 first",
                      "5": "Intervals unchanged — big week on the legs already"}.get(k, "Steady week")
    next_content["changes"] = [
        {"sign": "+", "what": "Back Squat +2.5 kg", "why": "all reps clean at RPE 7 two weeks running"},
        {"sign": "~", "what": "Zone 2 45 → 50 min", "why": "HR drift is down — extend the base work"},
        {"sign": "~", "what": "Bench Press holds", "why": "rebuild to 3×8 after the deload before adding load"},
    ]
    db.add(PlanRevision(plan_id=plan.id, num=len(rev_weeks) + 1, status="proposed",
                        content=next_content,
                        rationale="This week takes squat to 77.5 kg for the first time and banks "
                                  "72 aerobic minutes across the easy run and intervals. Keep the "
                                  "Zone-2 run under 140 bpm and the base block stays on schedule "
                                  "for the spring half."))

    # a year of sessions + sets
    best: dict[str, dict[str, tuple[float, str, date]]] = {}
    for w in range(52):
        week_content = _week(scale=_scale(w))
        for day_key, entry in week_content["days"].items():
            d = monday0 + timedelta(weeks=w, days=int(day_key))
            if d >= today:
                continue
            if entry["kind"] == "strength":
                if rng.random() > 0.92 or (w in (24, 25) and rng.random() < 0.8):
                    continue  # missed session / holiday fortnight
                sess = WorkoutSession(user_id=bruce.id, day=d, name=entry["name"], kind="strength",
                                      status="completed", started_at=_ts(d, 17, 58),
                                      completed_at=_ts(d, 18, 55),
                                      fitted={"name": entry["name"]},
                                      cooldown_status="done" if rng.random() < 0.8 else "skipped",
                                      notes=rng.choice(["", "", "", "Felt strong", "Rushed — 45 min",
                                                        "Shoulder fine today"]))
                db.add(sess)
                db.flush()
                tonnage = 0.0
                n_sets = 0
                for ex in entry["exercises"]:
                    swap = ex["slug"] == "back-squat" and rng.random() < 0.06
                    slug = "leg-press" if swap else ex["slug"]
                    weight = round(ex["weight"] * (1.7 if swap else 1.0) / 2.5) * 2.5
                    for set_no in range(1, ex["sets"] + 1):
                        reps = ex["reps"] - (1 if rng.random() < 0.12 and set_no == ex["sets"] else 0)
                        db.add(LoggedSet(session_id=sess.id, user_id=bruce.id, exercise_slug=slug,
                                         substituted_for=ex["slug"] if swap else None,
                                         set_no=set_no, weight=weight, reps=reps,
                                         rpe=rng.choice([6, 7, 7, 8, 8, 9]),
                                         ts=_ts(d, 18, 4 + set_no * 4)))
                        tonnage += weight * reps
                        n_sets += 1
                        if weight > 0:
                            e1 = epley_e1rm(weight, reps)
                            cur = best.setdefault(slug, {})
                            if e1 > cur.get("e1rm", (0,))[0]:
                                cur["e1rm"] = (e1, f"{weight:g} kg × {reps}", d)
                            if weight > cur.get("best_set", (0,))[0]:
                                cur["best_set"] = (weight, f"{weight:g} kg × {reps}", d)
                sess.stats = {"sets_done": n_sets, "tonnage": round(tonnage / 1000, 2),
                              "duration_s": 3420 + rng.randint(-400, 500)}
            else:
                if rng.random() > (0.55 if int(day_key) == 5 else 0.88) or w in (24, 25):
                    continue  # intervals get skipped more than the easy run
                c = entry["cardio"]
                dur = c["minutes"] * 60 + rng.randint(-240, 420)
                pace = max(4.9, 6.4 - w * 0.016 + rng.uniform(-0.15, 0.15))
                dist = round(dur / 60 / pace, 2)
                in_zone = min(0.97, 0.68 + w * 0.005 + rng.uniform(-0.06, 0.06))
                stats = {"duration_s": dur, "distance": dist, "pace_min_km": round(pace, 2),
                         "avg_hr": (c["hr_low"] + c["hr_high"]) // 2 + rng.randint(-4, 4),
                         "hr_samples": dur // 5,
                         "zone2_min": round(dur / 60 * (in_zone if c["hr_high"] <= 145 else 0.2), 1),
                         "target": {k: c.get(k) for k in ("type", "minutes", "hr_low", "hr_high")},
                         "zone_min": round(dur / 60 * in_zone, 1),
                         "pct_in_zone": round(100 * in_zone, 0)}
                sess = WorkoutSession(user_id=bruce.id, day=d, name=entry["name"], kind="cardio",
                                      status="completed", started_at=_ts(d, 7, 12),
                                      completed_at=_ts(d, 7, 12) + timedelta(seconds=dur),
                                      fitted={"source": "watch", "matched_day": day_key,
                                              "target": c},
                                      stats=stats)
                db.add(sess)
                if w >= 40:  # traces only for recent runs — keeps the reset snappy
                    db.flush()
                    db.add(WorkoutSeries(session_id=sess.id, user_id=bruce.id,
                                         data=_run_series(rng, dur, dist, stats["avg_hr"],
                                                          intervals=c["hr_high"] > 145)))

    for slug, kinds in best.items():
        for kind, (value, detail, achieved) in kinds.items():
            db.add(Record(user_id=bruce.id, exercise_slug=slug, kind=kind,
                          value=value, detail=detail, achieved_on=achieved))

    # body + recovery metrics, daily-ish for a year
    for i in range(365):
        d = today - timedelta(days=365 - i)
        wt = 96.0 - 8.5 * min(1.0, i / 320) + (1.1 if 168 <= i <= 182 else 0)  # holiday bump
        if rng.random() < 0.86:
            db.add(Metric(user_id=bruce.id, type="weight", value=round(wt + rng.uniform(-0.5, 0.5), 1),
                          unit="kg", ts=_ts(d, 7, 12), source="hae"))
        if rng.random() < 0.9:
            db.add(Metric(user_id=bruce.id, type="sleep_h", value=round(rng.uniform(6.1, 8.3), 1),
                          unit="h", ts=_ts(d, 9, 1), source="hae"))
        if rng.random() < 0.8:
            db.add(Metric(user_id=bruce.id, type="resting_hr",
                          value=round(58 - 7 * min(1.0, i / 330) + rng.uniform(-1.5, 1.5)),
                          unit="bpm", ts=_ts(d, 9, 2), source="hae"))
        if i % 14 == 3:
            db.add(Metric(user_id=bruce.id, type="vo2max",
                          value=round(38.2 + 5.1 * min(1.0, i / 340) + rng.uniform(-0.4, 0.4), 1),
                          unit="ml/kg/min", ts=_ts(d, 10, 0), source="hae"))

    # labs: three panels, trending into range
    for days_ago, ldl, hdl, tg in ((330, 3.9, 1.0, 2.1), (170, 3.3, 1.1, 1.7), (25, 2.8, 1.2, 1.3)):
        panel = LabPanel(user_id=bruce.id, drawn_on=today - timedelta(days=days_ago), source="manual")
        db.add(panel)
        db.flush()
        total = round(ldl + hdl + tg * 0.45, 1)
        for marker, value, lo, hi in (("LDL", ldl, None, 3.0), ("HDL", hdl, 1.0, None),
                                      ("Triglycerides", tg, None, 1.7), ("Total", total, None, 5.0)):
            db.add(LabResult(panel_id=panel.id, marker=marker, value=value,
                             ref_low=lo, ref_high=hi))

    db.add(Niggle(user_id=bruce.id, body_part="Left ankle", severity="mild", status="cleared",
                  note="Rolled it trail running — fully settled", avoid_patterns=[],
                  opened_at=_ts(today - timedelta(days=260), 9, 0),
                  cleared_at=_ts(today - timedelta(days=210), 9, 0)))
    db.add(Niggle(user_id=bruce.id, body_part="Right shoulder", severity="mild", status="active",
                  note="Grumbles on overhead work — pressing from the landmine instead",
                  avoid_patterns=["overhead_press"],
                  opened_at=_ts(today - timedelta(days=40), 9, 0)))

    # chat history + agent-run ledger so the Coach screen opens mid-conversation
    chat = [
        ("me", "Shoulder was fine on the landmine press today, barely felt it"),
        ("coach", "Good sign. We'll keep overhead work out for another two weeks anyway — "
                  "the landmine gives you the same pressing volume at a friendlier angle. "
                  "If it stays quiet, I'll reintroduce a light overhead press in the next block."),
        ("me", "Also can we push the Saturday intervals to Sunday this week? Work thing"),
        ("coach", "Done — intervals moved to Sunday morning. I've kept them well clear of "
                  "Monday's squats: go easy on the warm-up and cap it at 4 rounds if the "
                  "legs feel Monday's session coming."),
        ("me", "How's the weight trend looking?"),
        ("coach", "Right on plan: −0.22 kg/week over the last month, 88.9 kg this morning — "
                  "1.4 kg from goal. Strength is holding while it drops (squat e1RM is up "
                  "6 kg this block), which is exactly the trade we want. This week's "
                  "proposal is waiting on the Today screen when you're ready."),
    ]
    for i, (who, text) in enumerate(chat):
        db.add(ChatMessage(user_id=bruce.id, who=who, text=text,
                           created_at=_ts(today - timedelta(days=3), 19, 10 + i)))
    for w in range(8):
        d = today - timedelta(days=today.weekday() + 1 + 7 * w)  # recent Sundays
        db.add(AgentRun(user_id=bruce.id, kind="review", model="claude-sonnet-5",
                        input_tokens=rng.randint(38000, 61000), output_tokens=rng.randint(1400, 2600),
                        tool_calls=rng.randint(6, 11), ok=1, created_at=_ts(d, 20, 2)))

    db.commit()
    return bruce


def delete_demo(db: Session) -> bool:
    """Remove Bruce and every row he owns. Returns False if he doesn't exist."""
    bruce = demo_user(db)
    if not bruce:
        return False
    sess_ids = [i for (i,) in db.query(WorkoutSession.id).filter_by(user_id=bruce.id)]
    if sess_ids:
        db.query(LoggedSet).filter(LoggedSet.session_id.in_(sess_ids)).delete(synchronize_session=False)
    panel_ids = [i for (i,) in db.query(LabPanel.id).filter_by(user_id=bruce.id)]
    if panel_ids:
        db.query(LabResult).filter(LabResult.panel_id.in_(panel_ids)).delete(synchronize_session=False)
    plan_ids = [i for (i,) in db.query(Plan.id).filter_by(user_id=bruce.id)]
    if plan_ids:
        db.query(PlanRevision).filter(PlanRevision.plan_id.in_(plan_ids)).delete(synchronize_session=False)
    for model in (WorkoutSeries, WorkoutSession, LabPanel, Plan, Metric, Record, Niggle,
                  ChatMessage, AgentRun, IngestToken, EquipmentProfile):
        db.query(model).filter_by(user_id=bruce.id).delete(synchronize_session=False)
    db.delete(bruce)
    db.commit()
    return True
