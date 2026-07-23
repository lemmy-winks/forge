import logging
import threading

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..config import get_settings
from ..models import (ChatMessage, EquipmentProfile, IngestToken, LabPanel, LabResult,
                      Metric, Niggle, User, utcnow)
from ..db import get_db
from ..security import current_user, new_ingest_token

log = logging.getLogger("forge.coach")

router = APIRouter(prefix="/api", tags=["misc"])


# ---------- equipment ----------

@router.get("/equipment")
def equipment(user: User = Depends(current_user), db: Session = Depends(get_db)):
    rows = (db.query(EquipmentProfile)
            .filter((EquipmentProfile.user_id == user.id) | (EquipmentProfile.user_id.is_(None)))
            .all())
    return {"active_id": user.active_profile_id,
            "profiles": [{"id": p.id, "name": p.name, "shared": p.user_id is None,
                          "items": p.items, "bar_kg": p.bar_kg, "plates_kg": p.plates_kg,
                          "db_max_kg": p.db_max_kg} for p in rows]}


class ActiveProfile(BaseModel):
    profile_id: str


@router.post("/equipment/active")
def set_active(body: ActiveProfile, user: User = Depends(current_user), db: Session = Depends(get_db)):
    prof = db.get(EquipmentProfile, body.profile_id)
    if not prof or (prof.user_id not in (None, user.id)):
        raise HTTPException(status_code=404, detail="profile not found")
    user.active_profile_id = prof.id
    db.commit()
    return {"ok": True}


class ItemsIn(BaseModel):
    items: list[dict]


@router.patch("/equipment/{pid}")
def update_items(pid: str, body: ItemsIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    prof = db.get(EquipmentProfile, pid)
    if not prof or (prof.user_id not in (None, user.id)):
        raise HTTPException(status_code=404, detail="profile not found")
    prof.items = body.items
    db.commit()
    return {"ok": True}


# ---------- niggles ----------

@router.get("/niggles")
def niggles(user: User = Depends(current_user), db: Session = Depends(get_db)):
    rows = (db.query(Niggle).filter(Niggle.user_id == user.id)
            .order_by(Niggle.opened_at.desc()).all())
    return [{"id": n.id, "body_part": n.body_part, "severity": n.severity, "status": n.status,
             "note": n.note, "avoid_patterns": n.avoid_patterns,
             "opened_at": str(n.opened_at.date()) if n.opened_at else None,
             "cleared_at": str(n.cleared_at.date()) if n.cleared_at else None} for n in rows]


class NiggleIn(BaseModel):
    body_part: str
    severity: str = "mild"
    note: str = ""
    avoid_patterns: list[str] = []
    mobility_slug: str = ""


@router.post("/niggles")
def add_niggle(body: NiggleIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    n = Niggle(user_id=user.id, body_part=body.body_part, severity=body.severity,
               note=body.note, avoid_patterns=body.avoid_patterns, mobility_slug=body.mobility_slug)
    db.add(n)
    db.commit()
    return {"id": n.id}


class NigglePatch(BaseModel):
    status: str  # active | watch | cleared


@router.patch("/niggles/{nid}")
def patch_niggle(nid: str, body: NigglePatch, user: User = Depends(current_user), db: Session = Depends(get_db)):
    n = db.get(Niggle, nid)
    if not n or n.user_id != user.id:
        raise HTTPException(status_code=404, detail="niggle not found")
    if body.status not in ("active", "watch", "cleared"):
        raise HTTPException(status_code=400, detail="bad status")
    n.status = body.status
    n.cleared_at = utcnow() if body.status == "cleared" else None
    db.commit()
    return {"ok": True}


# ---------- labs ----------

@router.get("/labs")
def labs(user: User = Depends(current_user), db: Session = Depends(get_db)):
    panels = (db.query(LabPanel).filter(LabPanel.user_id == user.id)
              .order_by(LabPanel.drawn_on).all())
    return [{"id": p.id, "drawn_on": str(p.drawn_on), "source": p.source,
             "results": [{"marker": r.marker, "value": r.value, "unit": r.unit,
                          "ref_low": r.ref_low, "ref_high": r.ref_high} for r in p.results]}
            for p in panels]


class LabResultIn(BaseModel):
    marker: str
    value: float
    unit: str = "mmol/L"
    ref_low: float | None = None
    ref_high: float | None = None


class LabPanelIn(BaseModel):
    drawn_on: str
    source: str = "manual"
    results: list[LabResultIn]


@router.post("/labs")
def add_panel(body: LabPanelIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    from .training import parse_date
    p = LabPanel(user_id=user.id, drawn_on=parse_date(body.drawn_on), source=body.source)
    db.add(p)
    db.flush()
    for r in body.results:
        db.add(LabResult(panel_id=p.id, marker=r.marker, value=r.value, unit=r.unit,
                         ref_low=r.ref_low, ref_high=r.ref_high))
    db.commit()
    return {"id": p.id}


# ---------- chat (async: the agent loop runs in a worker thread; the client
# polls GET /api/chat, which reports `pending` — replies land in history even
# if the phone locks or the user navigates away mid-thought) ----------

_CHAT_ACTIVE: set[str] = set()
_CHAT_LOCK = threading.Lock()


def _chat_context(db: Session, user: User, ctx: dict | None) -> tuple[str, str]:
    """(short tag stored in the message, full data attached for this run only)."""
    import json as _json
    if not ctx:
        return "", ""
    kind, ref = ctx.get("kind"), str(ctx.get("id", ""))
    try:
        if kind == "session":
            from .training import session_detail
            d = session_detail(ref, user=user, db=db)
            return (f"[re: session {d['day']} · {d['name']}]",
                    f"[Attached session data: {_json.dumps(d, default=str)[:4000]}]")
        if kind == "exercise":
            from ..models import Exercise
            e = db.query(Exercise).filter(Exercise.slug == ref).first()
            if not e:
                return "", ""
            return (f"[re: exercise {e.name}]",
                    f"[Attached exercise data: name={e.name}, kind={e.kind}, cues={e.cues}, "
                    f"dont={e.dont}, patterns={e.patterns}, primary={e.primary_muscles}]")
        if kind == "proposal":
            from .coach_api import get_proposal
            p = get_proposal(user=user, db=db)["proposal"]
            if not p:
                return "", ""
            return ("[re: the proposed week]",
                    f"[Attached pending proposal: {_json.dumps(p, default=str)[:4000]}]")
    except Exception:
        return "", ""
    return "", ""


def _run_chat_bg(user_id: str, text: str, extra_context: str) -> None:
    from ..coach import CoachUnavailable, run_chat
    from ..db import SessionLocal
    db = SessionLocal()
    try:
        user = db.get(User, user_id)
        try:
            reply = run_chat(db, user, text, extra_context)
        except CoachUnavailable:
            reply = ("Saved — but the coach isn't configured yet: add an Anthropic API key in "
                     "Settings → Server. Your messages and data are all stored meanwhile.")
        except Exception as e:
            log.exception("coach chat failed for user %s", user_id)
            if "credit balance" in str(e).lower():
                reply = ("The coach's API account is out of credits — top up at "
                         "console.anthropic.com → Billing, then just message me again "
                         "(no restart needed).")
            else:
                reply = ("The coach hit an error mid-thought — your message is saved, try again in a "
                         "moment. (Details are in the server logs.)")
        db.add(ChatMessage(user_id=user_id, who="coach", text=reply))
        db.commit()
    finally:
        db.close()
        with _CHAT_LOCK:
            _CHAT_ACTIVE.discard(user_id)


@router.get("/chat")
def chat_history(user: User = Depends(current_user), db: Session = Depends(get_db)):
    rows = (db.query(ChatMessage).filter(ChatMessage.user_id == user.id)
            .order_by(ChatMessage.created_at).limit(200).all())
    with _CHAT_LOCK:
        pending = user.id in _CHAT_ACTIVE
    return {"messages": [{"who": m.who, "text": m.text, "at": m.created_at.isoformat()} for m in rows],
            "pending": pending}


class ChatIn(BaseModel):
    text: str
    context: dict | None = None  # {kind: 'session'|'exercise'|'proposal', id}


@router.post("/chat")
def chat_send(body: ChatIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    text = body.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="empty message")
    with _CHAT_LOCK:
        if user.id in _CHAT_ACTIVE:
            raise HTTPException(status_code=409, detail="the coach is still thinking — one moment")
        _CHAT_ACTIVE.add(user.id)
    try:
        tag, extra = _chat_context(db, user, body.context)
        stored = text + ("\n" + tag if tag else "")
        db.add(ChatMessage(user_id=user.id, who="me", text=stored))
        db.commit()
        threading.Thread(target=_run_chat_bg, args=(user.id, stored, extra), daemon=True).start()
    except HTTPException:
        raise
    except Exception:
        with _CHAT_LOCK:
            _CHAT_ACTIVE.discard(user.id)
        raise
    return {"pending": True}


# ---------- connections / prefs / export ----------

def _withings_status(user: User, db: Session) -> dict:
    from ..models import WithingsLink
    settings = get_settings()
    link = db.query(WithingsLink).filter(WithingsLink.user_id == user.id).first()
    configured = bool(settings.withings_client_id and settings.withings_client_secret)
    return {
        "configured": configured,
        "linked": link is not None,
        "status": link.status if link else None,
        "last_sync": link.last_sync_at.isoformat() if link and link.last_sync_at else None,
        "warning": ("Withings link needs re-authorising — token refresh failed"
                    if link and link.status == "refresh_failed" else None),
        "note": ("linked" if link else
                 "link your account" if configured else
                 "add Withings API credentials in Settings → Server"),
    }


@router.get("/connections")
def connections(user: User = Depends(current_user), db: Session = Depends(get_db)):
    tok = db.query(IngestToken).filter(IngestToken.user_id == user.id).first()
    return {
        "apple_health": {
            "configured": tok is not None,
            "token_masked": (tok.token[:8] + "…" + tok.token[-4:]) if tok else None,
            "last_push": tok.last_seen_at.isoformat() if tok and tok.last_seen_at else None,
            "samples": tok.samples if tok else 0,
            "endpoint": "/ingest",
        },
        "withings": _withings_status(user, db),
        "coach_mcp": {"active": bool(get_settings().anthropic_api_key),
                      "note": ("agent live" if get_settings().anthropic_api_key
                               else "add an API key in Settings → Server")},
    }


@router.post("/connections/rotate-token")
def rotate_token(user: User = Depends(current_user), db: Session = Depends(get_db)):
    tok = db.query(IngestToken).filter(IngestToken.user_id == user.id).first()
    if not tok:
        tok = IngestToken(user_id=user.id, token=new_ingest_token())
        db.add(tok)
    else:
        tok.token = new_ingest_token()
        tok.samples = 0
        tok.last_seen_at = None
    db.commit()
    return {"token": tok.token}


@router.get("/connections/token")
def reveal_token(user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Full ingest token for the signed-in owner — the UI shows it masked and only
    puts the real value on the clipboard (MCP client config needs it verbatim)."""
    tok = db.query(IngestToken).filter(IngestToken.user_id == user.id).first()
    if not tok:
        raise HTTPException(404, "No token yet — rotate to create one")
    return {"token": tok.token}


# Manual body measurements (height etc.) land in the same metrics stream the
# integrations write to — source 'manual', latest value wins on read.
BODY_TYPES = {"height": "cm", "weight": "kg", "body_fat_pct": "%"}


class BodyIn(BaseModel):
    type: str
    value: float


@router.post("/body")
def add_body_metric(body: BodyIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    if body.type not in BODY_TYPES:
        raise HTTPException(status_code=400, detail=f"type must be one of {sorted(BODY_TYPES)}")
    if body.value <= 0:
        raise HTTPException(status_code=400, detail="value must be positive")
    db.add(Metric(user_id=user.id, type=body.type, value=round(body.value, 2),
                  unit=BODY_TYPES[body.type], ts=utcnow(), source="manual"))
    db.commit()
    return {"ok": True}


class PrefsIn(BaseModel):
    prefs: dict = {}
    units: str | None = None


@router.patch("/prefs")
def patch_prefs(body: PrefsIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    if body.prefs:
        user.prefs = {**(user.prefs or {}), **body.prefs}
    if body.units in ("kg", "lb"):
        user.units = body.units
    db.commit()
    return {"prefs": user.prefs, "units": user.units}


@router.get("/export")
def export(user: User = Depends(current_user), db: Session = Depends(get_db)):
    from ..models import MACRO_FIELDS, LoggedSet, MealLog, Record, WorkoutSession

    def rows(model, order_col):
        return db.query(model).filter(model.user_id == user.id).order_by(order_col).all()

    return {
        "user": {"email": user.email, "name": user.name, "units": user.units},
        "metrics": [{"type": m.type, "value": m.value, "unit": m.unit, "ts": m.ts.isoformat(),
                     "source": m.source} for m in rows(Metric, Metric.ts)],
        "sessions": [{"day": str(s.day), "name": s.name, "kind": s.kind, "status": s.status,
                      "stats": s.stats, "notes": s.notes, "cooldown_status": s.cooldown_status}
                     for s in rows(WorkoutSession, WorkoutSession.day)],
        "sets": [{"slug": s.exercise_slug, "substituted_for": s.substituted_for,
                  "set_no": s.set_no, "weight": s.weight, "reps": s.reps, "rpe": s.rpe,
                  "ts": s.ts.isoformat()} for s in rows(LoggedSet, LoggedSet.ts)],
        "records": [{"slug": r.exercise_slug, "kind": r.kind, "value": r.value,
                     "detail": r.detail, "achieved_on": str(r.achieved_on)}
                    for r in rows(Record, Record.achieved_on)],
        "meals": [{"day": str(m.day), "slot": m.slot, "recipe": m.recipe_slug, "label": m.label,
                   "servings": m.servings,
                   **{k: getattr(m, k) or 0 for k in MACRO_FIELDS},
                   "source": m.source, "estimated": bool(m.estimated)}
                  for m in rows(MealLog, MealLog.ts)],
    }
