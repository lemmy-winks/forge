/* Typed-ish API client. The FastAPI server is the source of truth for shapes;
   types here are practical mirrors, loose where the payload is polymorphic. */

export class ApiError extends Error {
  status?: number;
  network?: boolean;
  constructor(msg: string, opts: { status?: number; network?: boolean } = {}) {
    super(msg);
    this.status = opts.status;
    this.network = opts.network;
  }
}

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void) { onUnauthorized = fn; }

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  let resp: Response;
  try {
    resp = await fetch(path, {
      method: opts.method || 'GET',
      headers: opts.body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError('network', { network: true });
  }
  if (resp.status === 401 && !path.startsWith('/auth')) {
    onUnauthorized?.();
    throw new ApiError('unauthorized', { status: 401 });
  }
  if (!resp.ok) {
    let detail = resp.statusText;
    try { detail = (await resp.json()).detail || detail; } catch { /* keep statusText */ }
    throw new ApiError(detail, { status: resp.status });
  }
  return resp.json();
}

/* ---------- shapes ---------- */
export interface Me { id: string; email: string; name: string; role: string; units: string; prefs: Record<string, any>; }

/** Bodyweight display respecting the user's units preference. */
export function kgDisp(kg: number, units: string): string {
  return units === 'lb' ? (kg * 2.20462).toFixed(1) + ' lb' : kg.toFixed(1) + ' kg';
}

/* ---------- unit layer ----------
   Storage is always canonical (kg / cm / mmol-L); these convert at the edge. */
export type LoadUnit = 'kg' | 'lb';
export const KG_PER_LB = 0.45359237;

/** Display unit for a lift: per-exercise override → global default → lb. */
export function loadUnitFor(prefs: Record<string, any> | undefined, slug?: string): LoadUnit {
  const o = slug ? prefs?.load_units?.[slug] : undefined;
  if (o === 'kg' || o === 'lb') return o;
  return prefs?.unit_load === 'kg' ? 'kg' : 'lb';
}
export function kgToDisp(kg: number, u: LoadUnit): number {
  return u === 'lb' ? +(kg / KG_PER_LB).toFixed(1) : kg;
}
export function dispToKg(v: number, u: LoadUnit): number {
  return u === 'lb' ? +(v * KG_PER_LB).toFixed(2) : v;
}
export function fmtLoad(kg: number, u: LoadUnit): string {
  return `${kgToDisp(kg, u)} ${u}`;
}
/** Stepper increment in *display* units: 5/2.5 lb, 2.5/2 kg (bb/db). */
export function loadStep(u: LoadUnit, kind?: string): number {
  if (u === 'lb') return kind === 'db' ? 2.5 : 5;
  return kind === 'db' ? 2 : 2.5;
}

export function heightDisp(cm: number, u: string): string {
  if (u === 'ftin') {
    const inch = cm / 2.54;
    const ft = Math.floor(inch / 12);
    return `${ft}′ ${Math.round(inch - ft * 12)}″`;
  }
  return `${Math.round(cm)} cm`;
}

/** mmol/L ↔ mg/dL. Cholesterol ×38.67; triglycerides ×88.57. */
export const LIPID_FACTOR: Record<string, number> = {
  LDL: 38.67, HDL: 38.67, Total: 38.67, Triglycerides: 88.57,
};
export function lipidDisp(marker: string, mmol: number, u: string): string {
  return u === 'mgdl'
    ? `${Math.round(mmol * (LIPID_FACTOR[marker] ?? 38.67))} mg/dL`
    : `${mmol} mmol/L`;
}
export function lipidToMmol(marker: string, v: number, u: string): number {
  return u === 'mgdl' ? +(v / (LIPID_FACTOR[marker] ?? 38.67)).toFixed(2) : v;
}
export function lipidRefDisp(marker: string, mmol: number | null, u: string): number | null {
  if (mmol == null) return null;
  return u === 'mgdl' ? Math.round(mmol * (LIPID_FACTOR[marker] ?? 38.67)) : mmol;
}
export interface AuthMode { google: boolean; dev: boolean; demo: boolean; users: { email: string; name: string }[]; }

export interface LastTime { weight: number; reps: number[]; rpe: number[]; when: string; }
export interface TodayExercise {
  slug: string; name: string; kind: string; sets: number; base_sets: number; reps: number;
  weight: number; rest: number; priority: number; dropped: boolean; note: string;
  last: LastTime | null; plate?: string; warmups?: { weight: number; reps: number }[] | null;
}
export interface CooldownItem { slug: string; name?: string; hold?: string; why?: string; }
export interface Profile { name: string; bar_kg: number; plates_kg: number[]; }
export interface Today {
  date: string; day_name: string; rationale: string; kind: 'rest' | 'cardio' | 'strength';
  name?: string; focus?: string[];
  session: { id: string; status: string; stats: any; cooldown_status: string } | null;
  // strength
  budget?: number | null; est?: number; cd?: 'full' | 'short'; trims?: string[]; full_est?: number;
  exercises?: TodayExercise[]; cooldown?: CooldownItem[]; profile?: Profile | null; tonnage_est?: number;
  muscles?: { primary: string[]; secondary: string[] };
  // cardio
  cardio?: { type: string; minutes: number; hr_low: number; hr_high: number; note?: string };
  // rest
  recovery?: { sleep_h: MetricPoint | null; weight: MetricPoint | null; resting_hr: MetricPoint | null };
  tomorrow?: { day_name: string; name: string; kind: string } | null;
}
export interface MetricPoint { value: number; unit: string; ts: string; }

export interface FittedTarget { slug: string; name?: string; kind?: string; sets: number; reps: number;
  weight: number; rest: number; priority: number; }
export interface Fitted { name: string; budget: number | null; est: number; cd: 'full' | 'short';
  targets: FittedTarget[]; cooldown: CooldownItem[]; }
export interface StartSessionResp { id: string; fitted: Fitted; resumed: boolean; }
export interface Pb { kind: string; slug: string; value: number; detail: string; }

export interface HistoryItem { id: string; day: string; name: string; kind: string; status: string; stats: any; favorite?: boolean; }
export interface SessionDetail {
  id: string; day: string; name: string; kind: string; status: string; stats: any; notes: string;
  favorite?: boolean;
  cooldown_status: string; fitted: Fitted | Record<string, never>;
  exercises: { slug: string; name: string; substituted_for: string | null;
    sets: { set_no: number; weight: number; reps: number; rpe: number | null }[] }[];
  series?: { hr?: [number, number][]; route?: [number, number][] };
  zones?: { hr_max: number; estimated: boolean;
    zones: { zone: number; low: number; high: number | null; min: number }[] };
}
export interface SeriesPoint { d: string; v: number; }
export interface BodyComp {
  fat_pct: SeriesPoint[]; muscle: SeriesPoint[]; bone: SeriesPoint[];
  water_pct: SeriesPoint[]; height_cm: number | null;
}
export interface Progress {
  e1rm: Record<string, { name: string; points: SeriesPoint[] }>;
  weight: SeriesPoint[]; vo2max: SeriesPoint[]; vo2max_smooth: SeriesPoint[];
  resting_hr: SeriesPoint[]; sleep_h: SeriesPoint[];
  zone2: { done: number; target: number };
  bodycomp: BodyComp;
  week: { done: number; planned: number };
}
export interface Dashboard {
  name: string; units: string;
  unit_load: LoadUnit; unit_lipids: string; load_units?: Record<string, LoadUnit>;
  bodycomp: BodyComp;
  e1rm: Record<string, { name: string; points: SeriesPoint[] }>;
  weight: SeriesPoint[]; goal_weight_kg: number | null;
  vo2max: SeriesPoint[]; vo2max_smooth: SeriesPoint[];
  resting_hr: SeriesPoint[]; sleep_h: SeriesPoint[];
  tonnage_weekly: { week: string; v: number }[];
  zone2_weekly: { week: string; v: number }[]; zone2_target: number;
  heatmap: { week: string; days: { d: string; s: 'done' | 'missed' | 'off' | 'future' }[] }[];
  lipids: Record<string, { d: string; v: number; ref_low: number | null; ref_high: number | null }[]>;
  week: { done: number; planned: number };
  records: RecordRow[];
}
export interface RecordRow { slug: string; name: string; kind: string; value: number; detail: string; achieved_on: string; }
export interface ExerciseDetail {
  slug: string; name: string; kind: string; primary_muscles: string[]; secondary_muscles: string[];
  equipment: string[]; cues: string[]; dont: string; patterns: string[]; benefit: string;
  media_tier: string; media_url: string;
}
export interface Alternative { slug: string; name: string; kind?: string; excluded: boolean; why: string; }
export interface EquipmentData {
  active_id: string | null;
  profiles: { id: string; name: string; shared: boolean; items: { name: string; available: boolean }[];
    bar_kg: number; plates_kg: number[]; db_max_kg: number }[];
}
export interface NiggleRow { id: string; body_part: string; severity: string; status: string; note: string;
  avoid_patterns: string[]; opened_at: string | null; cleared_at: string | null; }
export interface LabPanelRow { id: string; drawn_on: string; source: string;
  results: { marker: string; value: number; unit: string; ref_low: number | null; ref_high: number | null }[]; }
export interface ChatMsg { who: 'me' | 'coach'; text: string; at?: string; }
export interface ChatResp { messages: ChatMsg[]; pending: boolean; }
/** Deep-link context: what the user was looking at when they opened the coach. */
export interface ChatContext { kind: 'session' | 'exercise' | 'proposal'; id?: string; label: string; }
/** A workout or meal the user pencilled onto a specific (usually future) date. */
export interface PlannedItem {
  id: string; date: string; kind: 'workout' | 'meal'; title: string; notes: string;
  plan_day: string | null;
}
export interface WeekDay {
  date: string; day_name: string; is_today: boolean;
  kind: 'strength' | 'cardio' | 'rest'; name: string | null; focus: string[];
  est?: number; exercise_count?: number; minutes?: number;
  session: { id: string; kind: string; status: string; stats: any; name: string } | null;
  planned: PlannedItem[];
}
export interface WeekResp {
  start: string; today: string; rationale: string; days: WeekDay[];
  dangling: { id: string; date: string; day_name: string; name: string; sets_done: number } | null;
}

export interface ProposalDay {
  name: string; kind: 'strength' | 'cardio'; focus?: string[]; why?: string;
  exercises?: { slug: string; sets: number; reps: number; weight?: number }[];
  cardio?: { minutes?: number; hr_low?: number; hr_high?: number };
}
export interface ProposalChange { sign: '+' | '-' | '~'; what: string; why?: string; }
export interface ProposalResp {
  proposal: { id: string; num: number; rationale: string; created_at: string;
    content: { days: Record<string, ProposalDay>; changes?: ProposalChange[] } } | null;
}
/* ---------- nutrition (beta track, Phase 7) ---------- */
/** The full per-meal macro set (matches server models.MACRO_FIELDS). Grams,
 *  except kcal and sodium (mg). */
export interface Macros {
  kcal: number; protein_g: number; carbs_g: number; sugar_g: number;
  fiber_g: number; fat_g: number; satfat_g: number; sodium_mg: number;
}
export const MACRO_KEYS = ['kcal', 'protein_g', 'carbs_g', 'sugar_g',
  'fiber_g', 'fat_g', 'satfat_g', 'sodium_mg'] as const satisfies readonly (keyof Macros)[];
export type NutritionTargets = Macros;
export interface RecipeCard extends Macros {
  slug: string; name: string; kind: string; minutes: number; difficulty: string;
  serves: number; batch: number; platefig: string; why: string;
  image?: string | null; rating?: number;  // imported recipes only (MCP)
}
export interface FoodSlot {
  slot: 'breakfast' | 'lunch' | 'dinner' | 'snack';
  logged: boolean; log_id: string | null; why?: string;
  recipe?: RecipeCard; order?: boolean; out?: boolean; leftover?: boolean; note?: string;
}
export interface FoodExtra extends Macros {
  id: string; slot: string; label: string; estimated: boolean;
  // eaten-out context (logged via MCP or order logs)
  venue: string; cost: number; currency: string; note: string; photos: string[];
}
export interface FoodDay {
  date: string; day_name: string; is_today: boolean;
  slots: FoodSlot[]; extras: FoodExtra[];
  totals: Macros;
}
export interface FoodWeek {
  start: string; today: string; days: FoodDay[]; targets: NutritionTargets;
  rationale: string; has_plan: boolean;
}
/** One planned slot inside a food proposal's raw content (Phase 8). */
export interface FoodPropSlot {
  recipe?: string; why?: string; note?: string;
  order?: boolean; out?: boolean; leftover_of?: string | number;
}
export interface FoodProposalResp {
  proposal: {
    id: string; num: number; rationale: string; created_at: string;
    changes: ProposalChange[];
    content: { days: Record<string, { slots: Record<string, FoodPropSlot> }> };
    recipes: Record<string, RecipeCard>;
  } | null;
}
export interface RecipeStep {
  title: string; minutes?: number; detail: string; timer?: boolean; image?: string;
  /** background step: start its timer and carry on with later steps in parallel */
  parallel?: boolean;
}
export interface RecipeIngredient {
  name: string; qty: number; unit: string; disp: string; note?: string; aisle: string; pantry: boolean;
}
export interface RecipeFull extends RecipeCard {
  steps: RecipeStep[]; ingredients: RecipeIngredient[]; tags: string[];
  source: string; source_url: string;
  images: string[]; rating: number; rating_count: number;
}
/** One row of the library browser (GET /api/food/recipes). `complete: false`
 *  = parked import — browsable, never proposed by the coach. */
export interface RecipeListItem extends RecipeCard {
  tags: string[]; source: string; complete: boolean;
}
export interface RecipeList { count: number; recipes: RecipeListItem[]; }
/** Full-history series for one body/engine metric (Progress drill-down). */
export interface MetricHistory { type: string; unit: string; points: SeriesPoint[]; }

export interface Connections {
  apple_health: { configured: boolean; token_masked: string | null; last_push: string | null;
    samples: number; endpoint: string };
  withings: { configured: boolean; linked: boolean; status: string | null;
    last_sync: string | null; warning: string | null; note: string };
  coach_mcp: { active: boolean; note: string };
  mcp_clients: { id: string; name: string; connected_at: string; last_used_at: string | null }[];
}

/* ---------- web push ---------- */
function b64ToUint8(b64: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Ask permission, subscribe with the server's VAPID key, register server-side.
    Returns a status string for the UI. */
export async function enablePush(): Promise<string> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return 'Push needs the installed PWA (Add to Home Screen first on iOS)';
  }
  const cfg = await api<{ enabled: boolean; public_key: string }>('/api/push/config');
  if (!cfg.enabled) return 'Push not configured on the server yet (VAPID keys)';
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return 'Notifications were blocked — allow them in Settings';
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: b64ToUint8(cfg.public_key),
  });
  const json = sub.toJSON();
  await api('/api/push/subscribe', { method: 'POST',
    body: { endpoint: sub.endpoint, keys: json.keys || {} } });
  return 'ok';
}

/* ---------- timed (isometric / carry) exercises ---------- */
/** Reps for these are SECONDS held, not repetitions — the UI shows a hold
    timer and speaks in seconds. Matched on slug or name so coach-added
    exercises (e.g. "Copenhagen Plank") classify without a library flag. */
export function isTimed(slugOrName: string): boolean {
  return /plank|hold|carry|wall.?sit|dead.?hang|farmer/i.test(slugOrName);
}

/* ---------- client-side helpers mirrored from server fitting ---------- */
/** Single-implement dumbbell moves where "2 × w" would mislead. */
const ONE_DB_BOTH_HANDS = /goblet|kettlebell|overhead-triceps/;
const ONE_HAND = /one-arm|single-arm|db-row|suitcase/;

export function plateStr(kind: string, weight: number, profile?: Profile | null,
                         unit: LoadUnit = 'kg', slug = ''): string {
  if (kind === 'db') {
    if (!weight) return '';
    const w = fmtLoad(weight, unit);
    if (ONE_HAND.test(slug)) return `${w} in one hand — work each side in turn`;
    if (ONE_DB_BOTH_HANDS.test(slug)) return `One ${w} — held with both hands`;
    return `2 × ${w} — one per hand`;
  }
  if (kind !== 'bb' || !profile || !profile.plates_kg?.length) return '';
  let per = (weight - profile.bar_kg) / 2;
  if (per < 0.01) return `Empty bar (${profile.bar_kg} kg)`;
  const out: number[] = [];
  for (const p of [...profile.plates_kg].sort((a, b) => b - a)) {
    while (per >= p - 1e-9) { out.push(p); per -= p; }
  }
  let txt = 'Per side: ' + out.join(' + ');
  if (per > 0.01) txt += ` — no plate for ${per.toFixed(2)} kg`;
  return txt;
}

export function fmtT(s: number): string {
  return Math.floor(s / 60) + ':' + String(Math.max(0, s % 60)).padStart(2, '0');
}
/** Seconds → wall-clock length: "42 min" / "1h 24m". For workout durations —
 *  fmtT stays mm:ss for live timers and holds. */
export function fmtDur(s: number): string {
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}
export function addDaysISO(iso: string, days: number): string {
  return new Date(new Date(iso + 'T12:00:00Z').getTime() + days * 86400000).toISOString().slice(0, 10);
}
/** Monday of the week containing the given ISO date — mirrors the server's
 *  Mon–Sun alignment of /api/week and /api/food/week. */
export function weekStartISO(iso: string): string {
  return addDaysISO(iso, -((new Date(iso + 'T12:00:00Z').getUTCDay() + 6) % 7));
}
/** Today as the user's LOCAL date — toISOString alone is the UTC date, which is
 *  still yesterday for the first hour after midnight during BST. */
export const todayISO = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};
