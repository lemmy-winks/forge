import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { api, fmtLoad, fmtT, kgDisp, loadUnitFor, todayISO, type FoodWeek, type ProposalResp, type Today, type WeekResp } from '../api';
import { MuscleMap } from '../musclemap';
import { useFoodWeek } from './food';
import { Back, Chip, Loading, Shell, Title, toast, useApp } from '../ui';

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

export function PlanScreen() {
  const { go, openTab, resumeSession } = useApp();
  const qc = useQueryClient();
  const q = useQuery<WeekResp>({ queryKey: ['week'], queryFn: () => api('/api/week') });
  const pq = useQuery<ProposalResp>({ queryKey: ['proposal'], queryFn: () => api('/api/proposal') });
  const fw = useFoodWeek();
  const [noteOpen, setNoteOpen] = useState(false);
  const [dangOpen, setDangOpen] = useState(false);
  const [saving, setSaving] = useState(false);
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

  const right = (d: WeekResp['days'][number]): string => {
    const s = d.session;
    if (s?.status === 'completed') {
      const st = s.stats || {};
      return s.kind === 'cardio'
        ? '✓ ' + [st.distance ? st.distance.toFixed(1) + ' km' : null,
                  st.duration_s ? fmtT(st.duration_s) : null].filter(Boolean).join(' · ')
        : `✓ ${st.tonnage ?? 0} t`;
    }
    if (s?.status === 'active') return 'in progress';
    if (d.kind === 'strength') return `~${d.est} min`;
    if (d.kind === 'cardio') return `${d.minutes ?? '?'} min`;
    return '';
  };

  const maxMin = Math.max(...w.days.map(dayMinutes), 30);
  const today = w.days.find((d) => d.is_today);
  const rest = w.days.filter((d) => !d.is_today);

  return (
    <Shell>
      <Title kick="Today + the six days ahead">Plan</Title>

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

      {/* the week's shape at a glance — bar height = time, solid = done */}
      <div className="weekstrip">
        {w.days.map((d) => {
          const min = dayMinutes(d);
          const done = d.session?.status === 'completed';
          return (
            <button key={d.date} className={'ws press' + (done ? ' done' : '') + (d.is_today ? ' today' : '')}
              aria-label={`${d.day_name}: ${d.name || 'rest'}`}
              onClick={() => go('day', { dayDate: d.is_today ? null : d.date })}>
              <span className="col">
                {min > 0 && <span className="fill" style={{ height: `${Math.round(22 + 78 * min / maxMin)}%` }} />}
              </span>
              <span className="d num">{d.day_name.slice(0, 2)}</span>
            </button>
          );
        })}
      </div>

      {w.rationale && (
        <button className="coachnote press" onClick={() => setNoteOpen(!noteOpen)}>
          <span className="kick" style={{ fontSize: 11 }}>Coach's note</span>
          <div className={noteOpen ? '' : 'clamp'} style={{ marginTop: 3 }}>{w.rationale}</div>
          <div className="more">{noteOpen ? 'less' : 'more'}</div>
        </button>
      )}

      {today && (
        <button className="herocard press" onClick={() => go('day', { dayDate: null })}>
          <div className="toprow">
            <span className="kick" style={{ fontSize: 11 }}>{today.day_name} · today</span>
            <span className="est num">{today.session?.status === 'completed' ? right(today)
              : dayMinutes(today) ? `~${dayMinutes(today)} min` : ''}</span>
          </div>
          <div className="hname">{today.name || 'Rest day'}</div>
          {today.focus.length > 0 && (
            <div className="fpills">{today.focus.map((f) => <span key={f} className="fpill">{f}</span>)}</div>
          )}
          {(() => {
            const din = dinnerFor(fw.data, today.date);
            if (!din) return null;
            return (
              <span className="dinline" role="link" tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation();
                  if (din.slug) go('recipe', { foodSlug: din.slug, foodDate: today.date });
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
      )}

      {rest.map((d) => {
        const done = d.session?.status === 'completed';
        return (
          <button key={d.date} className={'lrow press' + (d.kind === 'rest' && !d.session ? ' dimrow' : '')}
            onClick={() => go('day', { dayDate: d.date })}>
            <span className="glyphslot"><KindGlyph kind={d.session?.kind || d.kind} done={done} /></span>
            <span>
              <b>{d.day_name}</b>
              <span style={{ display: 'block', fontSize: 13, color: 'var(--mut)', marginTop: 2 }}>
                {d.name || 'Rest'}
                {(() => {
                  const din = dinnerFor(fw.data, d.date);
                  return din ? <span style={{ color: 'var(--dim)' }}>
                    {' · '}{din.slug && !din.label.includes('leftovers')
                      ? `dinner: ${din.label.split(',')[0].split(' —')[0].toLowerCase()}`
                      : din.label.includes('leftovers') ? 'dinner: leftovers' : din.label}
                  </span> : null;
                })()}
              </span>
            </span>
            <span className="rsub num" style={done ? { color: 'var(--volt)', fontWeight: 700 } : undefined}>
              {right(d)}
            </span>
            <span className="chev">›</span>
          </button>
        );
      })}
      <Chip>Tap a day to see it in full — you can run any strength day on today's date</Chip>

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
          </div>
        </div>
      )}
    </Shell>
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
function shiftISO(iso: string, days: number): string {
  return new Date(new Date(iso + 'T12:00:00Z').getTime() + days * 86400000).toISOString().slice(0, 10);
}

function budgetDefault(t?: Today): number {
  const full = t?.full_est || 50;
  return Math.min(75, Math.max(25, Math.ceil(full / 5) * 5));
}

export function DayScreen() {
  const { go, budget, setBudget, startSession, me, dayDate } = useApp();
  const [viewDate, setViewDate] = useState<string | null>(dayDate);
  const q = useToday(viewDate);
  const debounce = useRef<ReturnType<typeof setTimeout>>(undefined);
  const t = q.data;

  if (!t) return <Shell><Loading /></Shell>;

  const isOther = !!viewDate;
  const shift = (d: number) => {
    const next = shiftISO(viewDate || todayISO(), d);
    setViewDate(next === todayISO() ? null : next);
  };
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
