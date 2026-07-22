from datetime import date, datetime, timezone
from uuid import uuid4

from sqlalchemy import (JSON, Boolean, Date, DateTime, Float, ForeignKey, Integer, LargeBinary,
                        String, Text, UniqueConstraint)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def uid() -> str:
    return uuid4().hex


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class User(Base):
    __tablename__ = "users"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(80))
    role: Mapped[str] = mapped_column(String(16), default="member")  # admin | member
    units: Mapped[str] = mapped_column(String(16), default="kg")
    prefs: Mapped[dict] = mapped_column(JSON, default=dict)  # notification toggles etc.
    active_profile_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class IngestToken(Base):
    __tablename__ = "ingest_tokens"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    token: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    samples: Mapped[int] = mapped_column(Integer, default=0)


class Metric(Base):
    __tablename__ = "metrics"
    __table_args__ = (UniqueConstraint("user_id", "type", "ts", "source", name="uq_metric_sample"),)
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    type: Mapped[str] = mapped_column(String(40), index=True)  # weight, sleep_h, resting_hr, vo2max...
    value: Mapped[float] = mapped_column(Float)
    unit: Mapped[str] = mapped_column(String(16), default="")
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    source: Mapped[str] = mapped_column(String(40), default="hae")


class Exercise(Base):
    __tablename__ = "exercises"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    slug: Mapped[str] = mapped_column(String(60), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(120))
    kind: Mapped[str] = mapped_column(String(16))  # bb | db | machine | bw | mobility
    primary_muscles: Mapped[list] = mapped_column(JSON, default=list)
    secondary_muscles: Mapped[list] = mapped_column(JSON, default=list)
    equipment: Mapped[list] = mapped_column(JSON, default=list)  # item names required
    patterns: Mapped[list] = mapped_column(JSON, default=list)  # movement patterns for niggle rules
    cues: Mapped[list] = mapped_column(JSON, default=list)
    dont: Mapped[str] = mapped_column(Text, default="")
    media_tier: Mapped[str] = mapped_column(String(16), default="images")  # images|linked|owned|wanted
    media_url: Mapped[str] = mapped_column(Text, default="")
    benefit: Mapped[str] = mapped_column(Text, default="")  # why this exercise earns its place


class EquipmentProfile(Base):
    __tablename__ = "equipment_profiles"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    user_id: Mapped[str | None] = mapped_column(ForeignKey("users.id"), nullable=True)  # null = household-shared
    name: Mapped[str] = mapped_column(String(40))
    items: Mapped[list] = mapped_column(JSON, default=list)  # [{name, available}]
    bar_kg: Mapped[float] = mapped_column(Float, default=20.0)
    plates_kg: Mapped[list] = mapped_column(JSON, default=list)  # per-side denominations
    db_max_kg: Mapped[float] = mapped_column(Float, default=30.0)


class Plan(Base):
    __tablename__ = "plans"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    domain: Mapped[str] = mapped_column(String(20), default="training")
    goal: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(16), default="active")
    revisions: Mapped[list["PlanRevision"]] = relationship(back_populates="plan", order_by="PlanRevision.num")


class PlanRevision(Base):
    __tablename__ = "plan_revisions"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    plan_id: Mapped[str] = mapped_column(ForeignKey("plans.id"), index=True)
    num: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(16), default="active")  # proposed | active | superseded
    content: Mapped[dict] = mapped_column(JSON, default=dict)  # {days:[...]}
    rationale: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    plan: Mapped[Plan] = relationship(back_populates="revisions")


class PlannedItem(Base):
    """User-authored forward planning: a workout or meal pencilled onto a
    specific calendar date, so future weeks can be sketched before the coach
    plan covers them. Separate table (not plan content) — the coach plan stays
    weekday-shaped and create_all provisions this without a migration."""
    __tablename__ = "planned_items"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    date: Mapped[date] = mapped_column(Date, index=True)
    kind: Mapped[str] = mapped_column(String(16))  # workout | meal
    title: Mapped[str] = mapped_column(String(120))
    notes: Mapped[str] = mapped_column(Text, default="")
    plan_day: Mapped[str | None] = mapped_column(String(1), nullable=True)  # weekday key "0".."6"
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class WorkoutSession(Base):
    __tablename__ = "workout_sessions"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    day: Mapped[date] = mapped_column(Date, index=True)
    name: Mapped[str] = mapped_column(String(80), default="")
    kind: Mapped[str] = mapped_column(String(16), default="strength")  # strength | cardio
    status: Mapped[str] = mapped_column(String(16), default="active")  # active | completed | unplanned
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    time_budget_min: Mapped[int | None] = mapped_column(Integer, nullable=True)
    fitted: Mapped[dict] = mapped_column(JSON, default=dict)  # snapshot: targets, cooldown list
    cooldown_status: Mapped[str] = mapped_column(String(16), default="")  # done | partial | skipped
    notes: Mapped[str] = mapped_column(Text, default="")
    favorite: Mapped[bool] = mapped_column(Boolean, default=False, index=True)  # user-starred standout
    stats: Mapped[dict] = mapped_column(JSON, default=dict)  # tonnage, duration_s, cardio stats...
    sets: Mapped[list["LoggedSet"]] = relationship(order_by="LoggedSet.ts")


class WorkoutSeries(Base):
    """Per-second-ish traces for a cardio session, kept off WorkoutSession so
    list queries never drag the blobs along. Separate table (not a column) so
    create_all provisions it without a migration."""
    __tablename__ = "workout_series"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    session_id: Mapped[str] = mapped_column(ForeignKey("workout_sessions.id"), unique=True, index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    # {"hr": [[t_s, bpm], ...], "route": [[lat, lon], ...]} — both downsampled at ingest
    data: Mapped[dict] = mapped_column(JSON, default=dict)


class LoggedSet(Base):
    __tablename__ = "logged_sets"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    session_id: Mapped[str] = mapped_column(ForeignKey("workout_sessions.id"), index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    exercise_slug: Mapped[str] = mapped_column(String(60), index=True)
    substituted_for: Mapped[str | None] = mapped_column(String(60), nullable=True)
    set_no: Mapped[int] = mapped_column(Integer)
    weight: Mapped[float] = mapped_column(Float, default=0)
    reps: Mapped[int] = mapped_column(Integer)
    rpe: Mapped[int | None] = mapped_column(Integer, nullable=True)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Record(Base):
    __tablename__ = "records"
    __table_args__ = (UniqueConstraint("user_id", "exercise_slug", "kind", name="uq_record"),)
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    exercise_slug: Mapped[str] = mapped_column(String(60))
    kind: Mapped[str] = mapped_column(String(16))  # e1rm | best_set
    value: Mapped[float] = mapped_column(Float)
    detail: Mapped[str] = mapped_column(String(80), default="")
    achieved_on: Mapped[date] = mapped_column(Date)


class Niggle(Base):
    __tablename__ = "niggles"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    body_part: Mapped[str] = mapped_column(String(60))
    severity: Mapped[str] = mapped_column(String(16), default="mild")
    status: Mapped[str] = mapped_column(String(16), default="active")  # active | watch | cleared
    note: Mapped[str] = mapped_column(Text, default="")
    avoid_patterns: Mapped[list] = mapped_column(JSON, default=list)
    mobility_slug: Mapped[str] = mapped_column(String(60), default="")  # injected into cool-downs
    opened_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    cleared_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class LabPanel(Base):
    __tablename__ = "lab_panels"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    drawn_on: Mapped[date] = mapped_column(Date)
    source: Mapped[str] = mapped_column(String(80), default="manual")
    results: Mapped[list["LabResult"]] = relationship()


class LabResult(Base):
    __tablename__ = "lab_results"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    panel_id: Mapped[str] = mapped_column(ForeignKey("lab_panels.id"), index=True)
    marker: Mapped[str] = mapped_column(String(40))
    value: Mapped[float] = mapped_column(Float)
    unit: Mapped[str] = mapped_column(String(16), default="mmol/L")
    ref_low: Mapped[float | None] = mapped_column(Float, nullable=True)
    ref_high: Mapped[float | None] = mapped_column(Float, nullable=True)


class WithingsLink(Base):
    __tablename__ = "withings_links"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), unique=True, index=True)
    withings_user_id: Mapped[str] = mapped_column(String(40), index=True)
    access_token: Mapped[str] = mapped_column(Text)
    refresh_token: Mapped[str] = mapped_column(Text)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    scope: Mapped[str] = mapped_column(String(120), default="user.metrics")
    status: Mapped[str] = mapped_column(String(20), default="ok")  # ok | refresh_failed
    linked_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    last_sync_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class PushSub(Base):
    __tablename__ = "push_subs"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    endpoint: Mapped[str] = mapped_column(Text)
    p256dh: Mapped[str] = mapped_column(Text)
    auth: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class NotificationLog(Base):
    """At-most-once ledger per (user, kind, day) — reminders can never double-fire."""
    __tablename__ = "notification_log"
    __table_args__ = (UniqueConstraint("user_id", "kind", "day", name="uq_notif_once"),)
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    kind: Mapped[str] = mapped_column(String(16))
    day: Mapped[date] = mapped_column(Date)
    sent_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class AgentRun(Base):
    __tablename__ = "agent_runs"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    kind: Mapped[str] = mapped_column(String(16))  # chat | review
    model: Mapped[str] = mapped_column(String(60), default="")
    input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, default=0)
    tool_calls: Mapped[int] = mapped_column(Integer, default=0)
    ok: Mapped[int] = mapped_column(Integer, default=1)
    note: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class ChatMessage(Base):
    __tablename__ = "chat_messages"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    who: Mapped[str] = mapped_column(String(8))  # me | coach
    text: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class AppSetting(Base):
    __tablename__ = "app_settings"
    key: Mapped[str] = mapped_column(String(40), primary_key=True)
    value: Mapped[str] = mapped_column(Text, default="")
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


# ---------- nutrition (beta track, Phase 7 — stories E16) ----------

# The full per-meal macro set, in display order. Everything that snapshots or
# totals meal macros (routes, coach tools, seeds) iterates this one tuple —
# add here + a startup ALTER in main.py to extend coverage further.
# All grams except kcal and sodium (mg).
MACRO_FIELDS = ("kcal", "protein_g", "carbs_g", "sugar_g", "fiber_g",
                "fat_g", "satfat_g", "sodium_mg")


class Recipe(Base):
    """Curated recipe library — the food twin of `exercises`. Per-serving macros
    are authored (hand-checked) at seed/import time; the `ingredients` JSON list
    joins the `ingredients` table by name for shopping/waste math (Phase 8)."""
    __tablename__ = "recipes"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    slug: Mapped[str] = mapped_column(String(60), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(120))
    kind: Mapped[str] = mapped_column(String(16), default="dinner")  # dinner | breakfast | lunch | snack
    minutes: Mapped[int] = mapped_column(Integer, default=0)
    difficulty: Mapped[str] = mapped_column(String(12), default="easy")  # easy | medium — hard ceiling
    serves: Mapped[int] = mapped_column(Integer, default=2)
    batch: Mapped[int] = mapped_column(Integer, default=0)  # extra servings boxed for a zero-cook night
    kcal: Mapped[float] = mapped_column(Float, default=0)  # per serving, canonical
    protein_g: Mapped[float] = mapped_column(Float, default=0)
    carbs_g: Mapped[float] = mapped_column(Float, default=0)
    sugar_g: Mapped[float] = mapped_column(Float, default=0)
    fiber_g: Mapped[float] = mapped_column(Float, default=0)
    fat_g: Mapped[float] = mapped_column(Float, default=0)
    satfat_g: Mapped[float] = mapped_column(Float, default=0)
    sodium_mg: Mapped[float] = mapped_column(Float, default=0)
    why: Mapped[str] = mapped_column(Text, default="")  # "why it's in your week" one-liner
    steps: Mapped[list] = mapped_column(JSON, default=list)  # [{title, minutes, detail, timer}] — done-when style
    ingredients: Mapped[list] = mapped_column(JSON, default=list)  # [{name, qty, unit, disp, note}]
    tags: Mapped[list] = mapped_column(JSON, default=list)
    platefig: Mapped[str] = mapped_column(String(32), default="plate")  # plate-art composition id
    source: Mapped[str] = mapped_column(String(24), default="seed")  # seed | bbc-good-food | card-box | import
    source_url: Mapped[str] = mapped_column(Text, default="")
    images: Mapped[list] = mapped_column(JSON, default=list)  # hero/gallery: /api/food/media/{id} paths or remote URLs
    rating: Mapped[float] = mapped_column(Float, default=0)  # source-site rating, 0–5 (0 = unrated)
    rating_count: Mapped[int] = mapped_column(Integer, default=0)
    complete: Mapped[int] = mapped_column(Integer, default=1)  # only complete entries are proposable


class Ingredient(Base):
    """Macro/aisle reference per ingredient name — per 100 g/ml, or per item when
    unit is 'x'. Pantry staples never appear on shopping lists."""
    __tablename__ = "ingredients"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    name: Mapped[str] = mapped_column(String(80), unique=True, index=True)
    aisle: Mapped[str] = mapped_column(String(24), default="cupboard")  # produce | protein | dairy | cupboard | frozen
    unit: Mapped[str] = mapped_column(String(8), default="g")  # g | ml | x
    pack: Mapped[str] = mapped_column(String(40), default="")  # typical pack, e.g. "400 g tin"
    kcal_100: Mapped[float] = mapped_column(Float, default=0)
    protein_100: Mapped[float] = mapped_column(Float, default=0)
    carbs_100: Mapped[float] = mapped_column(Float, default=0)
    sugar_100: Mapped[float] = mapped_column(Float, default=0)
    fiber_100: Mapped[float] = mapped_column(Float, default=0)
    fat_100: Mapped[float] = mapped_column(Float, default=0)
    satfat_100: Mapped[float] = mapped_column(Float, default=0)
    sodium_100: Mapped[float] = mapped_column(Float, default=0)  # mg per 100 g/ml (or per item)
    pantry: Mapped[int] = mapped_column(Integer, default=0)


class MealRevision(Base):
    """Versioned food week, mirror of plan_revisions. user_id NULL = the member
    household's shared week (dinners cook for two); the demo seat gets rows under
    its own user_id so it can never see the household's food."""
    __tablename__ = "meal_revisions"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    user_id: Mapped[str | None] = mapped_column(ForeignKey("users.id"), nullable=True, index=True)
    num: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(16), default="active")  # proposed | active | superseded
    content: Mapped[dict] = mapped_column(JSON, default=dict)  # {"days": {"0".."6": {"slots": {...}}}}
    rationale: Mapped[str] = mapped_column(Text, default="")
    changes: Mapped[list] = mapped_column(JSON, default=list)  # [{sign, what, why}] — proposal diff rows
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class MealLog(Base):
    """One row per eaten thing, macros snapshotted at log time so later recipe
    edits never rewrite history. client_id makes offline-queue retries idempotent."""
    __tablename__ = "meal_log"
    __table_args__ = (UniqueConstraint("user_id", "client_id", name="uq_meal_client"),)
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    day: Mapped[date] = mapped_column(Date, index=True)
    slot: Mapped[str] = mapped_column(String(12))  # breakfast | lunch | dinner | snack
    recipe_slug: Mapped[str] = mapped_column(String(60), default="")  # empty for off-plan estimates
    label: Mapped[str] = mapped_column(String(120), default="")
    servings: Mapped[float] = mapped_column(Float, default=1)
    kcal: Mapped[float] = mapped_column(Float, default=0)  # totals for `servings`, snapshot
    protein_g: Mapped[float] = mapped_column(Float, default=0)
    carbs_g: Mapped[float] = mapped_column(Float, default=0)
    sugar_g: Mapped[float] = mapped_column(Float, default=0)
    fiber_g: Mapped[float] = mapped_column(Float, default=0)
    fat_g: Mapped[float] = mapped_column(Float, default=0)
    satfat_g: Mapped[float] = mapped_column(Float, default=0)
    sodium_mg: Mapped[float] = mapped_column(Float, default=0)
    source: Mapped[str] = mapped_column(String(12), default="plan")  # plan | chat | order | mcp
    estimated: Mapped[int] = mapped_column(Integer, default=0)
    client_id: Mapped[str | None] = mapped_column(String(40), nullable=True)
    venue: Mapped[str] = mapped_column(String(80), default="")  # store/restaurant for eaten-out logs
    cost: Mapped[float] = mapped_column(Float, default=0)
    currency: Mapped[str] = mapped_column(String(8), default="")  # free-text code; blank = unknown
    note: Mapped[str] = mapped_column(Text, default="")
    photos: Mapped[list] = mapped_column(JSON, default=list)  # /api/food/media/{id} paths or remote URLs
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class MediaBlob(Base):
    """Food images stored on-box (no external hotlinks in the offline PWA).
    user_id NULL = household-visible (recipe imagery, shared like the recipe
    library); a user id = that user's meal photos, never served to anyone else.
    Small and capped at ingest (3 MB, image/* only) — fine in Postgres for two
    seats, and it needs no new Docker volume."""
    __tablename__ = "media_blobs"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    user_id: Mapped[str | None] = mapped_column(ForeignKey("users.id"), nullable=True, index=True)
    mime: Mapped[str] = mapped_column(String(40), default="image/jpeg")
    data: Mapped[bytes] = mapped_column(LargeBinary)
    src_url: Mapped[str] = mapped_column(Text, default="")  # where it was fetched from, if a URL
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Carryover(Base):
    """What a week's shop leaves behind (E16.5). Household-scoped like the food
    week (user_id NULL for members, demo's id for demo). Wired up in Phase 8;
    the table ships in Phase 7 so create_all provisions it once."""
    __tablename__ = "carryovers"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    user_id: Mapped[str | None] = mapped_column(ForeignKey("users.id"), nullable=True, index=True)
    week_start: Mapped[date] = mapped_column(Date, index=True)
    item: Mapped[str] = mapped_column(String(80))
    qty: Mapped[str] = mapped_column(String(40), default="")  # human amount: "½ bag", "⅔ jar"
    use_by: Mapped[date | None] = mapped_column(Date, nullable=True)
    status: Mapped[str] = mapped_column(String(12), default="open")  # open | kept | binned | consumed


class LunchFavorite(Base):
    """Vetted repeat orders (E16.7, wired in Phase 9). Strictly per-user."""
    __tablename__ = "lunch_favorites"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    vendor: Mapped[str] = mapped_column(String(20), default="other")  # mealpal | grubhub | other
    item: Mapped[str] = mapped_column(String(120))
    price: Mapped[float] = mapped_column(Float, default=0)
    kcal: Mapped[float] = mapped_column(Float, default=0)
    protein_g: Mapped[float] = mapped_column(Float, default=0)
    carbs_g: Mapped[float] = mapped_column(Float, default=0)
    sugar_g: Mapped[float] = mapped_column(Float, default=0)
    fiber_g: Mapped[float] = mapped_column(Float, default=0)
    fat_g: Mapped[float] = mapped_column(Float, default=0)
    satfat_g: Mapped[float] = mapped_column(Float, default=0)
    sodium_mg: Mapped[float] = mapped_column(Float, default=0)
    notes: Mapped[str] = mapped_column(Text, default="")
    last_ordered: Mapped[date | None] = mapped_column(Date, nullable=True)
