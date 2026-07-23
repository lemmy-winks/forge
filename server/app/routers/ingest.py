"""Health Auto Export ingest. One endpoint, token-authenticated; the token IS
the user identity. Tolerant of partial/odd payloads — never 500 on data shape."""

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Metric, WorkoutSeries, WorkoutSession, utcnow
from ..security import user_for_ingest_token

router = APIRouter(tags=["ingest"])

# HAE metric name -> (canonical type, unit)
METRIC_MAP = {
    "weight_body_mass": ("weight", "kg"),
    "body_mass": ("weight", "kg"),
    "body_fat_percentage": ("body_fat_pct", "%"),
    "lean_body_mass": ("fat_free_mass", "kg"),
    "height": ("height", "cm"),
    "resting_heart_rate": ("resting_hr", "bpm"),
    # HAE has shipped several spellings of the VO2max metric name across
    # versions — accept them all or historical exports silently drop it.
    "vo2_max": ("vo2max", "ml/kg/min"),
    "vo2max": ("vo2max", "ml/kg/min"),
    "vo2 max": ("vo2max", "ml/kg/min"),
    "cardio_fitness": ("vo2max", "ml/kg/min"),
    "sleep_analysis": ("sleep_h", "h"),
    "heart_rate_variability": ("hrv", "ms"),
    "step_count": ("steps", "count"),
}

# Canonical types stored in kg — honor the payload's mass unit for all of them.
MASS_TYPES = {"weight", "fat_free_mass"}


def _first(d: dict, *keys):
    """First key present with a non-None value — unlike `or`-chains, keeps zeros."""
    for k in keys:
        v = d.get(k)
        if v is not None:
            return v
    return None


def _sleep_hours(sample: dict) -> float | None:
    """Total hours asleep from an HAE sleep_analysis sample. On iOS 16+ (Apple
    Watch sleep stages) the legacy `asleep` bucket is empty and the real sleep
    lives in core/deep/rem — so prefer the stage sum when present, and only fall
    back to a single total (`asleep`/`totalSleep`/`qty`) for older devices."""
    stages = [sample.get(k) for k in ("core", "deep", "rem")]
    vals = [float(s) for s in stages if isinstance(s, (int, float))]
    if vals and sum(vals) > 0:
        return sum(vals)
    total = _first(sample, "asleep", "totalSleep", "totalSleepTime", "qty", "value")
    try:
        return float(total) if total is not None else None
    except (TypeError, ValueError):
        return None


def _parse_ts(raw) -> datetime | None:
    if not raw:
        return None
    for fmt in ("%Y-%m-%d %H:%M:%S %z", "%Y-%m-%dT%H:%M:%S%z"):
        try:
            return datetime.strptime(str(raw), fmt)
        except ValueError:
            continue
    try:
        return datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
    except ValueError:
        return None


# Fixed Zone-2 band for weekly aerobic-base accounting (prescription bands are
# per-plan; this one keeps the weekly Zone-2 total comparable across plans).
ZONE2_BAND = (110, 145)


def _hr_values(w: dict) -> list[float]:
    """Heart-rate samples from an HAE workout payload, tolerant of shape."""
    out = []
    for s in w.get("heartRateData", []) or []:
        v = _first(s, "qty", "Avg", "avg") if isinstance(s, dict) else s
        try:
            out.append(float(v))
        except (TypeError, ValueError):
            continue
    return out


def _downsample(pts: list, cap: int) -> list:
    if len(pts) <= cap:
        return pts
    step = len(pts) / cap
    out = [pts[int(i * step)] for i in range(cap)]
    out[-1] = pts[-1]  # keep the true endpoint
    return out


def _hr_series(w: dict, start: datetime) -> list[list[float]]:
    """[[seconds_from_start, bpm], ...] — timestamped where HAE provides dates,
    else evenly spread across the workout duration."""
    raw = []
    for s in w.get("heartRateData", []) or []:
        v = _first(s, "qty", "Avg", "avg") if isinstance(s, dict) else s
        ts = _parse_ts(s.get("date")) if isinstance(s, dict) else None
        try:
            raw.append((ts, float(v)))
        except (TypeError, ValueError):
            continue
    if not raw:
        return []
    try:  # TypeError on missing/naive timestamps → even spacing below
        pts = [[round((ts - start).total_seconds(), 1), bpm] for ts, bpm in sorted(raw)]
    except TypeError:
        dur, wunit = w.get("duration"), ""
        if isinstance(dur, dict):
            wunit, dur = str(dur.get("units", "")).lower(), dur.get("qty")
        try:
            dur_s = float(dur) * (60.0 if wunit == "min" else 1.0)
        except (TypeError, ValueError):
            dur_s = float(len(raw))
        pts = [[round(i * dur_s / max(1, len(raw) - 1), 1), bpm] for i, (_, bpm) in enumerate(raw)]
    return _downsample(pts, 600)


def _route_points(w: dict) -> list[list[float]]:
    """[[lat, lon], ...] from HAE route data (present only when the HAE app's
    'route data' export option is on)."""
    pts = []
    for p in w.get("route", []) or []:
        if not isinstance(p, dict):
            continue
        lat, lon = _first(p, "lat", "latitude"), _first(p, "lon", "lng", "longitude")
        try:
            pts.append([round(float(lat), 6), round(float(lon), 6)])
        except (TypeError, ValueError):
            continue
    return _downsample(pts, 800)


def _minutes_in_band(hrs: list[float], duration_s: float, low: float, high: float) -> float:
    """Samples are ~evenly spaced, so time in band ≈ duration × fraction in band."""
    if not hrs or not duration_s:
        return 0.0
    frac = sum(1 for h in hrs if low <= h <= high) / len(hrs)
    return round(duration_s / 60 * frac, 1)


def _series_data(w: dict, start: datetime) -> dict:
    out = {}
    hr = _hr_series(w, start)
    if hr:
        out["hr"] = hr
    route = _route_points(w)
    if route:
        out["route"] = route
    return out


def _attach_series(db: Session, sess: WorkoutSession, w: dict, start: datetime) -> bool:
    """Backfill traces onto an already-ingested session. Returns True if stored."""
    if db.query(WorkoutSeries.id).filter(WorkoutSeries.session_id == sess.id).first():
        return False
    series = _series_data(w, start)
    if not series:
        return False
    db.add(WorkoutSeries(session_id=sess.id, user_id=sess.user_id, data=series))
    hrs = [bpm for _, bpm in series.get("hr", [])]
    if hrs:  # fill zone stats that predate series capture
        stats = dict(sess.stats or {})
        duration = stats.get("duration_s", 0)
        stats.setdefault("hr_samples", len(hrs))
        stats.setdefault("zone2_min", _minutes_in_band(hrs, duration, *ZONE2_BAND))
        target = stats.get("target") or {}
        low, high = target.get("hr_low"), target.get("hr_high")
        if low and high and "pct_in_zone" not in stats:
            zone_min = _minutes_in_band(hrs, duration, low, high)
            stats["zone_min"] = zone_min
            stats["pct_in_zone"] = round(100 * zone_min / (duration / 60), 0) if duration else 0
        sess.stats = stats
    return True


def _match_prescription(db: Session, user_id: str, day, name: str) -> tuple[dict, str] | None:
    """Planned cardio entry for this date whose type matches the workout name.
    A day already completed stays claimed — a second workout stays unplanned."""
    from .training import active_revision
    rev = active_revision(db, user_id)
    if not rev:
        return None
    entry = ((rev.content or {}).get("days", {}) or {}).get(str(day.weekday()))
    if not entry or entry.get("kind") != "cardio":
        return None
    ctype = str((entry.get("cardio") or {}).get("type", "")).lower()
    # no prescribed type = nothing to match against — never complete the day off
    # an arbitrary workout (a strength session would otherwise claim it)
    if not ctype or ctype not in name.lower():
        return None
    already = (db.query(WorkoutSession.id)
               .filter(WorkoutSession.user_id == user_id, WorkoutSession.day == day,
                       WorkoutSession.kind == "cardio", WorkoutSession.status == "completed")
               .first())
    if already:
        return None
    return entry, str(day.weekday())


def _store_metric(db: Session, user_id: str, mtype: str, value: float, unit: str, ts: datetime, source: str) -> bool:
    exists = (db.query(Metric.id)
              .filter(Metric.user_id == user_id, Metric.type == mtype, Metric.ts == ts, Metric.source == source)
              .first())
    if exists:
        return False
    db.add(Metric(user_id=user_id, type=mtype, value=value, unit=unit, ts=ts, source=source))
    return True


@router.post("/ingest")
async def ingest(request: Request,
                 authorization: str = Header(default=""),
                 db: Session = Depends(get_db)):
    token = authorization.removeprefix("Bearer ").strip()
    if not token:
        token = request.query_params.get("token", "")
    tok = user_for_ingest_token(db, token)
    if not tok:
        raise HTTPException(status_code=401, detail="unknown ingest token")

    try:
        payload = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="body must be JSON")

    data = payload.get("data", payload) if isinstance(payload, dict) else {}
    stored = skipped = 0

    for metric in data.get("metrics", []) or []:
        name = str(metric.get("name", "")).lower()
        mapped = METRIC_MAP.get(name)
        if not mapped:
            continue
        mtype, unit = mapped
        # Honor the payload's units — HAE exports whatever Apple Health is set to.
        src_unit = str(metric.get("units", "")).lower()
        factor = 1.0
        if mtype in MASS_TYPES and src_unit in ("lb", "lbs"):
            factor = 0.45359237
        elif mtype in MASS_TYPES and src_unit == "st":
            factor = 6.35029318
        elif mtype == "height" and src_unit in ("m", "meter", "metres", "meters"):
            factor = 100.0
        elif mtype == "height" and src_unit in ("in", "inch", "inches"):
            factor = 2.54
        for sample in metric.get("data", []) or []:
            # sleep samples may carry only sleepStart/inBedStart, no plain date
            ts = _parse_ts(sample.get("date") or sample.get("startDate")
                           or sample.get("sleepStart") or sample.get("inBedStart"))
            if ts is None:
                continue
            if mtype == "sleep_h":
                value = _sleep_hours(sample)
                if value is None:
                    skipped += 1
                    continue
                if src_unit in ("min", "mins", "minute", "minutes"):
                    value /= 60.0  # HAE usually reports hours, but honor minutes
            else:
                try:
                    value = float(_first(sample, "qty", "Avg", "avg")) * factor
                except (TypeError, ValueError):
                    continue
            if _store_metric(db, tok.user_id, mtype, round(value, 2), unit, ts, "hae"):
                stored += 1
            else:
                skipped += 1

    for w in data.get("workouts", []) or []:
        start = _parse_ts(w.get("start") or w.get("startDate"))
        if start is None:
            continue
        name = str(w.get("name", "Workout"))
        existing = (db.query(WorkoutSession)
                    .filter(WorkoutSession.user_id == tok.user_id,
                            WorkoutSession.kind == "cardio",
                            WorkoutSession.started_at == start)
                    .first())
        if existing:
            # Re-sent workout (HAE manual export of past days): attach the
            # series we used to throw away, so history can be backfilled.
            if _attach_series(db, existing, w, start):
                stored += 1
            else:
                skipped += 1
            continue
        stats = {}
        for key, out in (("duration", "duration_s"), ("distance", "distance"),
                         ("avgHeartRate", "avg_hr"), ("maxHeartRate", "max_hr"),
                         ("activeEnergyBurned", "kcal")):
            v = w.get(key)
            wunit = ""
            if isinstance(v, dict):
                wunit = str(v.get("units", "")).lower()
                v = v.get("qty")
            if v is not None:
                try:
                    val = float(v)
                except (TypeError, ValueError):
                    continue
                # honor the payload's units — same invariant as body metrics
                if out == "distance" and wunit in ("mi", "mile", "miles"):
                    val *= 1.609344
                elif out == "distance" and wunit in ("m", "meter", "meters", "metres"):
                    val /= 1000.0
                elif out == "kcal" and wunit == "kj":
                    val *= 0.2390057
                elif out == "duration_s" and wunit == "min":
                    val *= 60.0
                stats[out] = round(val, 3)
        duration = stats.get("duration_s", 0)
        if stats.get("distance") and duration:
            stats["pace_min_km"] = round(duration / 60 / stats["distance"], 2)
        hrs = _hr_values(w)
        if hrs:
            stats["hr_samples"] = len(hrs)
            stats["zone2_min"] = _minutes_in_band(hrs, duration, *ZONE2_BAND)

        # Reconcile against the plan (E5.2): a planned cardio day on this date
        # whose type matches becomes a completed session with target-vs-actual.
        matched = _match_prescription(db, tok.user_id, start.date(), name)
        fitted: dict = {"source": "watch"}
        status = "unplanned"
        if matched:
            entry, day_key = matched
            target = dict(entry.get("cardio") or {})
            status = "completed"
            name = entry.get("name") or name
            stats["target"] = {k: target.get(k) for k in ("type", "minutes", "hr_low", "hr_high")}
            low, high = target.get("hr_low"), target.get("hr_high")
            if hrs and low and high:
                zone_min = _minutes_in_band(hrs, duration, low, high)
                stats["zone_min"] = zone_min
                stats["pct_in_zone"] = round(100 * zone_min / (duration / 60), 0) if duration else 0
            fitted.update({"matched_day": day_key, "target": target})
        sess = WorkoutSession(user_id=tok.user_id, day=start.date(), name=name, kind="cardio",
                              status=status, started_at=start, completed_at=_parse_ts(w.get("end")),
                              stats=stats, fitted=fitted)
        db.add(sess)
        series = _series_data(w, start)
        if series:
            db.flush()
            db.add(WorkoutSeries(session_id=sess.id, user_id=tok.user_id, data=series))
        stored += 1

    tok.samples = (tok.samples or 0) + stored
    tok.last_seen_at = utcnow()
    db.commit()
    return {"ok": True, "stored": stored, "skipped": skipped}
