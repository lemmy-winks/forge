import asyncio
import logging
import os
import time
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from sqlalchemy.exc import OperationalError
from starlette.middleware.sessions import SessionMiddleware

from . import models  # noqa: F401  (register tables)
from .config import apply_overrides, get_settings
from .db import Base, SessionLocal, engine
from .notify import push_enabled, send_push
from .routers import admin, auth, coach_api, food, ingest, mcp_food, misc, push, training, withings
from .seed import run_seed

# uvicorn only configures its own loggers — without this, forge.* INFO logs
# (coach runs, ingest, scheduler) never reach the container output at all.
logging.basicConfig(level=os.environ.get("FORGE_LOG_LEVEL", "INFO"),
                    format="%(levelname)s:%(name)s: %(message)s")
log = logging.getLogger("forge")


def _reviews_due() -> list[str]:
    """User ids whose weekly review should run now (Sunday evening, once per ISO week)."""
    settings = get_settings()
    if not settings.anthropic_api_key:
        return []
    now = datetime.now(ZoneInfo(settings.coach_tz))
    if now.weekday() != settings.review_weekday or now.hour < settings.review_hour:
        return []
    week = now.isocalendar()[:2]
    due: list[str] = []
    db = SessionLocal()
    try:
        for user in db.query(models.User).filter(models.User.role != "demo").all():
            done = any(
                r.created_at.astimezone(ZoneInfo(settings.coach_tz)).isocalendar()[:2] == week
                for r in db.query(models.AgentRun)
                .filter(models.AgentRun.user_id == user.id, models.AgentRun.kind == "review",
                        models.AgentRun.ok == 1)
            )
            if not done:
                due.append(user.id)
    finally:
        db.close()
    return due


def _run_review_for(user_id: str) -> None:
    from .coach import run_review
    db = SessionLocal()
    try:
        user = db.get(models.User, user_id)
        if user:
            run_review(db, user)
            log.info("weekly review completed for %s", user.email)
            try:  # proposal-ready push (E12.1) — best-effort, never fails the review
                send_push(db, user, "proposal", "Your week is ready",
                          "The coach reviewed your week — next week's plan is waiting for your OK.")
            except Exception:
                log.exception("proposal push failed for %s", user.email)
    except Exception:
        log.exception("weekly review failed for user %s", user_id)
    finally:
        db.close()


def _send_due_reminders() -> None:
    """Planned-day reminder (E12.1): fires once per planned day, inside the
    allowed window (reminder_hour..quiet_end), only if nothing is logged yet."""
    settings = get_settings()
    if not push_enabled():
        return
    now = datetime.now(ZoneInfo(settings.coach_tz))
    if not (settings.reminder_hour <= now.hour < settings.quiet_end):
        return
    today = now.date()
    db = SessionLocal()
    try:
        for user in db.query(models.User).filter(models.User.role != "demo").all():
            rev = (db.query(models.PlanRevision).join(models.Plan)
                   .filter(models.Plan.user_id == user.id, models.Plan.domain == "training",
                           models.PlanRevision.status == "active")
                   .order_by(models.PlanRevision.num.desc()).first())
            entry = (((rev.content or {}).get("days", {}) or {}) if rev else {}).get(str(today.weekday()))
            if not entry:
                continue
            logged = (db.query(models.WorkoutSession.id)
                      .filter(models.WorkoutSession.user_id == user.id,
                              models.WorkoutSession.day == today).first())
            if logged:
                continue
            already = (db.query(models.NotificationLog.id)
                       .filter(models.NotificationLog.user_id == user.id,
                               models.NotificationLog.kind == "reminder",
                               models.NotificationLog.day == today).first())
            if already:
                continue
            # Ledger row first — the unique constraint makes double-fire impossible.
            db.add(models.NotificationLog(user_id=user.id, kind="reminder", day=today))
            db.commit()
            name = entry.get("name") or ("cardio" if entry.get("kind") == "cardio" else "training")
            send_push(db, user, "reminder", f"Planned today: {name}",
                      "You planned to train today — still time to get it in.")
    except Exception:
        log.exception("reminder tick failed")
    finally:
        db.close()


async def _review_scheduler():
    while True:
        try:
            for uid in _reviews_due():
                await asyncio.to_thread(_run_review_for, uid)
            await asyncio.to_thread(_send_due_reminders)
        except Exception:
            log.exception("review scheduler tick failed")
        await asyncio.sleep(600)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Postgres may come up a beat after us, even with compose healthchecks.
    for attempt in range(30):
        try:
            Base.metadata.create_all(engine)
            break
        except OperationalError:
            if attempt == 29:
                raise
            time.sleep(1)
    # create_all never alters existing tables (no Alembic yet) — tiny additive migrations here.
    from sqlalchemy import inspect, text

    def _add_missing_columns(table: str, columns: dict[str, str]) -> None:
        have = {c["name"] for c in inspect(engine).get_columns(table)}
        for col, ddl in columns.items():
            if col not in have:
                with engine.begin() as conn:
                    conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {col} {ddl}"))

    _add_missing_columns("exercises", {"benefit": "TEXT DEFAULT ''"})
    # full macro set on the food tables (carbs/sugar/fat/sodium joined the trio)
    _new_macros = {c: "FLOAT DEFAULT 0" for c in ("carbs_g", "sugar_g", "fat_g", "sodium_mg")}
    _add_missing_columns("recipes", {"sugar_g": "FLOAT DEFAULT 0", "sodium_mg": "FLOAT DEFAULT 0"})
    _add_missing_columns("ingredients",
                         {c: "FLOAT DEFAULT 0" for c in ("carbs_100", "sugar_100", "fat_100", "sodium_100")})
    _add_missing_columns("meal_log", _new_macros)
    _add_missing_columns("lunch_favorites", _new_macros)
    # MCP food import surface: eaten-out details on logs, imagery/ratings on recipes
    _add_missing_columns("meal_log", {"venue": "VARCHAR(80) DEFAULT ''", "cost": "FLOAT DEFAULT 0",
                                      "currency": "VARCHAR(8) DEFAULT ''", "note": "TEXT DEFAULT ''",
                                      "photos": "JSON DEFAULT '[]'"})
    _add_missing_columns("recipes", {"images": "JSON DEFAULT '[]'", "rating": "FLOAT DEFAULT 0",
                                     "rating_count": "INTEGER DEFAULT 0"})
    # scrub artefacts of the old agent loop that could end a run with no message
    with engine.begin() as conn:
        conn.execute(text("DELETE FROM chat_messages WHERE text = '(no reply)'"))
    db = SessionLocal()
    try:
        run_seed(db)
        apply_overrides(db)  # app-managed settings (Settings → Server) beat the env
    finally:
        db.close()
    task = asyncio.create_task(_review_scheduler())
    yield
    task.cancel()


app = FastAPI(title="Forge", version="0.1.0", lifespan=lifespan)
app.add_middleware(SessionMiddleware, secret_key=get_settings().session_secret, same_site="lax")


@app.get("/healthz")
def healthz():
    return {"ok": True, "build": _build_id()}


def _build_id() -> str:
    try:  # written by the Dockerfile; absent in dev/tests
        return (Path(__file__).resolve().parent.parent / "build_id").read_text().strip()
    except OSError:
        return "dev"


app.include_router(admin.router)
app.include_router(auth.router)
app.include_router(ingest.router)
app.include_router(training.router)
app.include_router(misc.router)
app.include_router(coach_api.router)
app.include_router(withings.router)
app.include_router(push.router)
app.include_router(food.router)
app.include_router(mcp_food.router)

# Serve the frontend: the built React app when available (web/dist locally, or
# copied to ./static in the Docker image); the legacy vanilla client otherwise.
_server_dir = Path(__file__).resolve().parent.parent
_candidates = [
    _server_dir.parent / "web" / "dist",  # local checkout after `npm run build`
    _server_dir / "static",               # Docker image / fallback
]
_static = next((p for p in _candidates if (p / "index.html").exists()), _candidates[-1])


@app.get("/dashboard")
def dashboard_page():
    # SPA route: the desktop dashboard lives at /dashboard but is the same bundle.
    from fastapi.responses import FileResponse
    return FileResponse(str(_static / "index.html"))


app.mount("/", StaticFiles(directory=str(_static), html=True), name="static")
