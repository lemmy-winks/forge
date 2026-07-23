import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { addDaysISO, api, fmtDur, fmtLoad, kgDisp, loadUnitFor, todayISO, weekStartISO, type FoodWeek, type ProposalResp, type Today, type WeekDay, type WeekResp } from '../api';
import { MuscleMap } from '../musclemap';
import { useFoodWeek } from './food';
import { Back, Chip, ConfirmSheet, Loading, Shell, Title, toast, useApp } from '../ui';

/** Tonight's (or a given date's) dinner from the food week — one quiet line on
    Plan; Plan stays a training screen. */
function dinnerFor(fw: FoodWeek | undefined, date: string):
    { label: string; minutes: number | null; slug: string | null } | null {
  const day = fw?.days.find((d) => d.date === date);
  const s = day?.slots.find((x) => x.slot === 'dinner');
  if (!s) return null;
  if (s.out) return { label: 'night out', minutes: null, slug: null };
  if (!s.recipe) return null;
  if (s.leftover) return { label: `${s.recipe.name} · leftovers`, minutes: null, slug: s.recipe.slug };
  return { label: s.recipe.name, minutes: s.recipe.minutes, slug: s.recipe.slug };
}

/* ---------------- Plan: the whole week, separated by day ---------------- */

/** Tiny kind marker so rows read at a glance without reading. */
function KindGlyph({ kind, done }: { kind: string; done?: boolean }) {
  const c = done ? 'var(--volt)' : 'var(--mut)';
  if (kind === 'cardio') {
    return (<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <polyline points="1,9 4.5,9 6.5,4 9,12 10.8,8 15,8" fill="none" stroke={c}
        strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" /></svg>);
  }
  if (kind === 'strength') {
    return (<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <line x1="4" y1="8" x2="12" y2="8" stroke={c} strokeWidth="1.6" />
      <rect x="1.2" y="4.5" width="2.4" height="7" rx="1" fill={c} />
      <rect x="12.4" y="4.5" width="2.4" height="7" rx="1" fill={c} /></svg>);
  }
  return (<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
    <circle cx="8" cy="8" r="2.2" fill={c} opacity=".45" /></svg>);
}

const dayMinutes = (d: WeekResp['days'][number]): number =>
  d.kind === 'strength' ? (d.est ?? 45) : d.kind === 'cardio' ? (d.minutes ?? 30) : 0;

/** How far ahead the Plan screen pages — enough to sketch the next month. */
const WEEKS_AHEAD = 4;

/** Day-of-month without a leading zero, for the strip and day rows. */
const dayNum = (iso: string): number => +iso.slice(8);

export function PlanScreen() {
  const { go, openTab, resumeSession } = useApp();
  const qc = useQueryClient();
  // weekStart: Monday of the viewed week; null = the current week
  const [weekStart, setWeekStart] = useState<string | null>(null);
  const curMonday = weekStartISO(todayISO());
  const start = weekStart || curMonday;
  const useWeekQ = (s: string) => useQuery<WeekResp>({
    queryKey: ['week', s],
    queryFn: () => api('/api/week?date=' + s),
    placeholderData: keepPreviousData,
  });
  // Three panes — the viewed week plus both neighbours — so a swipe drags real
  // content in rather than a loading flash.
  const q = useWeekQ(start);
  const qPrev = useWeekQ(addDaysISO(start, -7));
  const qNext = useWeekQ(addDaysISO(start, 7));
  const pq = useQuery<ProposalResp>({ queryKey: ['proposal'], queryFn: () => api('/api/proposal') });
  // food weeks for all three panes, so dinner lines slide along with their week
  const fw = useFoodWeek(weekStart);
  const fwPrev = useFoodWeek(addDaysISO(start, -7));
  const fwNext = useFoodWeek(addDaysISO(start, 7));
  const [noteOpen, setNoteOpen] = useState(false);
  const [dangOpen, setDangOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  // date whose planning sheet (future workouts & meals) is open
  const [planDate, setPlanDate] = useState<string | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; dx: number; mode: 'h' | 'v' | null } | null>(null);
  const anim = useRef(false);
  const w = q.data;
  const prop = pq.data?.proposal;
  if (!w) return <Shell><Loading /></Shell>;
  const dang = w.dangling;

  const saveIncomplete = async () => {
    if (!dang || saving) return;
    setSaving(true);
    try {
      const r = await api<{ stats: any }>(`/api/sessions/${dang.id}/complete`,
        { method: 'POST', body: { cooldown_status: 'skipped' } });
      toast(`Saved — ${r.stats.sets_done} sets banked. On to today.`, true);
      setDangOpen(false);
      qc.invalidateQueries({ queryKey: ['week'] });
      qc.invalidateQueries({ queryKey: ['history'] });
    } catch (e) { toast(String((e as Error).message)); }
    setSaving(false);
  };

  const discardDangling = async () => {
    if (!dang || saving) return;
    setSaving(true);
    try {
      await api(`/api/sessions/${dang.id}`, { method: 'DELETE' });
      toast('Workout discarded');
      setDiscardOpen(false);
      setDangOpen(false);
      qc.invalidateQueries({ queryKey: ['week'] });
      qc.invalidateQueries({ queryKey: ['history'] });
      qc.invalidateQueries({ queryKey: ['progress'] });
    } catch (e) { toast(String((e as Error).message)); }
    setSaving(false);
  };

  const right = (d: WeekResp['days'][number], today: string): string => {
    const s = d.session;
    if (s && (s.status === 'completed' || s.status === 'unplanned')) {
      const st = s.stats || {};
      const tick = s.status === 'completed' ? '✓ ' : '';
      return s.kind === 'cardio'
        ? tick + [st.distance ? st.distance.toFixed(1) + ' km' : null,
                  st.duration_s ? fmtDur(st.duration_s) : null].filter(Boolean).join(' · ')
        : `✓ ${st.tonnage ?? 0} t`;
    }
    if (s?.status === 'active') return 'in progress';
    if (d.date < today) return d.kind === 'rest' ? '' : 'missed';
    if (d.kind === 'strength') return `~${d.est} min`;
    if (d.kind === 'cardio') return `${d.minutes ?? '?'} min`;
    return '';
  };
  // a planned day that came and went with nothing logged
  const missed = (d: WeekResp['days'][number], today: string): boolean =>
    d.date < today && d.kind !== 'rest' && !(d.session && d.session.status !== 'active');

  const isCurrent = start === curMonday;
  const maxStart = addDaysISO(curMonday, 7 * WEEKS_AHEAD);
  const canNext = start < maxStart;
  const shiftWeek = (n: number) => {
    const next = addDaysISO(start, n * 7);
    if (next > maxStart) return;
    setWeekStart(next === curMonday ? null : next);
  };

  /* ----- swipeable week track: prev/cur/next panes, finger-tracked -----
     The track sits at translateX(-100%) (middle pane visible). A horizontal
     drag moves it 1:1 with the finger; release either settles back or slides
     one pane over, THEN commits the week change and snaps the reset track back
     to the middle in the same frame — so the animation is seamless. */
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
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;  // undecided — too small
      d.mode = Math.abs(dx) > Math.abs(dy) * 1.2 ? 'h' : 'v';
    }
    if (d.mode !== 'h') return;
    // rubber-band instead of dragging past the forward cap
    d.dx = dx < 0 && !canNext ? dx / 3 : dx;
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

  const weekOf = new Date(w.start + 'T12:00:00Z')
    .toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  const sheetDay = planDate ? w.days.find((d) => d.date === planDate) : undefined;

  /** One week of content — the strip, coach note, day cards and chip. Rendered
      three times (prev/cur/next) into the sliding track. */
  const pane = (wk: WeekResp | undefined, pos: 'prev' | 'cur' | 'next') => {
    if (!wk) return <div className="wpane" key={pos}><Loading /></div>;
    const maxMin = Math.max(...wk.days.map(dayMinutes), 30);
    const isFuture = wk.start > curMonday;
    const food = (pos === 'prev' ? fwPrev : pos === 'next' ? fwNext : fw).data;
    return (
      <div className="wpane" key={pos}>
        {/* the week's shape at a glance — bar height = time, solid = done */}
        <div className="weekstrip">
          {wk.days.map((d) => {
            const min = dayMinutes(d);
            const done = d.session?.status === 'completed';
            return (
              <button key={d.date} className={'ws press' + (done ? ' done' : '') + (d.is_today ? ' today' : '') + (missed(d, wk.today) ? ' miss' : '')}
                aria-label={`${d.day_name}: ${d.name || 'rest'}`}
                onClick={() => go('day', { dayDate: d.is_today ? null : d.date })}>
                <span className="col">
                  {min > 0 && <span className="fill" style={{ height: `${Math.round(22 + 78 * min / maxMin)}%` }} />}
                </span>
                <span className="d num">{d.day_name.slice(0, 2)}</span>
                <span className="dt num">{dayNum(d.date)}</span>
              </button>
            );
          })}
        </div>

        {wk.rationale && (
          <button className="coachnote press" onClick={() => setNoteOpen(!noteOpen)}>
            <span className="kick" style={{ fontSize: 11 }}>Coach's note</span>
            <div className={noteOpen ? '' : 'clamp'} style={{ marginTop: 3 }}>{wk.rationale}</div>
            <div className="more">{noteOpen ? 'less' : 'more'}</div>
          </button>
        )}

        {wk.days.map((d) => {
          const future = d.date > wk.today;
          // planned workouts/meals under the day card; future days get an add pill
          const dayplan = (d.planned.length > 0 || future) && (
            <div className="dayplan">
              {d.planned.map((p) => (
                <button key={p.id} className="dpill press" onClick={() => setPlanDate(d.date)}>
                  <span className={'pk' + (p.kind === 'meal' ? ' meal' : '')} />{p.title}
                </button>
              ))}
              {future && (
                <button className="dpill add press" aria-label={`Plan ${d.day_name} ${dayNum(d.date)}`}
                  onClick={() => setPlanDate(d.date)}>＋ plan</button>
              )}
            </div>
          );
          if (d.is_today) {
            return (
              <div key={d.date}>
                <button className="herocard today press" style={{ width: '100%' }}
                  onClick={() => go('day', { dayDate: null })}>
                  <div className="toprow">
                    <span className="kick" style={{ fontSize: 11, color: 'var(--volt)', display: 'flex', alignItems: 'center', gap: 7 }}>
                      <span className="pulse" />{d.day_name} {dayNum(d.date)} · today
                    </span>
                    <span className="est num">{d.session?.status === 'completed' ? right(d, wk.today)
                      : dayMinutes(d) ? `~${dayMinutes(d)} min` : ''}</span>
                  </div>
                  <div className="hname">{d.name || 'Rest day'}</div>
                  {d.focus.length > 0 && (
                    <div className="fpills">{d.focus.map((f) => <span key={f} className="fpill">{f}</span>)}</div>
                  )}
                  {(() => {
                    const din = dinnerFor(food, d.date);
                    if (!din) return null;
                    return (
                      <span className="dinline" role="link" tabIndex={0}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (din.slug) go('recipe', { foodSlug: din.slug, foodDate: d.date });
                          else go('food');
                        }}>
                        <span>◉ Tonight · {din.label}</span>
                        <span className="num" style={{ color: 'var(--volt)', fontWeight: 600 }}>
                          {din.minutes ? `${din.minutes} min ›` : '›'}
                        </span>
                      </span>
                    );
                  })()}
                </button>
                {dayplan}
              </div>
            );
          }
          const done = d.session?.status === 'completed';
          return (
            <div key={d.date}>
              <button className={'lrow press' + (d.kind === 'rest' && !d.session ? ' dimrow' : '')}
                style={{ width: '100%' }} onClick={() => go('day', { dayDate: d.date })}>
                <span className="glyphslot"><KindGlyph kind={d.session?.kind || d.kind} done={done} /></span>
                <span>
                  <b>{d.day_name} <span className="daynum num">{dayNum(d.date)}</span></b>
                  <span style={{ display: 'block', fontSize: 13, color: 'var(--mut)', marginTop: 2 }}>
                    {d.name || 'Rest'}
                    {(() => {
                      const din = dinnerFor(food, d.date);
                      return din ? <span style={{ color: 'var(--dim)' }}>
                        {' · '}{din.slug && !din.label.includes('leftovers')
                          ? `dinner: ${din.label.split(',')[0].split(' —')[0].toLowerCase()}`
                          : din.label.includes('leftovers') ? 'dinner: leftovers' : din.label}
                      </span> : null;
                    })()}
                  </span>
                </span>
                <span className="rsub num" style={done ? { color: 'var(--volt)', fontWeight: 700 }
                  : missed(d, wk.today) ? { color: 'var(--warn)', fontWeight: 600 } : undefined}>
                  {right(d, wk.today)}
                </span>
                <span className="chev">›</span>
              </button>
              {dayplan}
            </div>
          );
        })}
        <Chip>{isFuture
          ? 'Swipe to page weeks — pencil workouts and meals onto any future day'
          : "Tap a day to see it in full — you can run any strength day on today's date"}</Chip>
      </div>
    );
  };

  return (
    <Shell>
      <div className="swipeweeks" onTouchStart={onTouchStart} onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd} onTouchCancel={onTouchCancel}>
      <div className="row" style={{ alignItems: 'center' }}>
        <Title kick={isCurrent ? `This week · ${weekOf}` : `Week of ${weekOf}`}>Plan</Title>
        <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {!isCurrent && (
            <button className="press" style={{ fontSize: 12, color: 'var(--volt)', fontWeight: 700 }}
              onClick={() => setWeekStart(null)}>this week</button>
          )}
          <button className="ghost press" aria-label="Previous week"
            style={{ width: 34, padding: '6px 0' }} onClick={() => settle(-1)}>‹</button>
          <button className="ghost press" aria-label="Next week"
            disabled={!canNext}
            style={{ width: 34, padding: '6px 0' }} onClick={() => settle(1)}>›</button>
        </span>
      </div>

      {dang && (
        <button className="warnbanner press" onClick={() => setDangOpen(true)}>
          <span className="pulse" style={{ background: 'var(--warn)' }} />
          <b>Unfinished: {dang.day_name} · {dang.name}</b>
          <span className="num" style={{ color: 'var(--warn)', fontWeight: 700, fontSize: 13 }}>
            {dang.sets_done} {dang.sets_done === 1 ? 'set' : 'sets'} ›</span>
        </button>
      )}

      {prop && (
        <button className="propbanner press" onClick={() => openTab('coach')}>
          <span className="pulse" />
          <b>Next week proposed — awaiting your approval</b>
          <span style={{ color: 'var(--volt)', fontWeight: 700, fontSize: 13 }}>Review ›</span>
        </button>
      )}

      {/* prev/cur/next week panes in a sliding track; the wrapper clips it */}
      <div className="wclip">
        <div className="wtrack" ref={trackRef} style={{ transform: 'translateX(-100%)' }}>
          {pane(qPrev.data, 'prev')}
          {pane(q.data, 'cur')}
          {pane(qNext.data, 'next')}
        </div>
      </div>

      </div>

      {sheetDay && (
        <PlanSheet day={sheetDay} days={w.days} onClose={() => setPlanDate(null)} />
      )}

      {dangOpen && dang && (
        <div className="overlay" onClick={() => setDangOpen(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h3>Unfinished workout</h3>
            <div className="sub" style={{ marginTop: 0 }}>
              You started <b style={{ color: 'var(--ink)' }}>{dang.name}</b> on {dang.day_name} and
              logged <span className="num">{dang.sets_done}</span> {dang.sets_done === 1 ? 'set' : 'sets'}.
              Pick it back up, or save it as-is and move on — the sets you did still count.
            </div>
            <button className="cta press" disabled={saving} onClick={saveIncomplete}>
              {saving ? 'Saving…'
                : `Save as incomplete · keep ${dang.sets_done} ${dang.sets_done === 1 ? 'set' : 'sets'}`}
            </button>
            <button className="ghost press" disabled={saving}
              onClick={() => { setDangOpen(false); resumeSession(dang.id, dang.date); }}>
              Resume this workout now
            </button>
            <button className="press" disabled={saving} onClick={() => setDiscardOpen(true)}
              style={{ fontSize: 13, color: 'var(--warn)', fontWeight: 600, padding: '4px 0' }}>
              Discard this workout
            </button>
          </div>
        </div>
      )}

      {discardOpen && dang && (
        <ConfirmSheet
          title="Discard this workout?"
          body={<>This permanently deletes <b style={{ color: 'var(--ink)' }}>{dang.name}</b> and the{' '}
            <span className="num">{dang.sets_done}</span> {dang.sets_done === 1 ? 'set' : 'sets'} you logged.
            This can't be undone.</>}
          confirmLabel="Discard workout" cancelLabel="Keep it" danger busy={saving}
          onConfirm={discardDangling} onCancel={() => setDiscardOpen(false)} />
      )}
    </Shell>
  );
}

/* ---------------- Future-day planning sheet (workouts & meals) ---------------- */

function PlanSheet({ day, days, onClose }: { day: WeekDay; days: WeekDay[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [kind, setKind] = useState<'workout' | 'meal'>('workout');
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [planDay, setPlanDay] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nice = new Date(day.date + 'T12:00:00Z')
    .toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' });
  // the active plan's training days, as one-tap templates for future workouts
  const templates = days.filter((d) => d.kind !== 'rest' && d.name)
    .map((d) => ({ key: planDayKey(d.date), name: d.name as string }));

  const refresh = () => qc.invalidateQueries({ queryKey: ['week'] });
  const add = async () => {
    if (busy) return;
    if (!title.trim() && !(kind === 'workout' && planDay)) { toast('Give it a name'); return; }
    setBusy(true);
    try {
      await api('/api/plan-items', { method: 'POST',
        body: { date: day.date, kind, title: title.trim(), notes: notes.trim(),
                plan_day: kind === 'workout' ? planDay : null } });
      toast('Pencilled in', true);
      setTitle(''); setNotes(''); setPlanDay(null);
      refresh();
    } catch (e) { toast(String((e as Error).message)); }
    setBusy(false);
  };
  const remove = async (id: string) => {
    try { await api(`/api/plan-items/${id}`, { method: 'DELETE' }); refresh(); }
    catch (e) { toast(String((e as Error).message)); }
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <h3>Plan {nice}</h3>
        {day.planned.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {day.planned.map((p) => (
              <div key={p.id} className="dprow">
                <span className={'pk' + (p.kind === 'meal' ? ' meal' : '')} />
                <span style={{ flex: 1 }}>
                  <b>{p.title}</b>
                  {p.notes && <span style={{ display: 'block', fontSize: 12.5, color: 'var(--mut)' }}>{p.notes}</span>}
                </span>
                <button className="press" style={{ color: 'var(--mut)', fontSize: 13 }}
                  onClick={() => remove(p.id)}>remove</button>
              </div>
            ))}
          </div>
        )}
        <div className="seg">
          <button className={'press' + (kind === 'workout' ? ' sel' : '')}
            onClick={() => setKind('workout')}>Workout</button>
          <button className={'press' + (kind === 'meal' ? ' sel' : '')}
            onClick={() => { setKind('meal'); setPlanDay(null); }}>Meal</button>
        </div>
        {kind === 'workout' && templates.length > 0 && (
          <div className="fpills" style={{ marginTop: 0 }}>
            {templates.map((t) => (
              <button key={t.key} className={'fpill press' + (planDay === t.key ? ' on' : '')}
                onClick={() => {
                  const on = planDay === t.key;
                  setPlanDay(on ? null : t.key);
                  setTitle(on ? '' : t.name);
                }}>{t.name}</button>
            ))}
          </div>
        )}
        <div className="field">
          <label>{kind === 'meal' ? 'Meal' : 'Workout'}</label>
          <input value={title} placeholder={kind === 'meal' ? 'Sunday roast · high protein' : 'Long Zone-2 ride'}
            onChange={(e) => { setTitle(e.target.value); setPlanDay(null); }} />
        </div>
        <div className="field">
          <label>Notes</label>
          <input value={notes} placeholder="optional" onChange={(e) => setNotes(e.target.value)} />
        </div>
        <button className="cta press" disabled={busy} onClick={add}>
          {busy ? 'Saving…' : `Add to ${day.day_name}`}
        </button>
        <button className="ghost press" onClick={onClose}>Done</button>
      </div>
    </div>
  );
}

export function useToday(date?: string | null) {
  const { budget } = useApp();
  return useQuery<Today>({
    queryKey: ['today', budget, date || 'today'],
    queryFn: () => {
      const params = new URLSearchParams();
      if (budget) params.set('budget', String(budget));
      if (date) params.set('date', date);
      const qs = params.toString();
      return api('/api/today' + (qs ? '?' + qs : ''));
    },
    placeholderData: keepPreviousData,
  });
}

/** Python-style weekday key ("0"=Mon .. "6"=Sun) for an ISO date. */
function planDayKey(iso: string): string {
  return String((new Date(iso + 'T12:00:00Z').getUTCDay() + 6) % 7);
}

function budgetDefault(t?: Today): number {
  const full = t?.full_est || 50;
  return Math.min(75, Math.max(25, Math.ceil(full / 5) * 5));
}

/** Swipe left/right (and ←/→ on a keyboard) pages the day view through the
    calendar — the same navigation as the ‹ › buttons. Vertical scrolls and
    drags that start on inputs (the budget slider) never trigger it. */
function useDayPaging(shift: (d: number) => void) {
  const fn = useRef(shift);
  fn.current = shift;
  useEffect(() => {
    let sx = 0, sy = 0, live = false;
    const start = (e: TouchEvent) => {
      const el = e.target as HTMLElement;
      live = !el.closest('input, textarea, .overlay');
      sx = e.touches[0].clientX; sy = e.touches[0].clientY;
    };
    const end = (e: TouchEvent) => {
      if (!live) return;
      live = false;
      const dx = e.changedTouches[0].clientX - sx;
      const dy = e.changedTouches[0].clientY - sy;
      if (Math.abs(dx) > 60 && Math.abs(dx) > 2 * Math.abs(dy)) fn.current(dx < 0 ? 1 : -1);
    };
    const key = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el?.closest?.('input, textarea')) return;
      if (e.key === 'ArrowRight') fn.current(1);
      else if (e.key === 'ArrowLeft') fn.current(-1);
    };
    document.addEventListener('touchstart', start, { passive: true });
    document.addEventListener('touchend', end, { passive: true });
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('touchstart', start);
      document.removeEventListener('touchend', end);
      document.removeEventListener('keydown', key);
    };
  }, []);
}

export function DayScreen() {
  const { go, budget, setBudget, startSession, me, dayDate } = useApp();
  const [viewDate, setViewDate] = useState<string | null>(dayDate);
  const q = useToday(viewDate);
  const debounce = useRef<ReturnType<typeof setTimeout>>(undefined);
  const t = q.data;

  // Anchor paging on the server's idea of today (Europe/London), not the
  // device clock — around midnight they disagree and ± would skip a day.
  const srvToday = useRef(todayISO());
  if (!viewDate && t) srvToday.current = t.date;
  const shift = (d: number) => {
    const next = addDaysISO(viewDate || srvToday.current, d);
    setViewDate(next === srvToday.current ? null : next);
  };
  useDayPaging(shift);

  if (!t) return <Shell><Loading /></Shell>;

  const isOther = !!viewDate;
  const head = (
    <div className="row" style={{ alignItems: 'center' }}>
      <div>
        <Back label="Plan" onClick={() => go('today')} />
        <Title kick={`${t.day_name} · ${t.date}${isOther ? '' : ' · today'}`}>
          {t.kind === 'rest' ? 'Rest day' : t.name || 'Today'}
        </Title>
      </div>
      <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        {isOther && (
          <button className="press" style={{ fontSize: 12, color: 'var(--volt)', fontWeight: 700 }}
            onClick={() => setViewDate(null)}>today</button>
        )}
        <button className="ghost press" aria-label="Previous day"
          style={{ width: 34, padding: '6px 0' }} onClick={() => shift(-1)}>‹</button>
        <button className="ghost press" aria-label="Next day"
          style={{ width: 34, padding: '6px 0' }} onClick={() => shift(1)}>›</button>
      </span>
    </div>
  );

  if (t.kind === 'rest') {
    const r = t.recovery || { sleep_h: null, weight: null, resting_hr: null };
    return (
      <Shell>
        {head}
        <Chip>Recovery is training — a walk is fine if you're restless</Chip>
        <div className="tiles">
          <div className="tile"><div className="k">Last night</div>
            <div className="v disp num">{r.sleep_h ? r.sleep_h.value.toFixed(1) : '—'}<small> h</small></div>
            <div className="d">sleep · Apple Health</div></div>
          <div className="tile"><div className="k">Weight</div>
            <div className="v disp num">{r.weight ? kgDisp(r.weight.value, me.units) : '—'}</div>
            <div className="d">latest reading</div></div>
          <div className="tile"><div className="k">Resting HR</div>
            <div className="v disp num">{r.resting_hr ? Math.round(r.resting_hr.value) + ' bpm' : '—'}</div>
            <div className="d">latest</div></div>
          <div className="tile"><div className="k">Tomorrow</div>
            <div className="v disp" style={{ fontSize: 16, lineHeight: 1.3, marginTop: 6 }}>{t.tomorrow?.name || '—'}</div>
            <div className="d">{t.tomorrow?.day_name || ''}</div></div>
        </div>
      </Shell>
    );
  }

  if (t.kind === 'cardio') {
    const c = t.cardio || { minutes: 0, hr_low: 0, hr_high: 0, type: 'run' };
    return (
      <Shell>
        {head}
        <Chip>{c.note || 'Recorded on your Watch; syncs via Health Auto Export'}</Chip>
        <div className="card">
          <div className="row"><span className="xname">Prescribed</span>
            <span className="target num">{c.minutes} min · HR {c.hr_low}–{c.hr_high}</span></div>
          <div className="sub">Start it from your Watch — it lands in History automatically</div>
        </div>
        <div className="fchips">{(t.focus || []).map((f) => <span key={f} className="fchip">{f}</span>)}</div>
      </Shell>
    );
  }

  // strength
  const sess = t.session;
  const done = sess?.status === 'completed';
  const active = sess?.status === 'active';
  const bud = budget ?? budgetDefault(t);
  const pct = ((bud - 25) / 50) * 100;
  const exercises = t.exercises || [];
  const trimText = t.trims?.length
    ? `Fits ${bud} min: ${t.trims.join(' · ')} — main lift untouched.`
    : 'Full session fits — nothing trimmed.';

  const onBudget = (v: number) => {
    setBudget(v);
    clearTimeout(debounce.current);
    debounce.current = setTimeout(() => q.refetch(), 250);
  };

  return (
    <Shell>
      {head}
      {done && (
        <div className="banner">
          {sess?.stats?.partial
            ? `◐ ${t.name} saved incomplete — ${sess.stats.sets_done} of ${sess.stats.sets_planned} sets, ${sess.stats.tonnage ?? 0} t.`
            : `✓ ${t.name} complete — ${sess?.stats?.tonnage ?? 0} t lifted.`}
        </div>
      )}
      {!done && t.rationale && <Chip>{t.rationale}</Chip>}
      {!done && (
        <div className="card">
          <div className="mhead">
            <div>
              <div className="xname">Plan for today</div>
              <div className="sub num" style={{ marginTop: 4 }}>
                {exercises.filter((e) => !e.dropped).length} exercises · {exercises.reduce((x, e) => x + e.sets, 0)} sets
                {' · '}<b style={{ color: 'var(--volt)', whiteSpace: 'nowrap' }}>~{t.est} min</b>
              </div>
              <div className="fpills" style={{ marginTop: 8 }}>
                {(t.focus || []).map((f) => <span key={f} className="fpill">{f}</span>)}
              </div>
              <div className="sub num">{t.tonnage_est} t · {t.cd === 'short' ? '2' : '5'}-min cool-down</div>
            </div>
            {t.muscles && (t.muscles.primary.length > 0 || t.muscles.secondary.length > 0) && (
              <MuscleMap primary={t.muscles.primary} secondary={t.muscles.secondary} />
            )}
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <span className="kick" style={{ fontSize: 11 }}>Time available</span>
            <b className="num">{bud} min</b>
          </div>
          <input type="range" min={25} max={75} step={5} value={bud}
            style={{ ['--pct' as string]: pct + '%' }}
            aria-label="Time available today, minutes"
            onChange={(e) => onBudget(+e.target.value)} />
          <div className={'sub' + (t.trims?.length ? ' warn' : '')} style={{ marginTop: 2 }}>{trimText}</div>
        </div>
      )}
      {exercises.map((e) => {
        const u = loadUnitFor(me.prefs, e.slug);
        return (
          <button key={e.slug} className="tap press" onClick={() => go('learn', { learnSlug: e.slug, learnFrom: 'day' })}>
            <div className={'card' + (!done && e.dropped ? ' dimrow' : '')}>
              <div className="row"><span className="xname">{e.name}</span>
                <span className="target num">
                  {done ? '✓ done' : e.dropped ? 'not today' : `${e.sets}×${e.reps}${e.weight ? ` · ${fmtLoad(e.weight, u)}` : ''}`}
                </span></div>
              <div className="sub num">
                {e.last
                  ? e.last.weight
                    ? `Last: ${fmtLoad(e.last.weight, u)} × ${e.last.reps.join('/')}`
                    : `Last: ${e.last.reps.join('/')} reps`
                  : 'First time — be conservative'}
                {' · '}<span style={{ color: 'var(--volt)' }}>form ▶</span>
              </div>
            </div>
          </button>
        );
      })}
      {isOther ? (
        <>
          {done && sess && (
            <button className="ghost press" onClick={() => go('detail', { detailId: sess.id })}>
              Session detail
            </button>
          )}
          <button className="cta mt press" onClick={() => startSession(t, planDayKey(t.date))}>
            Do this workout today · ~{t.est} min
          </button>
        </>
      ) : done ? (
        <button className="ghost press" onClick={() => go('detail', { detailId: sess!.id })}>Session detail</button>
      ) : (
        <button className="cta mt press" onClick={() => startSession(t)}>
          {active ? 'Resume session' : `Start session · ~${t.est} min`}
        </button>
      )}
    </Shell>
  );
}
