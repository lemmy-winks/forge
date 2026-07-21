/* Food tab (beta track, Phase 7): day view (meters + one-tap tick rows),
   week menu, recipe detail, and cook mode. Plate-first layout — the
   cholesterol trio leads. Ticks queue in localStorage when offline and
   replay idempotently via client_id (uq_meal_client server-side). */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import {
  api, ApiError, fmtT, todayISO,
  type FoodDay, type FoodProposalResp, type FoodPropSlot, type FoodSlot, type FoodWeek,
  type RecipeFull,
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
export function useFoodWeek() {
  return useQuery<FoodWeek>({ queryKey: ['foodweek'], queryFn: () => api('/api/food/week') });
}

export function useFoodProposal() {
  return useQuery<FoodProposalResp>({
    queryKey: ['foodproposal'], queryFn: () => api('/api/food/proposal'),
  });
}

const SLOT_LABEL: Record<string, string> = {
  breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner', snack: 'Snack',
};

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
  return s.note || 'Unplanned';
}

/* ---------------- meters ---------------- */
function Meter({ label, val, target, cap }: { label: string; val: number; target: number; cap?: boolean }) {
  const pct = Math.min(100, Math.round((val / Math.max(target, 1)) * 100));
  const over = cap && val > target;
  return (
    <div className="meter">
      <div className="row">
        <span className="sub" style={{ margin: 0 }}>{label}</span>
        <span className="mval num"><b className={over ? 'warn' : ''}>{Math.round(val * 10) / 10}</b>
          {' / '}{cap ? '≤' : ''}{target}{label === 'Calories' ? '' : ' g'}</span>
      </div>
      <div className="mtrack"><i style={{ width: pct + '%', background: over ? 'var(--warn)' : undefined }} /></div>
    </div>
  );
}

/* ---------------- day view (the Food tab home) ---------------- */
export function FoodDayScreen() {
  const { go, openTab, foodDate } = useApp();
  const qc = useQueryClient();
  const wq = useFoodWeek();
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
    qc.setQueryData<FoodWeek>(['foodweek'], (old) => old && ({
      ...old,
      days: old.days.map((d) => d.date !== date ? d : {
        ...d,
        slots: d.slots.map((x) => x.slot === s.slot ? { ...x, logged: true } : x),
        totals: {
          kcal: d.totals.kcal + (s.recipe!.kcal || 0),
          protein_g: d.totals.protein_g + (s.recipe!.protein_g || 0),
          fiber_g: d.totals.fiber_g + (s.recipe!.fiber_g || 0),
          satfat_g: d.totals.satfat_g + (s.recipe!.satfat_g || 0),
        },
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
        <button className="press" style={{ fontSize: 13, color: 'var(--volt)', fontWeight: 700 }}
          onClick={() => go('food-week')}>Week ›</button>
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
        <div className="card">
          <Meter label="Protein" val={day.totals.protein_g} target={t.protein_g} />
          <Meter label="Fiber" val={day.totals.fiber_g} target={t.fiber_g} />
          <Meter label="Sat fat · cap" val={day.totals.satfat_g} target={t.satfat_g} cap />
          <Meter label="Calories" val={day.totals.kcal} target={t.kcal} />
          {onPlanLine && <div className="sub up" style={{ marginTop: 8 }}>{onPlanLine}</div>}
        </div>
      )}

      {day.slots.map((s) => {
        const passive = !s.recipe;
        const fig = s.out ? 'out' : (s.recipe?.platefig || 'plate');
        return (
          <button key={s.slot} className={'mealrow press' + (s.out ? ' dimrow' : '')}
            onClick={() => {
              if (s.recipe && !s.leftover && (s.slot === 'dinner' || (s.recipe.minutes ?? 0) > 5)) {
                go('recipe', { foodSlug: s.recipe.slug, foodDate: day.date });
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
                {s.recipe && <> · {s.recipe.kcal} kcal · P {s.recipe.protein_g} · fib {s.recipe.fiber_g} · sat {s.recipe.satfat_g}</>}
                {!s.recipe && s.note && <> · {s.note}</>}
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
          <PlateFig id="plate" />
          <span className="mname"><b>{x.label}</b>
            <span className="sub num" style={{ margin: 0, display: 'block' }}>
              {SLOT_LABEL[x.slot] || x.slot} · {x.kcal} kcal · P {x.protein_g}{x.estimated ? ' · estimated' : ''}
            </span></span>
        </div>
      ))}

      <button className="ghost press" onClick={() => openTab('coach')}>
        Ate something else? Tell the coach — it logs it
      </button>
    </Shell>
  );
}

/* ---------------- week menu ---------------- */
export function FoodWeekScreen() {
  const { go } = useApp();
  const wq = useFoodWeek();
  const w = wq.data;
  const [noteOpen, setNoteOpen] = useState(false);
  const [propOpen, setPropOpen] = useState(false);
  if (!w) return <Shell><Loading /></Shell>;

  const planned = w.days.map((d) => {
    const sums = { protein_g: 0, fiber_g: 0, satfat_g: 0 };
    d.slots.forEach((s) => {
      if (s.recipe) {
        sums.protein_g += s.recipe.protein_g; sums.fiber_g += s.recipe.fiber_g; sums.satfat_g += s.recipe.satfat_g;
      }
    });
    return sums;
  });
  const avg = (k: keyof (typeof planned)[number]) =>
    Math.round(planned.reduce((a, p) => a + p[k], 0) / (planned.length || 1));
  const t = w.targets;

  const bls = (d: FoodDay): string =>
    d.slots.filter((s) => s.slot !== 'dinner')
      .map((s) => `${s.slot[0].toUpperCase()} ${s.order ? 'order' : s.leftover ? 'leftovers'
        : s.recipe ? s.recipe.name.split(' —')[0].split(',')[0].toLowerCase() : '—'}`)
      .join(' · ');

  return (
    <Shell>
      <Back label="Food" onClick={() => go('food')} />
      <Title kick={`Week of ${w.start}`}>Food week</Title>

      <FoodProposalBanner onOpen={() => setPropOpen(true)} />
      {propOpen && (
        <div className="overlay" onClick={() => setPropOpen(false)}>
          <div className="sheet" style={{ maxHeight: '78vh', overflowY: 'auto' }}
            onClick={(e) => e.stopPropagation()}>
            <FoodProposalCard onDecided={() => setPropOpen(false)} />
          </div>
        </div>
      )}

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

      {w.rationale && (
        <button className="coachnote press" onClick={() => setNoteOpen(!noteOpen)}>
          <span className="kick" style={{ fontSize: 11 }}>This week</span>
          <div className={noteOpen ? '' : 'clamp'} style={{ marginTop: 3 }}>{w.rationale}</div>
          <div className="more">{noteOpen ? 'less' : 'more'}</div>
        </button>
      )}

      {w.days.map((d) => {
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

export function RecipeScreen() {
  const { go, foodSlug, foodDate } = useApp();
  const qc = useQueryClient();
  const q = useRecipe(foodSlug);
  const r = q.data;

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

  return (
    <Shell>
      <Back label="Food" onClick={() => go('food')} />
      <Title kick={`${r.kind}${r.batch ? ' · cook once, eat twice' : ''}`}>{r.name}</Title>
      <div className="fchips">
        <span className="fchip dim num">{r.minutes} min</span>
        <span className="fchip dim">{r.difficulty}</span>
        <span className="fchip dim num">serves {r.serves}{r.batch ? ` + ${r.batch} boxed` : ''}</span>
      </div>
      <div className="fchips">
        <span className="fchip num">{r.kcal} kcal</span>
        <span className="fchip num">P {r.protein_g}</span>
        <span className="fchip num">fiber {r.fiber_g}</span>
        <span className="fchip num">sat fat {r.satfat_g}</span>
      </div>

      <div style={{ display: 'flex', justifyContent: 'center', padding: '4px 0' }}>
        <PlateFig id={r.platefig} size={132} />
      </div>

      {r.why && (
        <div className="card">
          <span className="up" style={{ fontSize: 14 }}>Why it's here</span>
          <div className="sub" style={{ marginTop: 4 }}>{r.why}</div>
        </div>
      )}

      <div className="sect">Ingredients{r.batch ? ' · 2 nights' : ''}</div>
      <div className="card" style={{ padding: '4px 15px' }}>
        {r.ingredients.map((i) => (
          <div key={i.name} className="ingrow">
            <span className={i.pantry ? 'dimrow' : ''} style={{ flex: 1 }}>
              {i.name}
              {i.note && i.note !== 'pantry' && <span className="fchip" style={{ marginLeft: 6, fontSize: 10.5, padding: '2px 8px' }}>{i.note}</span>}
            </span>
            <span className="sub num" style={{ margin: 0, whiteSpace: 'nowrap' }}>
              {i.pantry ? 'pantry' : i.disp}
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
                  </span>
                  <span className="sub" style={{ margin: '2px 0 0', display: 'block' }}>{s.detail}</span>
                </span>
              </div>
            ))}
          </div>
        </>
      )}

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
  const [remain, setRemain] = useState<number | null>(null); // seconds left on this step's timer
  const [total, setTotal] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval>>(undefined);
  const t0 = useRef(Date.now());

  // reset any running timer when the step changes
  useEffect(() => {
    clearInterval(timerRef.current);
    setRemain(null); setTotal(0);
  }, [idx]);
  useEffect(() => () => clearInterval(timerRef.current), []);

  if (!r) return <Shell><Loading /></Shell>;
  const steps = r.steps;
  const step = steps[Math.min(idx, steps.length - 1)];
  const last = idx >= steps.length - 1;

  const startTimer = () => {
    const secs = (step.minutes || 1) * 60;
    setTotal(secs); setRemain(secs);
    clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setRemain((prev) => {
        if (prev === null) return prev;
        if (prev <= 1) {
          clearInterval(timerRef.current);
          toast(`${step.title} — time's up`, true);
          if (navigator.vibrate) navigator.vibrate([160, 90, 160]);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

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
    toast(`Plated in ${cookedMin} min — dinner logged`, true);
  };

  if (plated) {
    return (
      <Shell>
        <Title kick={`Cook mode · ${r.name}`}>Plated. Logged.</Title>
        <div style={{ display: 'flex', justifyContent: 'center', padding: '2px 0' }}>
          <PlateFig id={r.platefig} size={140} />
        </div>
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
            <span className="mname"><b>Dinner logged — your plate</b>
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

      <h2 className="title" style={{ fontSize: 24 }}>{step.title}</h2>
      <div className="bigsub">{step.detail}</div>

      {step.timer && (
        <div className="ringcook">
          <svg viewBox="0 0 140 140" width="158" height="158">
            <circle cx="70" cy="70" r="56" fill="none" stroke="var(--sunken)" strokeWidth="7" />
            {remain !== null && total > 0 && (
              <circle cx="70" cy="70" r="56" fill="none" stroke="var(--volt)" strokeWidth="7"
                strokeLinecap="round" transform="rotate(-90 70 70)"
                strokeDasharray={`${(remain / total) * RING_C} ${RING_C}`} />
            )}
            <text x="70" y="74" textAnchor="middle" className="ringnum num">
              {remain !== null ? fmtT(remain) : fmtT((step.minutes || 1) * 60)}
            </text>
            <text x="70" y="92" textAnchor="middle" className="ringcap">
              {remain !== null ? (remain === 0 ? 'done' : `of ${step.minutes}:00`) : `${step.minutes} min`}
            </text>
          </svg>
          {remain === null ? (
            <button className="ghost press" style={{ maxWidth: 220 }} onClick={startTimer}>
              Start the {step.minutes}-minute timer
            </button>
          ) : (
            <div className="sub">A local timer, same as your rest ring — it chimes here, no push.</div>
          )}
        </div>
      )}

      <div className="btnrow" style={{ marginTop: 'auto' }}>
        {idx > 0 && (
          <button className="ghost press" style={{ flex: 1 }} onClick={() => setIdx(idx - 1)}>
            ‹ {steps[idx - 1].title}
          </button>
        )}
        <button className="cta press" style={{ flex: 1.5 }} onClick={() => (last ? finish() : setIdx(idx + 1))}>
          {last ? 'Plate & log dinner' : `${steps[idx + 1].title} ›`}
        </button>
      </div>
    </Shell>
  );
}
