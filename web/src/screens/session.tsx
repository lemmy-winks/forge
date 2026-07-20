import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import {
  api, dispToKg, fmtLoad, fmtT, loadUnitFor, plateStr,
  type Alternative, type ExerciseDetail, type LoadUnit, type Me, type Pb,
} from '../api';
import { FormFig } from '../formfig';
import { queuedPost } from '../queue';
import { Back, Chip, Loading, Shell, Title, curTarget, toast, useApp } from '../ui';
import { useToday } from './today';

/** RPE → reps in reserve, the question a lifter can actually answer mid-session. */
const RPE_LEFT: Record<number, string> = { 6: '4+ left', 7: '3 left', 8: '2 left', 9: '1 left', 10: '0 left' };

function warmupsFor(t: { kind: string; priority: number; weight: number }, bar?: number):
    [number, number][] | null {
  if (t.kind !== 'bb' || t.priority !== 1 || t.weight < 50 || bar === undefined) return null;
  const rd = (x: number) => Math.round(x / 2.5) * 2.5;
  return [[bar, 10], [rd(t.weight * 0.5), 8], [rd(t.weight * 0.7), 5], [rd(t.weight * 0.85), 3]];
}

export function LogScreen() {
  const { log, logDispatch, go, me } = useApp();
  const qc = useQueryClient();
  const todayQ = useToday();
  const [, setNow] = useState(0);
  // form animation mid-session: opt-in, sticky across sessions
  const [showForm, setShowForm] = useState(() => localStorage.getItem('forge-show-form') === '1');
  const toggleForm = () => {
    const next = !showForm;
    setShowForm(next);
    localStorage.setItem('forge-show-form', next ? '1' : '0');
  };

  useEffect(() => {
    const iv = setInterval(() => { setNow(Date.now()); logDispatch({ type: 'tick' }); }, 1000);
    return () => clearInterval(iv);
  }, [logDispatch]);

  // cues feed the animation's caption; cached per exercise, fetched only when shown
  const curSlug = log ? curTarget(log).slug : '';
  const exQ = useQuery<ExerciseDetail>({
    queryKey: ['exercise', curSlug],
    queryFn: () => api('/api/exercises/' + curSlug),
    staleTime: Infinity,
    enabled: showForm && !!curSlug,
  });

  if (!log) return <Shell><Chip>No active session — start one from Today.</Chip></Shell>;

  const t = curTarget(log);
  const orig = log.targets[log.idx];
  const profile = todayQ.data?.profile || null;
  const doneSets = log.done[t.slug] || [];
  const allDone = doneSets.length >= t.sets;
  const lastEx = log.idx === log.targets.length - 1;
  const remSets = log.targets.reduce((x, tt) => {
    const slug = log.swaps[tt.slug]?.slug || tt.slug;
    return x + Math.max(0, tt.sets - (log.done[slug] || []).length);
  }, 0);
  const elapsed = Math.floor((Date.now() - log.t0) / 1000);
  const wu = !log.wu[t.slug] && doneSets.length === 0 ? warmupsFor(orig, profile?.bar_kg) : null;
  const wKg = dispToKg(log.w, t.unit); // canonical — everything stored is kg
  const plate = plateStr(t.kind, wKg, profile);

  const setUnit = (u: LoadUnit) => {
    if (u === t.unit) return;
    logDispatch({ type: 'unit', u });
    const load_units = { ...(me.prefs?.load_units || {}), [t.slug]: u };
    qc.setQueryData<Me>(['me'], (old) => old && { ...old, prefs: { ...old.prefs, load_units } });
    api('/api/prefs', { method: 'PATCH', body: { prefs: { load_units } } }).catch(() => {});
  };

  const logSet = async () => {
    const set = { weight: wKg, reps: log.r, rpe: log.rpe };
    const moreLeft = doneSets.length + 1 < t.sets;
    logDispatch({ type: 'logged', slug: t.slug, set, rest: t.rest || 90, moreLeft });
    const res = await queuedPost<{ pbs: Pb[] }>(`/api/sessions/${log.sid}/sets`, {
      slug: t.slug, substituted_for: t.substituted_for || null,
      set_no: doneSets.length + 1, weight: set.weight, reps: set.reps, rpe: set.rpe,
    }).catch((e) => { toast(String(e.message)); return null; });
    if (res?.pbs?.length) {
      logDispatch({ type: 'pbs', pbs: res.pbs });
      toast(`New record — ${res.pbs[0].kind.replace('_', ' ')} ${fmtLoad(res.pbs[0].value, t.unit)}`, true);
    }
  };

  return (
    <Shell>
      <div>
        <span className="kick">Exercise {log.idx + 1} of {log.targets.length}</span>
        <h2 className="title">
          <button className="press" onClick={() => go('learn', { learnSlug: t.slug, learnFrom: 'log' })}>
            {t.name} <span style={{ fontSize: 13, color: 'var(--volt)' }}>▶</span>
          </button>
        </h2>
      </div>
      <div className="chip num"><span className="dot" />
        Target {t.sets}×{t.reps}{t.weight ? ` · ${fmtLoad(t.weight, t.unit)}` : ''} · rest {fmtT(t.rest || 90)} ·{' '}
        {fmtT(elapsed)} elapsed · ~{remSets * 2} min left
      </div>
      <div style={{ display: 'flex', gap: 16 }}>
        <button className="press" onClick={() => go('swap')}
          style={{ fontSize: 11.5, color: 'var(--volt)', fontWeight: 600, padding: '0 2px' }}>
          Equipment taken? Swap ↺{log.swaps[orig.slug] ? ' · substituted' : ''}
        </button>
        <button className="press" onClick={toggleForm}
          style={{ fontSize: 11.5, color: showForm ? 'var(--mut)' : 'var(--volt)', fontWeight: 600, padding: '0 2px' }}>
          {showForm ? 'Hide form ✕' : 'Show form ▶'}
        </button>
      </div>
      {showForm && <FormFig slug={t.slug} name={t.name} cues={exQ.data?.cues || []} />}
      {wu && (
        <div className="card">
          <div className="kick" style={{ fontSize: 9.5, marginBottom: 6 }}>Warm-up ramp</div>
          {wu.map(([w, r], i) => (
            <div key={i} className="row num" style={{ padding: '3px 0' }}>
              <span className="sub" style={{ margin: 0 }}>{fmtLoad(w, t.unit)}</span>
              <span className="sub" style={{ margin: 0 }}>× {r}</span>
            </div>
          ))}
          <button className="ghost press" style={{ marginTop: 8, padding: 8 }}
            onClick={() => logDispatch({ type: 'wuDone' })}>Warm-ups done ✓</button>
        </div>
      )}
      {doneSets.map((s, i) => (
        <div key={i} className="setline num"><span className="lbl">Set {i + 1}</span>
          <span className="v">{t.weight ? `${fmtLoad(s.weight, t.unit)} × ` : '×'}{s.reps}{s.rpe ? ` · RPE ${s.rpe}` : ''}</span>
          <span className="tick">✓</span></div>
      ))}
      {!allDone && (
        <div className="active-set">
          {(t.weight > 0 || t.kind !== 'bw') && (
            <>
              <div className="stepper">
                <span className="lab">Set {doneSets.length + 1} · Weight</span>
                <span className="seg" style={{ padding: 2 }}>
                  {(['lb', 'kg'] as const).map((u) => (
                    <button key={u} className={t.unit === u ? 'sel' : ''}
                      style={{ fontSize: 11, padding: '3px 10px', flex: 'none' }}
                      onClick={() => setUnit(u)}>{u}</button>
                  ))}
                </span>
                <div className="pm">
                  <button onClick={() => logDispatch({ type: 'w', d: -1 })}>−</button>
                  <span className="v disp num">{log.w}</span>
                  <button onClick={() => logDispatch({ type: 'w', d: 1 })}>+</button>
                </div></div>
              {plate && <div className="sub num" style={{ margin: 0 }}>{plate}</div>}
            </>
          )}
          <div className="stepper"><span className="lab">Reps</span>
            <div className="pm">
              <button onClick={() => logDispatch({ type: 'r', d: -1 })}>−</button>
              <span className="v disp num">{log.r}</span>
              <button onClick={() => logDispatch({ type: 'r', d: 1 })}>+</button>
            </div></div>
          <div>
            <span className="lab">How hard was that? · reps you had left</span>
            <div className="rpe" style={{ marginTop: 6 }}>
              {[6, 7, 8, 9, 10].map((n) => (
                <button key={n} className={(log.rpe === n ? 'sel ' : '') + 'num'}
                  onClick={() => logDispatch({ type: 'rpe', n })}>
                  <b>{n}</b><small>{RPE_LEFT[n]}</small>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      {log.goFlag && !allDone && <div className="banner">Rested — go: set {doneSets.length + 1}</div>}
      {log.remain > 0 && (
        <div className="resty">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <svg width="48" height="48" viewBox="0 0 48 48" aria-hidden="true">
              <circle cx="24" cy="24" r="20" fill="none" stroke="var(--hair)" strokeWidth="4" />
              <circle cx="24" cy="24" r="20" fill="none" stroke="var(--volt)" strokeWidth="4"
                strokeLinecap="round" strokeDasharray="125.7"
                strokeDashoffset={(125.7 * (1 - log.remain / (t.rest || 90))).toFixed(1)}
                transform="rotate(-90 24 24)" />
            </svg>
            <div><div className="t disp num">{fmtT(log.remain)}</div>
              <div className="cap">Rest · target {fmtT(t.rest || 90)}</div></div>
          </div>
          <button className="ghost press" style={{ width: 'auto', padding: '8px 14px' }}
            onClick={() => logDispatch({ type: 'skipRest' })}>Skip</button>
        </div>
      )}
      <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {!allDone
          ? <button className="cta press" onClick={logSet}>Log set {doneSets.length + 1}</button>
          : lastEx
            ? <button className="cta press" onClick={() => go('cooldown')}>Cool-down →</button>
            : <button className="cta press" onClick={() => logDispatch({ type: 'next' })}>
                Next: {log.targets[log.idx + 1].name}</button>}
      </div>
    </Shell>
  );
}

export function SwapScreen() {
  const { log, logDispatch, go } = useApp();
  const orig = log ? log.targets[log.idx] : null;
  const altsQ = useQuery<Alternative[]>({
    queryKey: ['alts', orig?.slug],
    queryFn: () => api(`/api/exercises/${orig!.slug}/alternatives`),
    enabled: !!orig,
  });
  if (!log || !orig) return <Shell><Chip>No active session.</Chip></Shell>;
  const alts = altsQ.data;
  const swapped = log.swaps[orig.slug];

  return (
    <Shell>
      <Back label="Back" onClick={() => go('log')} />
      <Title kick="Same muscles · your equipment">Swap {orig.name}</Title>
      {swapped && (
        <button className="lrow press" onClick={() => { logDispatch({ type: 'swapBack' }); go('log'); }}>
          <b>↺ Back to {orig.name}</b><span className="rsub">original prescription</span>
        </button>
      )}
      {!alts && <Loading />}
      {alts?.map((a) => a.excluded ? (
        <div key={a.slug} className="lrow dimrow"><b>{a.name}</b><span className="rsub">{a.why}</span></div>
      ) : (
        <button key={a.slug} className="lrow press"
          onClick={() => { logDispatch({ type: 'swap', alt: { slug: a.slug, name: a.name, kind: a.kind } }); go('log'); }}>
          <b>{a.name}{swapped?.slug === a.slug ? ' ✓' : ''}</b>
          <span className="rsub">{a.why}</span>
        </button>
      ))}
      {alts && !alts.length && <Chip>No suitable alternatives in your current equipment profile.</Chip>}
      <Chip>Swaps are logged as substitutions — the coach sees the session still happened, and why</Chip>
    </Shell>
  );
}

export function CooldownScreen() {
  const { log, logDispatch, finishSession } = useApp();
  const noteRef = useRef<HTMLInputElement>(null);
  if (!log) return <Shell><Chip>No active session.</Chip></Shell>;
  const cdMin = log.fitted.cd === 'short' ? 2 : 5;
  const shown = log.fitted.cd === 'short' ? (log.fitted.cooldown || []).slice(0, 2) : (log.fitted.cooldown || []);
  const ticked = shown.filter((_, i) => log.cdDone[i]).length;

  return (
    <Shell>
      <Title kick={`Last stop · ${cdMin} min`}>Cool-down</Title>
      {shown.some((c) => c.why) && <Chip>Starred holds target your niggles — don't skip those</Chip>}
      {shown.map((c, i) => (
        <button key={i} className="lrow press" onClick={() => logDispatch({ type: 'cdTick', i })}>
          <b>{c.name || c.slug}{c.why ? ' ✳' : ''}</b>
          <span className="rsub">{c.hold || ''}{c.why ? <><br />{c.why}</> : null}</span>
          {log.cdDone[i] ? <span className="tick">✓</span> : <span className="chev">○</span>}
        </button>
      ))}
      <div className="field" style={{ marginTop: 6 }}>
        <label>Note for the coach</label>
        <input ref={noteRef} placeholder="Knee felt fine · grip gave out first…" />
      </div>
      <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <button className="cta press" onClick={() => finishSession(false, noteRef.current?.value || '')}>
          Finish session{ticked ? ` · ${ticked}/${shown.length} done` : ''}
        </button>
        <button className="ghost press" onClick={() => finishSession(true, noteRef.current?.value || '')}>
          Skip cool-down — coach will know
        </button>
      </div>
    </Shell>
  );
}

export function SummaryScreen() {
  const { summary: L, openTab, me, go } = useApp();
  if (!L) return <Shell><Chip>No session yet today.</Chip></Shell>;
  const stats = L.stats || {};
  return (
    <Shell>
      <Title kick={`${L.day} · ${L.name}`}>Session summary</Title>
      {L.pbs.map((p, i) => (
        <div key={i} className="banner">✓ {p.slug} {p.kind === 'e1rm' ? 'e1RM' : 'best set'}{' '}
          {fmtLoad(p.value, loadUnitFor(me.prefs, p.slug))} — new record</div>
      ))}
      <div className="tiles">
        <div className="tile"><div className="k">Duration</div>
          <div className="v disp num">{stats.duration_s ? fmtT(stats.duration_s) : '—'}</div>
          <div className="d num">vs ~{L.est} min planned</div></div>
        <div className="tile"><div className="k">Volume</div>
          <div className="v disp num">{stats.tonnage ?? 0} <small>t</small></div>
          <div className="d">lifted total</div></div>
        <div className="tile"><div className="k">Sets</div>
          <div className="v disp num">{stats.sets_done ?? 0}<small>/{stats.sets_planned ?? 0}</small></div>
          <div className="d">{(stats.sets_done ?? 0) >= (stats.sets_planned ?? 0) ? 'all done' : 'short — noted'}</div></div>
        <div className="tile"><div className="k">Avg RPE</div>
          <div className="v disp num">{stats.avg_rpe ?? '—'}</div>
          <div className="d">effort across sets</div></div>
      </div>
      {L.exercises.map((g, i) => (
        <div key={i} className="card num"><div className="row">
          <span className="xname">{g.name}{g.substituted_for && <small style={{ color: 'var(--mut)' }}> (sub)</small>}</span>
          <span className="target">
            {g.sets.map((s) => s.reps).join('/')}
            {g.sets[0]?.weight ? ` @ ${fmtLoad(g.sets[0].weight, loadUnitFor(me.prefs, g.slug))}` : ''}
          </span></div></div>
      ))}
      <div className="card"><div className="row"><span className="xname">Cool-down</span>
        <span className="target num">{L.cooldown_status === 'done' ? '✓ done' : L.cooldown_status}</span></div>
        {L.cooldown_status === 'skipped' && <div className="sub warn">Skipped — noted for the review</div>}
      </div>
      <button className="ghost press" onClick={() =>
        go('coach', { chatContext: { kind: 'session', id: L.sid, label: `${L.day} · ${L.name}` } })}>
        Debrief with the coach — how did it feel?
      </button>
      <button className="cta press" onClick={() => openTab('today')}>Done</button>
    </Shell>
  );
}
