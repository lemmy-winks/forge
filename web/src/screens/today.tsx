import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { api, fmtLoad, fmtT, kgDisp, loadUnitFor, todayISO, type Today, type WeekResp } from '../api';
import { Back, Chip, Loading, Shell, Title, useApp } from '../ui';

/* ---------------- Plan: the whole week, separated by day ---------------- */
export function PlanScreen() {
  const { go } = useApp();
  const q = useQuery<WeekResp>({ queryKey: ['week'], queryFn: () => api('/api/week') });
  const w = q.data;
  if (!w) return <Shell><Loading /></Shell>;

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

  return (
    <Shell>
      <Title kick="Today + the six days ahead">Plan</Title>
      {w.rationale && <Chip>{w.rationale}</Chip>}
      {w.days.map((d) => {
        const done = d.session?.status === 'completed';
        const emphasis = d.is_today
          ? { background: 'var(--raised)', borderRadius: 16, borderTop: 0, padding: '13px 15px' }
          : undefined;
        return (
          <button key={d.date} className={'lrow press' + (d.kind === 'rest' && !d.session ? ' dimrow' : '')}
            style={emphasis}
            onClick={() => go('day', { dayDate: d.is_today ? null : d.date })}>
            <span>
              <b>{d.day_name}{d.is_today ? ' · today' : ''}</b>
              <span style={{ display: 'block', fontSize: 12, color: 'var(--mut)', marginTop: 2 }}>
                {d.name || 'Rest'}{d.focus.length ? ' · ' + d.focus.join(' · ') : ''}
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
          <button className="press" style={{ fontSize: 11, color: 'var(--volt)', fontWeight: 700 }}
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
            <div className="v disp" style={{ fontSize: 15, lineHeight: 1.3, marginTop: 6 }}>{t.tomorrow?.name || '—'}</div>
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
      {done && <div className="banner">✓ {t.name} complete — {sess?.stats?.tonnage ?? 0} t lifted.</div>}
      {!done && t.rationale && <Chip>{t.rationale}</Chip>}
      {!done && (
        <div className="card">
          <div className="row"><span className="xname">Plan for today</span>
            <span className="target num">~{t.est} min · {exercises.reduce((x, e) => x + e.sets, 0)} sets</span></div>
          <div className="sub num">
            Focus <span className="fchips" style={{ display: 'inline-flex', verticalAlign: 'middle', margin: '0 2px' }}>
              {(t.focus || []).map((f) => <span key={f} className="fchip">{f}</span>)}
            </span> · {t.tonnage_est} t · {t.cd === 'short' ? '2' : '5'}-min cool-down
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <span className="kick" style={{ fontSize: 10 }}>Time available</span>
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
                {e.last ? `Last: ${fmtLoad(e.last.weight, u)} × ${e.last.reps.join('/')}` : 'First time — be conservative'}
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
