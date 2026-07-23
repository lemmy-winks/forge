/* Food tab (beta track, Phase 7): day view (meters + one-tap tick rows),
   week menu, recipe detail, and cook mode. Plate-first layout — the
   cholesterol trio leads. Ticks queue in localStorage when offline and
   replay idempotently via client_id (uq_meal_client server-side). */

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import {
  addDaysISO, api, ApiError, fmtT, MACRO_KEYS, todayISO, weekStartISO,
  type FoodDay, type FoodProposalResp, type FoodPropSlot, type FoodSlot, type FoodWeek,
  type Macros, type RecipeFull, type RecipeIngredient, type RecipeList,
} from '../api';
import { PlateFig } from '../platefig';
import { Back, Chip, Loading, Shell, Title, toast, useApp } from '../ui';

/* ---------------- offline tick queue ---------------- */
const QKEY = 'forge-food-queue';
interface QueuedTick { date: string; slot: string; recipe: string; client_id: string; }
const readQueue = (): QueuedTick[] => JSON.parse(localStorage.getItem(QKEY) || '[]');
const writeQueue = (q: QueuedTick[]) => localStorage.setItem(QKEY, JSON.stringify(q));

export async function flushFoodQueue(onDone?: (n: number) => void) {
  const q = readQueue();
  if (!q.length) return;
  let sent = 0;
  let i = 0;
  for (; i < q.length; i++) {
    try {
      await api('/api/food/log', { method: 'POST', body: q[i] });
      sent++;
    } catch (e) {
      if (e instanceof ApiError && e.network) break; // still offline — keep q[i..] queued
      // non-network error (e.g. recipe gone): drop it rather than loop forever
    }
  }
  writeQueue(q.slice(i));
  if (sent) onDone?.(sent);
}

/* ---------------- data ---------------- */
/** The Mon–Sun food week containing `weekStart` (a Monday ISO; null/undefined
 *  = the current week). */
export function useFoodWeek(weekStart?: string | null) {
  return useQuery<FoodWeek>({
    queryKey: ['foodweek', weekStart || 'current'],
    queryFn: () => api('/api/food/week' + (weekStart ? `?date=${weekStart}` : '')),
    placeholderData: keepPreviousData,
  });
}

export function useFoodProposal() {
  return useQuery<FoodProposalResp>({
    queryKey: ['foodproposal'], queryFn: () => api('/api/food/proposal'),
  });
}

const SLOT_LABEL: Record<string, string> = {
  breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner', snack: 'Snack',
};

/** Compact one-line macros for the dense meal rows: "520 · P42 C48 F13". */
const macroBrief = (m: Macros) =>
  `${Math.round(m.kcal)} · P${Math.round(m.protein_g)} C${Math.round(m.carbs_g)} F${Math.round(m.fat_g)}`;

/* ---------------- food week proposal (Phase 8, E16.3) ---------------- */
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function FoodProposalBanner({ onOpen }: { onOpen: () => void }) {
  const q = useFoodProposal();
  if (!q.data?.proposal) return null;
  return (
    <button className="propbanner press" onClick={onOpen}>
      <span className="pulse" />
      <b>Next food week proposed — awaiting your OK</b>
      <span style={{ color: 'var(--volt)', fontWeight: 700, fontSize: 13 }}>Review ›</span>
    </button>
  );
}

export function FoodProposalCard({ onDecided }: { onDecided?: () => void }) {
  const qc = useQueryClient();
  const { openTab } = useApp();
  const q = useFoodProposal();
  const [noteOpen, setNoteOpen] = useState(false);
  const [daysOpen, setDaysOpen] = useState(false);
  const p = q.data?.proposal;
  const decide = useMutation({
    mutationFn: (arg: { id: string; verb: 'approve' | 'reject' }) =>
      api(`/api/food/proposal/${arg.id}/${arg.verb}`, { method: 'POST' }),
    onSuccess: (_d, arg) => {
      toast(arg.verb === 'approve' ? 'Food week approved — live now' : 'Proposal dismissed',
        arg.verb === 'approve');
      qc.invalidateQueries({ queryKey: ['foodproposal'] });
      qc.invalidateQueries({ queryKey: ['foodweek'] });
      onDecided?.();
    },
  });
  if (!p) return null;
  const proposedOn = new Date(p.created_at);
  const signColor = (s: string) => s === '+' ? 'var(--volt)' : s === '-' ? 'var(--warn)' : 'var(--mut)';

  const dinnerLine = (slots: Record<string, FoodPropSlot>): { name: string; why: string } => {
    const d = slots.dinner || {};
    if (d.out) return { name: 'Night out', why: d.note || '' };
    if (d.leftover_of !== undefined) {
      const src = p.content.days[String(d.leftover_of)]?.slots?.dinner?.recipe;
      const r = src ? p.recipes[src] : undefined;
      return { name: r ? `${r.name} · leftovers` : 'Leftovers', why: d.why || 'zero-cook night' };
    }
    const r = d.recipe ? p.recipes[d.recipe] : undefined;
    return { name: r?.name || d.recipe || '—', why: d.why || '' };
  };

  return (
    <div>
      <div className="kick" style={{ fontSize: 11 }}>
        Proposed {proposedOn.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}
        {' · '}food week #{p.num} · awaiting your OK
      </div>

      <div style={{ margin: '8px 0' }}>
        {p.changes.map((c, i) => (
          <div key={i} style={{ display: 'flex', gap: 9, padding: '5px 0', fontSize: 14,
            borderTop: i ? '1px solid var(--hair)' : 'none' }} className="num">
            <b style={{ color: signColor(c.sign), width: 12, flex: 'none', textAlign: 'center' }}>{c.sign}</b>
            <b style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{c.what}</b>
            {c.why && <span style={{ fontSize: 12, color: 'var(--mut)', textAlign: 'right', maxWidth: '46%' }}>{c.why}</span>}
          </div>
        ))}
      </div>

      {p.rationale && (
        <button className="coachnote press" onClick={() => setNoteOpen(!noteOpen)}
          style={{ marginBottom: 10 }}>
          <div className={noteOpen ? '' : 'clamp'}>{p.rationale}</div>
          <div className="more">{noteOpen ? 'less' : 'more'}</div>
        </button>
      )}

      <div className="btnrow">
        <button className="cta press" style={{ padding: 11 }} disabled={decide.isPending}
          onClick={() => decide.mutate({ id: p.id, verb: 'approve' })}>Approve food week</button>
        <button className="ghost press" style={{ flex: '0 0 auto', width: 'auto', padding: '11px 14px' }}
          onClick={() => { onDecided?.(); openTab('coach'); }}>Changes…</button>
      </div>

      <button className="coachnote press" style={{ marginTop: 10 }} onClick={() => setDaysOpen(!daysOpen)}>
        <div className="more">{daysOpen ? 'hide the dinners' : 'dinner by dinner · 7 days'}</div>
      </button>
      {daysOpen && Object.entries(p.content.days).sort(([a], [b]) => +a - +b).map(([k, day]) => {
        const din = dinnerLine(day.slots || {});
        return (
          <div key={k} style={{ borderTop: '1px solid var(--hair)', padding: '6px 0' }}>
            <div className="row">
              <span style={{ fontSize: 14.5, fontWeight: 600 }}>{DAY_NAMES[+k]} · {din.name}</span>
            </div>
            {din.why && <div className="sub" style={{ margin: 0 }}>{din.why}</div>}
          </div>
        );
      })}
      <button className="press" style={{ width: '100%', textAlign: 'center', fontSize: 13,
        color: 'var(--mut)', marginTop: 8 }} disabled={decide.isPending}
        onClick={() => decide.mutate({ id: p.id, verb: 'reject' })}>
        Dismiss this proposal
      </button>
    </div>
  );
}

function slotName(s: FoodSlot): string {
  if (s.out) return 'Night out — enjoy it';
  if (s.order) return 'Order out — coach-assisted';
  if (s.recipe) return s.leftover ? `${s.recipe.name} · leftovers` : s.recipe.name;
  if (s.label) return s.label;  // logged off-plan meal that replaced the plan
  return s.note || 'Unplanned';
}

/* ---------------- macro cells (compact grid) ---------------- */
function MacroCell({ label, val, target, cap }:
  { label: string; val: number; target: number; cap?: boolean }) {
  const pct = Math.min(100, Math.round((val / Math.max(target, 1)) * 100));
  const over = cap && val > target;
  return (
    <div className="mcell">
      <div className="mcl">{label}</div>
      <div className="mcv num"><b className={over ? 'warn' : ''}>{Math.round(val)}</b>
        <span>/{cap ? '≤' : ''}{target}</span></div>
      <div className="mtrack"><i style={{ width: pct + '%', background: over ? 'var(--warn)' : undefined }} /></div>
    </div>
  );
}

/* ---------------- day view (the Food tab home) ---------------- */
export function FoodDayScreen() {
  const { go, openTab, foodDate } = useApp();
  const qc = useQueryClient();
  // fetch the week containing the viewed date, so days from a paged week open too
  const rawStart = foodDate ? weekStartISO(foodDate) : null;
  const wkStart = rawStart === weekStartISO(todayISO()) ? null : rawStart;
  const wq = useFoodWeek(wkStart);
  const [propOpen, setPropOpen] = useState(false);
  const w = wq.data;
  if (!w) return <Shell><Loading /></Shell>;

  const day: FoodDay | undefined =
    (foodDate ? w.days.find((d) => d.date === foodDate) : undefined) ??
    w.days.find((d) => d.is_today) ?? w.days[0];

  const tick = async (s: FoodSlot, date: string) => {
    if (s.logged) {
      if (!s.log_id) return; // optimistic tick still in flight — don't re-log or half-untick
      try {
        await api('/api/food/log/' + s.log_id, { method: 'DELETE' });
        qc.invalidateQueries({ queryKey: ['foodweek'] });
      } catch (e) {
        toast(e instanceof ApiError && e.network ? 'Need a connection to untick' : String((e as Error).message));
      }
      return;
    }
    if (!s.recipe) return;
    const body: QueuedTick = { date, slot: s.slot, recipe: s.recipe.slug, client_id: crypto.randomUUID() };
    // optimistic: mark logged + bump the day's totals in the cached week
    qc.setQueryData<FoodWeek>(['foodweek', wkStart || 'current'], (old) => old && ({
      ...old,
      days: old.days.map((d) => d.date !== date ? d : {
        ...d,
        slots: d.slots.map((x) => x.slot === s.slot ? { ...x, logged: true } : x),
        totals: Object.fromEntries(MACRO_KEYS.map((k) =>
          [k, (d.totals[k] || 0) + (s.recipe![k] || 0)])) as unknown as Macros,
      }),
    }));
    try {
      await api('/api/food/log', { method: 'POST', body });
      qc.invalidateQueries({ queryKey: ['foodweek'] });
    } catch (e) {
      if (e instanceof ApiError && e.network) {
        writeQueue([...readQueue(), body]);
        toast('Offline — meal queued, will sync');
      } else {
        toast(String((e as Error).message));
        qc.invalidateQueries({ queryKey: ['foodweek'] });
      }
    }
  };

  if (!day) return <Shell><Loading /></Shell>;
  const t = w.targets;
  const remaining = day.slots.filter((s) => s.recipe && !s.logged);
  const onPlanLine = !w.has_plan
    ? ''
    : remaining.length === 0 && day.slots.some((s) => s.logged)
      ? 'Day closed — all planned meals logged.'
      : remaining.some((s) => s.slot === 'dinner')
        ? 'On plan — dinner closes protein and fiber.'
        : '';

  return (
    <Shell>
      <div className="row" style={{ alignItems: 'baseline' }}>
        <Title kick={`${day.day_name} · ${day.date}${day.is_today ? ' · today' : ''}`}>Food</Title>
        <span style={{ display: 'flex', gap: 14 }}>
          <button className="press" style={{ fontSize: 13, color: 'var(--volt)', fontWeight: 700 }}
            onClick={() => go('recipes')}>Recipes ›</button>
          <button className="press" style={{ fontSize: 13, color: 'var(--volt)', fontWeight: 700 }}
            onClick={() => go('food-week')}>Week ›</button>
        </span>
      </div>

      <FoodProposalBanner onOpen={() => setPropOpen(true)} />
      {propOpen && (
        <div className="overlay" onClick={() => setPropOpen(false)}>
          <div className="sheet" style={{ maxHeight: '78vh', overflowY: 'auto' }}
            onClick={(e) => e.stopPropagation()}>
            <FoodProposalCard onDecided={() => setPropOpen(false)} />
          </div>
        </div>
      )}

      {!w.has_plan && (
        <div className="card"><div className="xname">No food week yet</div>
          <div className="sub">The recipe library is stocked — a food week appears here once one is active.</div>
        </div>
      )}

      {w.has_plan && (
        <div className="card" style={{ padding: '13px 15px' }}>
          <div className="macrogrid">
            <MacroCell label="Protein" val={day.totals.protein_g} target={t.protein_g} />
            <MacroCell label="Fiber" val={day.totals.fiber_g} target={t.fiber_g} />
            <MacroCell label="Sat fat" val={day.totals.satfat_g} target={t.satfat_g} cap />
            <MacroCell label="Calories" val={day.totals.kcal} target={t.kcal} />
            <MacroCell label="Carbs" val={day.totals.carbs_g} target={t.carbs_g} />
            <MacroCell label="Sugar" val={day.totals.sugar_g} target={t.sugar_g} cap />
            <MacroCell label="Fat" val={day.totals.fat_g} target={t.fat_g} />
            <MacroCell label="Sodium" val={day.totals.sodium_mg} target={t.sodium_mg} cap />
          </div>
          {onPlanLine && <div className="sub up" style={{ marginTop: 10 }}>{onPlanLine}</div>}
        </div>
      )}

      {day.slots.map((s) => {
        // off-plan logged meal (no recipe card) is still interactive — tap to untick
        const passive = !s.recipe && !s.label;
        const fig = s.out ? 'out' : (s.recipe?.platefig || 'plate');
        return (
          <button key={s.slot} className={'mealrow press' + (s.out ? ' dimrow' : '')}
            onClick={() => {
              if (s.recipe && !s.leftover && (s.slot === 'dinner' || (s.recipe.minutes ?? 0) > 5)) {
                go('recipe', { foodSlug: s.recipe.slug, foodDate: day.date, foodFrom: 'food' });
              } else if (!passive) {
                tick(s, day.date);
              }
            }}>
            <span className={'mtick' + (s.logged ? ' done' : '')}
              onClick={(e) => { e.stopPropagation(); if (!passive) tick(s, day.date); }}>
              {s.logged ? '✓' : passive ? '·' : '○'}
            </span>
            <PlateFig id={fig} dim={!!s.leftover} />
            <span className="mname">
              <b>{slotName(s)}</b>
              <span className="sub num" style={{ margin: 0, display: 'block' }}>
                {SLOT_LABEL[s.slot]}
                {s.recipe && <> · {macroBrief(s.recipe)}</>}
                {!s.recipe && s.macros && <> · {macroBrief(s.macros)}{s.estimated ? ' · est' : ''}</>}
                {s.off_plan && <> · off plan</>}
                {!s.recipe && !s.macros && s.note && <> · {s.note}</>}
              </span>
            </span>
            {s.recipe && !s.logged && !s.leftover && s.slot === 'dinner' && (
              <span className="num" style={{ color: 'var(--volt)', fontWeight: 700, fontSize: 12, whiteSpace: 'nowrap' }}>
                Cook ›</span>
            )}
          </button>
        );
      })}

      {day.extras.map((x) => (
        <div key={x.id} className="mealrow" style={{ cursor: 'default' }}>
          <span className="mtick done">✓</span>
          {x.photos?.length ? (
            <img src={x.photos[0]} alt="" style={{ width: 38, height: 38, borderRadius: 10, objectFit: 'cover', flex: 'none' }} />
          ) : (
            <PlateFig id="plate" />
          )}
          <span className="mname"><b>{x.label}</b>
            {(x.venue || x.cost > 0) && (
              <span className="sub" style={{ margin: 0, display: 'block' }}>
                {x.venue}{x.venue && x.cost > 0 ? ' · ' : ''}
                {x.cost > 0 && <span className="num">{x.cost.toFixed(2)}{x.currency ? ` ${x.currency}` : ''}</span>}
              </span>
            )}
            <span className="sub num" style={{ margin: 0, display: 'block' }}>
              {SLOT_LABEL[x.slot] || x.slot} · {macroBrief(x)}{x.estimated ? ' · est' : ''}
            </span></span>
        </div>
      ))}

      <button className="ghost press" onClick={() => go('recipes', { foodReplaceDate: day.date })}>
        Not feeling the plan? Cook something else
      </button>
      <button className="ghost press" onClick={() => openTab('coach')}>
        Ate something else? Tell the coach — it logs it
      </button>
    </Shell>
  );
}

/* ---------------- week menu ---------------- */
const FOOD_WEEKS_AHEAD = 4;

export function FoodWeekScreen() {
  const { go } = useApp();
  const [weekStart, setWeekStart] = useState<string | null>(null);
  const curMonday = weekStartISO(todayISO());
  const start = weekStart || curMonday;
  // three panes — viewed week plus both neighbours — so a swipe drags real content
  const wq = useFoodWeek(weekStart);
  const wqPrev = useFoodWeek(addDaysISO(start, -7));
  const wqNext = useFoodWeek(addDaysISO(start, 7));
  const [noteOpen, setNoteOpen] = useState(false);
  const [propOpen, setPropOpen] = useState(false);
  const trackRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; dx: number; mode: 'h' | 'v' | null } | null>(null);
  const anim = useRef(false);
  const w = wq.data;

  const isCurrent = start === curMonday;
  const maxStart = addDaysISO(curMonday, 7 * FOOD_WEEKS_AHEAD);
  const canNext = start < maxStart;
  const shiftWeek = (n: number) => {
    const next = addDaysISO(start, n * 7);
    if (next > maxStart) return;
    setWeekStart(next === curMonday ? null : next);
  };

  /* finger-tracked prev/cur/next week track — mirrors the Plan screen: the track
     sits at translateX(-100%); a horizontal drag moves it 1:1, release settles
     back or slides one pane over and commits the week change in the same frame. */
  const setTrack = (px: number) => {
    const el = trackRef.current;
    if (!el) return;
    el.style.transition = 'none';
    el.style.transform = `translateX(calc(-100% + ${px}px))`;
  };
  const settle = (dir: -1 | 0 | 1) => {
    const el = trackRef.current;
    if (!el || (dir !== 0 && anim.current)) return;
    if (dir !== 0 && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      el.style.transition = 'none';
      el.style.transform = 'translateX(-100%)';
      shiftWeek(dir);
      return;
    }
    anim.current = dir !== 0;
    el.style.transition = 'transform .28s cubic-bezier(.22,.9,.3,1)';
    el.style.transform = `translateX(${dir === 1 ? -200 : dir === -1 ? 0 : -100}%)`;
    if (dir === 0) return;
    window.setTimeout(() => {
      el.style.transition = 'none';
      el.style.transform = 'translateX(-100%)';
      shiftWeek(dir);
      anim.current = false;
    }, 290);
  };
  const onTouchStart = (e: React.TouchEvent) => {
    if (anim.current) return;
    drag.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, dx: 0, mode: null };
  };
  const onTouchMove = (e: React.TouchEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.touches[0].clientX - d.x;
    const dy = e.touches[0].clientY - d.y;
    if (!d.mode) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      d.mode = Math.abs(dx) > Math.abs(dy) * 1.2 ? 'h' : 'v';
    }
    if (d.mode !== 'h') return;
    d.dx = dx < 0 && !canNext ? dx / 3 : dx;  // rubber-band past the forward cap
    setTrack(d.dx);
  };
  const onTouchEnd = () => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.mode !== 'h') return;
    const width = trackRef.current?.parentElement?.clientWidth || 390;
    if (Math.abs(d.dx) < Math.min(110, width * 0.28)) return settle(0);
    const dir = d.dx < 0 ? 1 : -1;
    settle(dir === 1 && !canNext ? 0 : dir);
  };
  const onTouchCancel = () => {
    if (drag.current?.mode === 'h') settle(0);
    drag.current = null;
  };

  if (!w) return <Shell><Loading /></Shell>;

  const bls = (d: FoodDay): string =>
    d.slots.filter((s) => s.slot !== 'dinner')
      .map((s) => `${s.slot[0].toUpperCase()} ${s.order ? 'order' : s.leftover ? 'leftovers'
        : s.recipe ? s.recipe.name.split(' —')[0].split(',')[0].toLowerCase() : '—'}`)
      .join(' · ');

  /** One week of content — stats, coach note, day rows. Rendered three times
      (prev/cur/next) into the sliding track. */
  const pane = (wk: FoodWeek | undefined, pos: 'prev' | 'cur' | 'next') => {
    if (!wk) return <div className="wpane" key={pos}><Loading /></div>;
    const planned = wk.days.map((d) => {
      const sums = { protein_g: 0, fiber_g: 0, satfat_g: 0 };
      d.slots.forEach((s) => {
        if (s.recipe) { sums.protein_g += s.recipe.protein_g; sums.fiber_g += s.recipe.fiber_g; sums.satfat_g += s.recipe.satfat_g; }
      });
      return sums;
    });
    const avg = (k: keyof (typeof planned)[number]) =>
      Math.round(planned.reduce((a, p) => a + p[k], 0) / (planned.length || 1));
    const t = wk.targets;
    return (
      <div className="wpane" key={pos}>
        <div className="statchips">
          <div className="statchip"><div className="k">Planned protein</div>
            <div className="v num">{avg('protein_g')}g<span className="sub" style={{ margin: 0 }}>/day</span></div></div>
          <div className="statchip"><div className="k">Planned fiber</div>
            <div className="v num">{avg('fiber_g')}g<span className="sub" style={{ margin: 0 }}>/day</span></div></div>
          <div className="statchip"><div className="k">Sat fat · cap {t.satfat_g}</div>
            <div className="v num">{avg('satfat_g')}g<span className="sub" style={{ margin: 0 }}>/day</span></div></div>
        </div>
        <div className="sub" style={{ margin: '-2px 2px 0' }}>
          Planned recipes only — order-out lunches and the night out add on top.
        </div>
        {wk.rationale && (
          <button className="coachnote press" onClick={() => setNoteOpen(!noteOpen)}>
            <span className="kick" style={{ fontSize: 11 }}>This week</span>
            <div className={noteOpen ? '' : 'clamp'} style={{ marginTop: 3 }}>{wk.rationale}</div>
            <div className="more">{noteOpen ? 'less' : 'more'}</div>
          </button>
        )}
        {wk.days.map((d) => {
          const dinner = d.slots.find((s) => s.slot === 'dinner');
          const allLogged = d.slots.filter((s) => s.recipe).length > 0 &&
            d.slots.filter((s) => s.recipe).every((s) => s.logged);
          const fig = dinner?.out ? 'out' : (dinner?.recipe?.platefig || 'plate');
          return (
            <button key={d.date} className={'mealrow press' + (dinner?.out ? ' dimrow' : '')}
              onClick={() => go('food', { foodDate: d.is_today ? null : d.date })}>
              <span className="dcol num">
                <span className="dn">{d.day_name.slice(0, 3)}</span>
                <span className="dd disp">{+d.date.slice(8)}</span>
              </span>
              <PlateFig id={fig} dim={!!dinner?.leftover} />
              <span className="mname">
                <b>{dinner ? slotName(dinner) : 'No dinner planned'}</b>
                <span className="sub" style={{ margin: 0, display: 'block' }}>{bls(d)}</span>
              </span>
              <span className="rsub num" style={allLogged ? { color: 'var(--volt)', fontWeight: 700 } : undefined}>
                {allLogged ? '✓ on plan'
                  : dinner?.out ? 'out'
                  : dinner?.leftover ? '↻ batch'
                  : dinner?.recipe ? `${dinner.recipe.minutes} min` : ''}
              </span>
              <span className="chev">›</span>
            </button>
          );
        })}
        <Chip>The coach proposes each week on Sundays alongside training — the shopping list
          lands later in Phase 8.</Chip>
      </div>
    );
  };

  return (
    <Shell>
      <Back label="Food" onClick={() => go('food')} />
      <div className="swipeweeks" onTouchStart={onTouchStart} onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd} onTouchCancel={onTouchCancel}>
        <div className="row" style={{ alignItems: 'center' }}>
          <Title kick={isCurrent ? 'This week' : `Week of ${w.start}`}>Food week</Title>
          <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            {!isCurrent && (
              <button className="press" style={{ fontSize: 12, color: 'var(--volt)', fontWeight: 700 }}
                onClick={() => setWeekStart(null)}>this week</button>
            )}
            <button className="ghost press" aria-label="Previous week"
              style={{ width: 34, padding: '6px 0' }} onClick={() => settle(-1)}>‹</button>
            <button className="ghost press" aria-label="Next week" disabled={!canNext}
              style={{ width: 34, padding: '6px 0' }} onClick={() => settle(1)}>›</button>
          </span>
        </div>

        <FoodProposalBanner onOpen={() => setPropOpen(true)} />

        <div className="wclip">
          <div className="wtrack" ref={trackRef} style={{ transform: 'translateX(-100%)' }}>
            {pane(wqPrev.data, 'prev')}
            {pane(w, 'cur')}
            {pane(wqNext.data, 'next')}
          </div>
        </div>
      </div>

      {propOpen && (
        <div className="overlay" onClick={() => setPropOpen(false)}>
          <div className="sheet" style={{ maxHeight: '78vh', overflowY: 'auto' }}
            onClick={(e) => e.stopPropagation()}>
            <FoodProposalCard onDecided={() => setPropOpen(false)} />
          </div>
        </div>
      )}
    </Shell>
  );
}

/* ---------------- recipe library (browse + search) ---------------- */
const KINDS = ['dinner', 'lunch', 'breakfast', 'snack'] as const;

export function RecipeLibraryScreen() {
  const { go, foodReplaceDate } = useApp();
  const replace = !!foodReplaceDate;
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<string | null>(null);
  const lib = useQuery<RecipeList>({
    queryKey: ['recipes'],
    queryFn: () => api('/api/food/recipes'),
    staleTime: 60_000,
  });
  if (!lib.data) return <Shell><Loading /></Shell>;

  const isToday = foodReplaceDate === todayISO();
  const replDay = foodReplaceDate
    ? (isToday ? 'tonight'
      : new Date(foodReplaceDate + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'long' }))
    : '';
  // household-sized library: fetch once, filter as-you-type client-side. In
  // "cook something else" mode we offer complete dinners to swap in for one day.
  const term = q.trim().toLowerCase();
  const rows = lib.data.recipes.filter((r) =>
    (replace ? (r.kind === 'dinner' && r.complete) : (!kind || r.kind === kind)) &&
    (!term || r.name.toLowerCase().includes(term) || r.tags.some((t) => t.toLowerCase().includes(term))));

  // Replace mode is a ONE-DAY action: open the recipe scoped to that date, so
  // cooking or logging it records it for that day only (replacing the planned
  // dinner via the day view), never the recurring weekday template.
  const pick = (slug: string) =>
    replace
      ? go('recipe', { foodSlug: slug, foodDate: foodReplaceDate, foodFrom: 'food', foodReplaceDate: null })
      : go('recipe', { foodSlug: slug, foodFrom: 'recipes' });

  return (
    <Shell>
      <Back label="Food" onClick={() => go('food',
        replace ? { foodDate: foodReplaceDate, foodReplaceDate: null } : {})} />
      <Title kick={replace ? `instead of ${replDay}'s plan` : `${lib.data.count} recipes · seed + imports`}>
        {replace ? 'Cook something else' : 'Library'}
      </Title>
      {replace && (
        <div className="sub" style={{ margin: '-2px 2px 4px' }}>
          Pick a dinner to cook {isToday ? 'tonight' : `for ${replDay}`} — cooking or logging it
          swaps it in for that day. Your weekly plan stays as it is.
        </div>
      )}
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or tag…"
        style={{ background: 'var(--raised)', border: 0, borderRadius: 12, padding: '10px 13px', width: '100%' }} />
      {!replace && (
        <div className="fchips">
          {KINDS.map((k) => (
            <button key={k} className={'fchip press' + (kind === k ? '' : ' dim')}
              onClick={() => setKind(kind === k ? null : k)}>{k}</button>
          ))}
        </div>
      )}
      {rows.map((r) => (
        <button key={r.slug} className="mealrow press"
          onClick={() => pick(r.slug)}>
          {r.image ? (
            <img src={r.image} alt="" style={{ width: 42, height: 42, borderRadius: 10, objectFit: 'cover', flex: 'none' }} />
          ) : (
            <PlateFig id={r.platefig} />
          )}
          <span className="mname">
            <b>{r.name}</b>
            <span className="sub num" style={{ margin: 0, display: 'block' }}>
              {r.kind} · {r.minutes} min · {macroBrief(r)}
            </span>
          </span>
          <span className="rsub num">
            {replace ? ((r.rating ?? 0) > 0 ? <><span style={{ color: 'var(--volt)' }}>★</span> {(r.rating ?? 0).toFixed(1)}</> : null)
              : !r.complete ? <span style={{ color: 'var(--warn)', fontWeight: 700 }}>parked</span>
              : (r.rating ?? 0) > 0 ? <><span style={{ color: 'var(--volt)' }}>★</span> {(r.rating ?? 0).toFixed(1)}</>
              : null}
          </span>
          <span className="chev">›</span>
        </button>
      ))}
      {!rows.length && <div className="sub" style={{ textAlign: 'center' }}>No recipes match.</div>}
      {!replace && (
        <Chip>Imported recipes land here. Parked ones are missing pantry reference data —
          still cookable, never proposed by the coach.</Chip>
      )}
    </Shell>
  );
}

/* ---------------- recipe detail ---------------- */
export function useRecipe(slug: string) {
  return useQuery<RecipeFull>({
    queryKey: ['recipe', slug],
    queryFn: () => api('/api/food/recipes/' + slug),
    enabled: !!slug,
    staleTime: 5 * 60_000,
  });
}

/** Ingredient amount scaled to `servings` of a recipe authored for `base`.
 *  The freeform `disp` is only trustworthy at the authored count, so once scaled
 *  we fall back to the numeric qty·unit. */
function scaledAmount(i: RecipeIngredient, base: number, servings: number): string {
  if (!i.qty) return i.disp || '';  // no quantity to show (e.g. "to taste")
  if (servings === base || base <= 0) return i.disp || `${i.qty} ${i.unit}`;
  const v = (i.qty * servings) / base;
  if (i.unit === 'x') {
    const n = Math.round(v * 2) / 2;
    return '×' + (Number.isInteger(n) ? n : n.toFixed(1));
  }
  const n = v >= 100 ? Math.round(v / 5) * 5 : Math.round(v * 10) / 10;
  return `${n} ${i.unit}`;
}

/** Pick a night to pencil this recipe into — writes that weekday's slot on the
 *  active food week (household-shared for members, own scope for the demo). */
function PlanDaySheet({ recipe, onClose }: { recipe: RecipeFull; onClose: () => void }) {
  const qc = useQueryClient();
  const wq = useFoodWeek(null);
  const slot = recipe.kind === 'dinner' ? 'dinner' : recipe.kind;
  const set = useMutation({
    mutationFn: (date: string) => api('/api/food/week/slot', {
      method: 'PATCH', body: { date, recipe: recipe.slug, slot },
    }),
    onSuccess: (_d, date) => {
      qc.invalidateQueries({ queryKey: ['foodweek'] });
      const dn = wq.data?.days.find((x) => x.date === date)?.day_name || 'that day';
      toast(`${recipe.name} set for ${dn}`, true);
      onClose();
    },
    onError: (e) => toast(e instanceof ApiError && e.network
      ? 'Need a connection to plan' : String((e as Error).message)),
  });
  return (
    <div className="overlay" onClick={onClose}>
      <div className="sheet" style={{ maxHeight: '78vh', overflowY: 'auto' }}
        onClick={(e) => e.stopPropagation()}>
        <h3>Plan {recipe.name}</h3>
        <div className="sub" style={{ marginTop: 0 }}>
          Pick a night — it becomes that weekday's {slot} on your food week (every week, until the coach reworks it).
        </div>
        {!wq.data ? <Loading /> : wq.data.days.map((d) => {
          const cur = d.slots.find((s) => s.slot === slot);
          return (
            <button key={d.date} className="lrow press" disabled={set.isPending}
              onClick={() => set.mutate(d.date)}>
              <b>{d.day_name}{d.is_today ? ' · today' : ''}</b>
              <span className="rsub">{cur?.recipe ? `now: ${cur.recipe.name}` : cur?.out ? 'night out' : 'empty'}</span>
              <span className="chev">›</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function RecipeScreen() {
  const { go, foodSlug, foodDate, foodFrom } = useApp();
  const fromLib = foodFrom === 'recipes';
  const qc = useQueryClient();
  const q = useRecipe(foodSlug);
  const r = q.data;
  const [servingsOverride, setServingsOverride] = useState<number | null>(null);
  const [planOpen, setPlanOpen] = useState(false);

  const logMut = useMutation({
    mutationFn: () => api('/api/food/log', {
      method: 'POST',
      body: { date: foodDate || todayISO(), slot: r!.kind === 'dinner' ? 'dinner' : r!.kind,
        recipe: r!.slug, client_id: crypto.randomUUID() },
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['foodweek'] });
      toast(`Logged — P +${r!.protein_g} · fiber +${r!.fiber_g}`, true);
      go('food');
    },
    onError: (e) => toast(e instanceof ApiError && e.network ? 'Offline — tick it from the day view instead' : String(e.message)),
  });

  if (!r) return <Shell><Loading /></Shell>;
  const servings = servingsOverride ?? r.serves;

  return (
    <Shell>
      <Back label={fromLib ? 'Library' : 'Food'} onClick={() => go(fromLib ? 'recipes' : 'food')} />
      <Title kick={`${r.kind}${r.batch ? ' · cook once, eat twice' : ''}`}>{r.name}</Title>
      <div className="fchips">
        <span className="fchip dim num">{r.minutes} min</span>
        <span className="fchip dim">{r.difficulty}</span>
        <span className="fchip dim num">serves {r.serves}{r.batch ? ` + ${r.batch} boxed` : ''}</span>
      </div>
      <div className="fchips">
        <span className="fchip num">{r.kcal} kcal</span>
        <span className="fchip num">P {r.protein_g}</span>
        <span className="fchip num">carbs {r.carbs_g}</span>
        <span className="fchip num">fiber {r.fiber_g}</span>
        <span className="fchip num">fat {r.fat_g}</span>
      </div>
      <div className="fchips">
        <span className="fchip dim num">sugar {r.sugar_g} g</span>
        <span className="fchip dim num">sat fat {r.satfat_g} g</span>
        <span className="fchip dim num">sodium {r.sodium_mg} mg</span>
      </div>

      {r.images?.length ? (
        <img src={r.images[0]} alt={r.name}
          style={{ width: '100%', borderRadius: 14, aspectRatio: '16 / 10', objectFit: 'cover' }} />
      ) : (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '4px 0' }}>
          <PlateFig id={r.platefig} size={132} />
        </div>
      )}
      {r.rating > 0 && (
        <div className="sub num" style={{ margin: 0 }}>
          <span style={{ color: 'var(--volt)' }}>★</span> {r.rating.toFixed(1)}
          {r.rating_count > 0 && ` · ${r.rating_count} ratings`}
          {r.source && ` · ${r.source}`}
        </div>
      )}

      {r.why && (
        <div className="card">
          <span className="up" style={{ fontSize: 14 }}>Why it's here</span>
          <div className="sub" style={{ marginTop: 4 }}>{r.why}</div>
        </div>
      )}

      <div className="sect">Ingredients{r.batch ? ' · 2 nights' : ''}</div>
      {r.serves > 1 && (
        <div className="card" style={{ padding: '12px 15px' }}>
          <div className="row" style={{ alignItems: 'baseline' }}>
            <span className="sub" style={{ margin: 0 }}>Scale the batch</span>
            <span className="num" style={{ fontWeight: 700 }}>
              serves {servings}
              {servings !== r.serves && <span className="sub" style={{ margin: 0 }}> · authored {r.serves}</span>}
            </span>
          </div>
          <input type="range" min={1} max={r.serves} step={1} value={servings}
            style={{ marginTop: 8 }}
            onChange={(e) => setServingsOverride(+e.target.value)} />
          <div className="sub" style={{ margin: 0 }}>
            {servings === r.serves
              ? 'Cooking for fewer? Drag it down — amounts scale, per-plate macros stay the same.'
              : `Amounts scaled to ${servings} ${servings === 1 ? 'serving' : 'servings'}. Per-plate macros unchanged.`}
          </div>
        </div>
      )}
      <div className="card" style={{ padding: '4px 15px' }}>
        {r.ingredients.map((i) => (
          <div key={i.name} className="ingrow">
            <span className={'ingname' + (i.pantry ? ' dimrow' : '')}>
              {i.name}
              {i.note && i.note !== 'pantry' && <span className="ingnote">{i.note}</span>}
            </span>
            <span className="ingamt">
              <span className="sub num">{scaledAmount(i, r.serves, servings)}</span>
              {i.pantry && <span className="ingtag">pantry</span>}
            </span>
          </div>
        ))}
      </div>

      {r.steps.length > 0 && (
        <>
          <div className="sect">Method · {r.steps.length} steps</div>
          <div className="card" style={{ padding: '4px 15px' }}>
            {r.steps.map((s, i) => (
              <div key={i} className="steprow">
                <span className="n num">{i + 1}</span>
                <span style={{ flex: 1 }}>
                  <b style={{ fontWeight: 650 }}>{s.title}</b>
                  <span className="sub num" style={{ margin: 0, marginLeft: 6, display: 'inline' }}>
                    {s.minutes ? `· ${s.minutes} min` : ''}{s.timer ? ' · timer' : ''}
                    {s.parallel ? ' · background' : ''}
                  </span>
                  <span className="sub" style={{ margin: '2px 0 0', display: 'block' }}>{s.detail}</span>
                  {s.image && (
                    <img src={s.image} alt=""
                      style={{ width: '100%', maxWidth: 220, borderRadius: 10, marginTop: 6, display: 'block' }} />
                  )}
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      {r.source_url && (
        <a href={r.source_url} target="_blank" rel="noreferrer" className="sub"
          style={{ display: 'block', textAlign: 'center', margin: 0 }}>
          Original recipe · {r.source || 'source'} ↗
        </a>
      )}

      <button className="ghost press" onClick={() => setPlanOpen(true)}>
        {r.kind === 'dinner' ? 'Plan into a dinner' : 'Plan into a day'} →
      </button>

      {r.steps.length > 1 ? (
        <>
          <button className="cta press" onClick={() => go('cook')}>
            Cook step-by-step · {r.minutes} min
          </button>
          <button className="press" style={{ textAlign: 'center', fontSize: 13, color: 'var(--mut)' }}
            disabled={logMut.isPending} onClick={() => logMut.mutate()}>
            Already cooked? <b style={{ color: 'var(--volt)' }}>Log it in one tap</b>
          </button>
        </>
      ) : (
        <button className="cta press" disabled={logMut.isPending} onClick={() => logMut.mutate()}>
          Log it · {r.kcal} kcal
        </button>
      )}
      {planOpen && <PlanDaySheet recipe={r} onClose={() => setPlanOpen(false)} />}
    </Shell>
  );
}

/* ---------------- cook mode ---------------- */
const RING_C = 2 * Math.PI * 56; // r=56 in a 140 viewBox

export function CookScreen() {
  const { go, foodSlug, foodDate } = useApp();
  const qc = useQueryClient();
  const q = useRecipe(foodSlug);
  const r = q.data;
  const [idx, setIdx] = useState(0);
  const [plated, setPlated] = useState(false);
  // Background timers keyed by step index. They keep running — and stay visible
  // in the strip — as you move to other steps, so a simmer can cook while you
  // prep the next thing in parallel. Absolute end time survives step changes.
  const [timers, setTimers] = useState<Record<number, { total: number; end: number; done: boolean }>>({});
  const [now, setNow] = useState(() => Date.now());
  const t0 = useRef(Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);
  // chime each timer exactly once as it crosses zero
  useEffect(() => {
    const due = Object.entries(timers).filter(([, t]) => !t.done && t.end <= now);
    if (!due.length) return;
    setTimers((prev) => {
      const next = { ...prev };
      for (const [k] of due) next[+k] = { ...next[+k], done: true };
      return next;
    });
    for (const [k] of due) toast(`${r?.steps[+k]?.title || 'Timer'} — time's up`, true);
    if (navigator.vibrate) navigator.vibrate([160, 90, 160]);
  }, [now, timers, r]);

  if (!r) return <Shell><Loading /></Shell>;
  const steps = r.steps;
  const step = steps[Math.min(idx, steps.length - 1)];
  const last = idx >= steps.length - 1;
  const remainOf = (i: number): number | null => {
    const t = timers[i];
    return t ? Math.max(0, Math.round((t.end - now) / 1000)) : null;
  };
  const startTimer = (i: number) =>
    setTimers((t) => ({ ...t, [i]: { total: (steps[i].minutes || 1) * 60,
      end: Date.now() + (steps[i].minutes || 1) * 60 * 1000, done: false } }));
  const running = steps.map((s, i) => ({ s, i })).filter(({ i }) => timers[i]);

  const finish = async () => {
    const cookedMin = Math.max(1, Math.round((Date.now() - t0.current) / 60000));
    try {
      await api('/api/food/log', {
        method: 'POST',
        body: { date: foodDate || todayISO(), slot: r.kind, recipe: r.slug,
          client_id: crypto.randomUUID() },
      });
      qc.invalidateQueries({ queryKey: ['foodweek'] });
    } catch { toast('Offline — tick it from the day view when back online'); }
    setPlated(true);
    toast(`Plated in ${cookedMin} min — ${r.kind} logged`, true);
  };

  if (plated) {
    return (
      <Shell>
        <Title kick={`Cook mode · ${r.name}`}>Plated. Logged.</Title>
        {r.images?.length ? (
          <img src={r.images[0]} alt={r.name}
            style={{ width: '100%', borderRadius: 14, aspectRatio: '16 / 10', objectFit: 'cover' }} />
        ) : (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '2px 0' }}>
            <PlateFig id={r.platefig} size={140} />
          </div>
        )}
        <div className="card" style={{ padding: '4px 15px' }}>
          {r.batch > 0 && (
            <div className="mealrow" style={{ borderTop: 'none' }}>
              <span className="mtick done">✓</span>
              <span className="mname"><b>Leftover night boxed</b>
                <span className="sub" style={{ margin: 0, display: 'block' }}>
                  {r.batch} servings in the fridge — zero-cook night locked in</span></span>
            </div>
          )}
          <div className="mealrow">
            <span className="mtick done">✓</span>
            <span className="mname"><b>{SLOT_LABEL[r.kind] || 'Meal'} logged — your plate</b>
              <span className="sub" style={{ margin: 0, display: 'block' }}>
                Everyone else ticks their own — their plate, their targets</span></span>
          </div>
        </div>
        <div className="card">
          <div className="kick" style={{ fontSize: 11 }}>Per plate</div>
          <div className="statchips">
            <div className="statchip"><div className="k">kcal</div><div className="v disp num">{r.kcal}</div></div>
            <div className="statchip"><div className="k">Protein</div><div className="v disp num">{r.protein_g}</div></div>
            <div className="statchip"><div className="k">Fiber</div><div className="v disp num">{r.fiber_g}</div></div>
            <div className="statchip"><div className="k">Sat fat</div><div className="v disp num">{r.satfat_g}</div></div>
          </div>
          <div className="statchips">
            <div className="statchip"><div className="k">Carbs</div><div className="v disp num">{r.carbs_g}</div></div>
            <div className="statchip"><div className="k">Sugar</div><div className="v disp num">{r.sugar_g}</div></div>
            <div className="statchip"><div className="k">Fat</div><div className="v disp num">{r.fat_g}</div></div>
            <div className="statchip"><div className="k">Sodium</div><div className="v disp num">{r.sodium_mg}<span className="sub" style={{ margin: 0, fontSize: 10 }}> mg</span></div></div>
          </div>
        </div>
        <button className="cta mt press" onClick={() => go('food')}>Done</button>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="row" style={{ alignItems: 'center' }}>
        <Back label="exit" onClick={() => go('recipe')} />
        <span className="kick" style={{ fontSize: 11 }}>{r.name}</span>
      </div>

      <div className="stepdots num">
        {steps.map((_, i) => (
          <span key={i} className={'sdot' + (i < idx ? ' done' : i === idx ? ' cur' : '')}>
            {i < idx ? '✓' : i + 1}
          </span>
        ))}
        <span className="steplab">Step {idx + 1} of {steps.length}</span>
      </div>

      {running.length > 0 && (
        <div className="timerstrip">
          {running.map(({ s, i }) => {
            const t = timers[i];
            return (
              <button key={i} className={'timerpill press' + (t.done ? ' done' : '') + (i === idx ? ' cur' : '')}
                onClick={() => setIdx(i)}>
                <span className="tp-title">{i + 1}. {s.title}</span>
                <span className="tp-time num">{t.done ? 'done ✓' : fmtT(remainOf(i)!)}</span>
              </button>
            );
          })}
        </div>
      )}

      <h2 className="title" style={{ fontSize: 24 }}>{step.title}</h2>
      {step.parallel && (
        <div className="chip"><span className="dot" /> Background step — start it, then move on while it cooks.</div>
      )}
      <div className="bigsub">{step.detail}</div>
      {step.image && (
        <img src={step.image} alt=""
          style={{ width: '100%', maxWidth: 280, borderRadius: 12, margin: '4px auto', display: 'block' }} />
      )}

      {step.timer && (() => {
        const rem = remainOf(idx);
        const tot = timers[idx]?.total || (step.minutes || 1) * 60;
        return (
          <div className="ringcook">
            <svg viewBox="0 0 140 140" width="158" height="158">
              <circle cx="70" cy="70" r="56" fill="none" stroke="var(--sunken)" strokeWidth="7" />
              {rem !== null && tot > 0 && (
                <circle cx="70" cy="70" r="56" fill="none" stroke="var(--volt)" strokeWidth="7"
                  strokeLinecap="round" transform="rotate(-90 70 70)"
                  strokeDasharray={`${(rem / tot) * RING_C} ${RING_C}`} />
              )}
              <text x="70" y="74" textAnchor="middle" className="ringnum num">
                {rem !== null ? fmtT(rem) : fmtT((step.minutes || 1) * 60)}
              </text>
              <text x="70" y="92" textAnchor="middle" className="ringcap">
                {rem !== null ? (rem === 0 ? 'done' : `of ${step.minutes}:00`) : `${step.minutes} min`}
              </text>
            </svg>
            {rem === null ? (
              <button className="ghost press" style={{ maxWidth: 240 }} onClick={() => startTimer(idx)}>
                Start the {step.minutes}-minute timer
              </button>
            ) : step.parallel ? (
              <div className="sub">Running in the background — carry on to the next step; it'll chime here (and in the strip above) when it's done.</div>
            ) : (
              <div className="sub">A local timer, same as your rest ring — it chimes here, no push.</div>
            )}
          </div>
        );
      })()}

      <div className="btnrow" style={{ marginTop: 'auto' }}>
        {idx > 0 && (
          <button className="ghost press" style={{ flex: 1 }} onClick={() => setIdx(idx - 1)}>
            ‹ {steps[idx - 1].title}
          </button>
        )}
        <button className="cta press" style={{ flex: 1.5 }} onClick={() => (last ? finish() : setIdx(idx + 1))}>
          {last ? `Plate & log ${r.kind}` : `${steps[idx + 1].title} ›`}
        </button>
      </div>
    </Shell>
  );
}
