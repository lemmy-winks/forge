import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import {
  api, ApiError, dispToKg, fmtLoad, fmtT, isTimed, kgToDisp, loadUnitFor, plateStr,
  type Alternative, type ExerciseDetail, type LoadUnit, type Me, type Pb,
} from '../api';
import { FormFig } from '../formfig';
import { queuedPost } from '../queue';
import { Back, Chip, Loading, Shell, Title, curTarget, toast, useApp } from '../ui';
import { useToday } from './today';

/** Effort slider copy: qualitative first, reps-in-reserve as the anchor.
    Indexed 1–10; the text under the slider follows the thumb. */
const RPE_TEXT: Record<number, string> = {
  1: 'Too easy — barely an effort',
  2: 'Too easy — could do this all day',
  3: 'Easy — plenty left in the tank',
  4: 'Fairly easy — 5+ reps left in you',
  5: 'OK — comfortable, around 4 reps left',
  6: 'OK — comfortable with reps · ~3 left',
  7: 'Working — 2–3 solid reps left',
  8: 'Hard — 2 left at the very most',
  9: 'Very hard — maybe 1 more rep',
  10: "Couldn't do any more",
};
const RPE_TEXT_TIMED: Record<number, string> = {
  1: 'Too easy — barely an effort',
  2: 'Too easy — could hold this all day',
  3: 'Easy — well under control',
  4: 'Fairly easy — 20+ s more in you',
  5: 'OK — comfortable, ~15 s more in you',
  6: 'OK — steady, ~10 s more in you',
  7: 'Working — shaking a little, ~10 s left',
  8: 'Hard — 5 s left at most',
  9: 'Very hard — a breath from dropping',
  10: "Couldn't hold a second longer",
};

/** Seconds to get into position before a hold's countdown actually starts. */
const HOLD_PREP_S = 5;

function warmupsFor(t: { kind: string; priority: number; weight: number }, bar?: number):
    [number, number][] | null {
  if (t.kind !== 'bb' || t.priority !== 1 || t.weight < 50 || bar === undefined) return null;
  const rd = (x: number) => Math.round(x / 2.5) * 2.5;
  return [[bar, 10], [rd(t.weight * 0.5), 8], [rd(t.weight * 0.7), 5], [rd(t.weight * 0.85), 3]];
}

/** What we're capturing in the set sheet: a new set, or a correction to set i. */
interface SheetState { edit?: number; reps: number; rpe: number | null; w: number; }

const HOLD_RING_C = 2 * Math.PI * 20;

export function LogScreen() {
  const { log, logDispatch, go, me } = useApp();
  const qc = useQueryClient();
  const todayQ = useToday();
  const [, setNow] = useState(0);
  // form guide mid-session: opt-in each session — never in the way by default
  const [showForm, setShowForm] = useState(false);
  const [sheet, setSheet] = useState<SheetState | null>(null);
  const [saving, setSaving] = useState(false);
  // hold timer for timed exercises (plank & friends): local, like the rest
  // ring. prepEnd = a short get-into-position countdown before the hold runs.
  const [hold, setHold] = useState<{ end: number; total: number; prepEnd: number } | null>(null);
  const holdDone = useRef(false);
  const prepDone = useRef(false);

  useEffect(() => {
    const iv = setInterval(() => { setNow(Date.now()); logDispatch({ type: 'tick' }); }, 1000);
    return () => clearInterval(iv);
  }, [logDispatch]);

  // cues + photos feed the form panel; cached per exercise, fetched only when shown
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
  const timed = isTimed(t.slug) || isTimed(t.name);
  const unitWord = timed ? 's' : 'reps';
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
  const plate = plateStr(t.kind, wKg, profile, t.unit, t.slug);
  const prepRemain = hold ? Math.max(0, Math.ceil((hold.prepEnd - Date.now()) / 1000)) : null;
  const inPrep = prepRemain !== null && prepRemain > 0;
  const holdRemain = hold ? Math.max(0, Math.ceil((hold.end - Date.now()) / 1000)) : null;

  // get-set countdown ends → buzz once so eyes can stay off the screen
  useEffect(() => {
    if (hold && !inPrep && !prepDone.current) {
      prepDone.current = true;
      if (navigator.vibrate) navigator.vibrate(120);
    }
    if (!hold) prepDone.current = false;
  }, [hold, inPrep]);

  // hold finished → chime, and hand straight into the capture sheet
  useEffect(() => {
    if (hold && !inPrep && holdRemain === 0 && !holdDone.current) {
      holdDone.current = true;
      if (navigator.vibrate) navigator.vibrate([160, 90, 160]);
      toast(`${hold.total} s — hold done`, true);
      setSheet({ reps: hold.total, rpe: null, w: log.w });
      setHold(null);
    }
    if (!hold) holdDone.current = false;
  }, [hold, inPrep, holdRemain, log.w]);

  const setUnit = (u: LoadUnit) => {
    if (u === t.unit) return;
    logDispatch({ type: 'unit', u });
    const load_units = { ...(me.prefs?.load_units || {}), [t.slug]: u };
    qc.setQueryData<Me>(['me'], (old) => old && { ...old, prefs: { ...old.prefs, load_units } });
    api('/api/prefs', { method: 'PATCH', body: { prefs: { load_units } } }).catch(() => {});
  };

  const commitSheet = async (s: SheetState) => {
    if (saving) return;
    if (s.edit !== undefined) {
      // correction to an already-logged set
      const set = { weight: dispToKg(s.w, t.unit), reps: s.reps, rpe: s.rpe };
      setSaving(true);
      try {
        await api(`/api/sessions/${log.sid}/sets`, { method: 'PATCH',
          body: { slug: t.slug, set_no: s.edit + 1, weight: set.weight, reps: set.reps, rpe: set.rpe } });
        logDispatch({ type: 'editSet', slug: t.slug, i: s.edit, set });
        toast(`Set ${s.edit + 1} corrected`, true);
        setSheet(null);
      } catch (e) {
        toast(e instanceof ApiError && e.network ? 'Need a connection to edit a set' : String((e as Error).message));
      }
      setSaving(false);
      return;
    }
    // new set — queue-tolerant like before
    const set = { weight: wKg, reps: s.reps, rpe: s.rpe };
    const moreLeft = doneSets.length + 1 < t.sets;
    logDispatch({ type: 'logged', slug: t.slug, set, rest: t.rest || 90, moreLeft });
    setSheet(null);
    const res = await queuedPost<{ pbs: Pb[] }>(`/api/sessions/${log.sid}/sets`, {
      slug: t.slug, substituted_for: t.substituted_for || null,
      set_no: doneSets.length + 1, weight: set.weight, reps: set.reps, rpe: set.rpe,
    }).catch((e) => { toast(String(e.message)); return null; });
    if (res?.pbs?.length) {
      logDispatch({ type: 'pbs', pbs: res.pbs });
      toast(`New record — ${res.pbs[0].kind.replace('_', ' ')} ${fmtLoad(res.pbs[0].value, t.unit)}`, true);
    }
  };

  const openLogSheet = () => setSheet({ reps: t.reps, rpe: null, w: log.w });
  const openEditSheet = (i: number) => {
    const s = doneSets[i];
    setSheet({ edit: i, reps: s.reps, rpe: s.rpe, w: kgToDisp(s.weight, t.unit) });
  };

  // quick-capture chips: the planned number first, then the likely misses
  const repChips = (target: number): number[] => {
    const step = timed ? 5 : 1;
    return [target, target - step, target - 2 * step, target - 3 * step].filter((n) => n > 0);
  };

  return (
    <Shell>
      <div>
        <span className="kick">Exercise {log.idx + 1} of {log.targets.length}</span>
        <h2 className="title">
          <button className="press" onClick={() => go('learn', { learnSlug: t.slug, learnFrom: 'log' })}>
            {t.name} <span style={{ fontSize: 14, color: 'var(--volt)' }}>▶</span>
          </button>
        </h2>
      </div>
      <div className="chip num"><span className="dot" />
        Target {t.sets} × {t.reps}{timed ? ' s hold' : ''}{t.weight ? ` · ${fmtLoad(t.weight, t.unit)}` : ''}
        {' · '}rest {fmtT(t.rest || 90)} · {fmtT(elapsed)} elapsed · ~{remSets * 2} min left
      </div>
      <div style={{ display: 'flex', gap: 16 }}>
        <button className="press" onClick={() => go('swap')}
          style={{ fontSize: 12.5, color: 'var(--volt)', fontWeight: 600, padding: '0 2px' }}>
          Equipment taken? Swap ↺{log.swaps[orig.slug] ? ' · substituted' : ''}
        </button>
        <button className="press" onClick={() => setShowForm(!showForm)}
          style={{ fontSize: 12.5, color: showForm ? 'var(--mut)' : 'var(--volt)', fontWeight: 600, padding: '0 2px' }}>
          {showForm ? 'Hide form ✕' : 'Show form ▶'}
        </button>
      </div>
      {showForm && (
        <>
          {exQ.data?.media_url && exQ.data.media_tier === 'images' && (
            <div className="card" style={{ padding: 8 }}>
              <div style={{ display: 'flex', gap: 6 }}>
                {exQ.data.media_url.split(',').map((src, i) => (
                  <img key={src} src={src} alt={`${t.name} — ${i === 0 ? 'start' : 'end'} position`}
                    style={{ width: '50%', minWidth: 0, borderRadius: 10, display: 'block' }} />
                ))}
              </div>
            </div>
          )}
          <FormFig slug={t.slug} name={t.name} cues={exQ.data?.cues || []} />
        </>
      )}
      {wu && (
        <div className="card">
          <div className="kick" style={{ fontSize: 10.5, marginBottom: 6 }}>Warm-up ramp</div>
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
        <button key={i} className="setline press num" onClick={() => openEditSheet(i)}>
          <span className="lbl">Set {i + 1}</span>
          <span className="v">
            {t.weight ? `${fmtLoad(s.weight, t.unit)} × ` : ''}{s.reps}{timed ? ' s' : ''}
            {s.rpe ? ` · RPE ${s.rpe}` : ''}
          </span>
          <span className="tick">✓</span>
          <span className="sub" style={{ margin: 0, fontSize: 11 }}>edit</span>
        </button>
      ))}
      {!allDone && (t.weight > 0 || t.kind !== 'bw') && (
        <div className="active-set">
          <div className="stepper">
            <span className="lab">Set {doneSets.length + 1} · Weight{t.kind === 'db' ? ' · per dumbbell' : ''}</span>
            <span className="seg" style={{ padding: 2 }}>
              {(['lb', 'kg'] as const).map((u) => (
                <button key={u} className={t.unit === u ? 'sel' : ''}
                  style={{ fontSize: 12, padding: '3px 10px', flex: 'none' }}
                  onClick={() => setUnit(u)}>{u}</button>
              ))}
            </span>
            <div className="pm">
              <button onClick={() => logDispatch({ type: 'w', d: -1 })}>−</button>
              <span className="v disp num">{log.w}</span>
              <button onClick={() => logDispatch({ type: 'w', d: 1 })}>+</button>
            </div></div>
          {plate && <div className="sub num" style={{ margin: 0 }}>{plate}</div>}
        </div>
      )}
      {!allDone && timed && (
        <div className="resty" style={{ justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <svg width="48" height="48" viewBox="0 0 48 48" aria-hidden="true">
              <circle cx="24" cy="24" r="20" fill="none" stroke="var(--hair)" strokeWidth="4" />
              {hold && (inPrep ? (
                <circle cx="24" cy="24" r="20" fill="none" stroke="var(--warn)" strokeWidth="4"
                  strokeLinecap="round" strokeDasharray={`${(HOLD_RING_C * ((prepRemain || 0) / HOLD_PREP_S)).toFixed(1)} ${HOLD_RING_C.toFixed(1)}`}
                  transform="rotate(-90 24 24)" />
              ) : (
                <circle cx="24" cy="24" r="20" fill="none" stroke="var(--volt)" strokeWidth="4"
                  strokeLinecap="round" strokeDasharray={`${(HOLD_RING_C * ((holdRemain || 0) / hold.total)).toFixed(1)} ${HOLD_RING_C.toFixed(1)}`}
                  transform="rotate(-90 24 24)" />
              ))}
            </svg>
            <div>
              <div className="t disp num" style={inPrep ? { color: 'var(--warn)' } : undefined}>
                {hold ? (inPrep ? prepRemain : fmtT(holdRemain || 0)) : fmtT(t.reps)}
              </div>
              <div className="cap">
                {hold ? (inPrep ? 'get into position…' : 'holding — breathe')
                  : `${t.reps} s hold · ${HOLD_PREP_S} s to get set first`}
              </div>
            </div>
          </div>
          {hold ? (
            <button className="ghost press" style={{ width: 'auto', padding: '8px 14px' }}
              onClick={() => {
                const held = inPrep ? 0 : hold.total - (holdRemain || 0);
                setHold(null);
                if (held > 0) setSheet({ reps: held, rpe: null, w: log.w });
              }}>{inPrep ? 'Cancel' : 'Stop'}</button>
          ) : (
            <button className="ghost press" style={{ width: 'auto', padding: '8px 14px' }}
              onClick={() => {
                const now = Date.now();
                setHold({ prepEnd: now + HOLD_PREP_S * 1000,
                          end: now + (HOLD_PREP_S + t.reps) * 1000, total: t.reps });
              }}>
              Start hold
            </button>
          )}
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
          ? <button className="cta press" onClick={openLogSheet}>
              {timed ? `Log hold ${doneSets.length + 1}` : `Log set ${doneSets.length + 1}`}
            </button>
          : lastEx
            ? <button className="cta press" onClick={() => go('cooldown')}>Cool-down →</button>
            : <button className="cta press" onClick={() => logDispatch({ type: 'next' })}>
                Next: {log.targets[log.idx + 1].name}</button>}
      </div>

      {/* capture sheet: reps (or seconds) + effort, confirmed before anything is written */}
      {sheet && (
        <div className="overlay" onClick={() => setSheet(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h3>
              {sheet.edit !== undefined ? `Fix set ${sheet.edit + 1}` : `Set ${doneSets.length + 1}`} · {t.name}
            </h3>
            <div className="sub" style={{ marginTop: 0 }}>
              {sheet.edit !== undefined
                ? 'Correct what actually happened — records update too.'
                : timed
                  ? `Planned ${t.reps} s — how long did you hold?`
                  : `Planned ${t.reps} — how many did you get?`}
            </div>
            {sheet.edit !== undefined && (t.weight > 0 || t.kind !== 'bw') && (
              <div className="stepper" style={{ marginTop: 10 }}>
                <span className="lab">Weight · {t.unit}</span>
                <div className="pm">
                  <button onClick={() => setSheet({ ...sheet, w: Math.max(0, +(sheet.w - 2.5).toFixed(1)) })}>−</button>
                  <span className="v disp num">{sheet.w}</span>
                  <button onClick={() => setSheet({ ...sheet, w: +(sheet.w + 2.5).toFixed(1) })}>+</button>
                </div>
              </div>
            )}
            <div className="rpe" style={{ marginTop: 10 }}>
              {repChips(t.reps).map((n) => (
                <button key={n} className={(sheet.reps === n ? 'sel ' : '') + 'num'}
                  onClick={() => setSheet({ ...sheet, reps: n })}>
                  <b>{n}</b><small>{n === t.reps ? (timed ? 'full hold ✓' : 'all planned ✓') : timed ? 's' : 'reps'}</small>
                </button>
              ))}
            </div>
            <div className="stepper" style={{ marginTop: 8 }}>
              <span className="lab">{timed ? 'Held · seconds' : 'Exact reps'}</span>
              <div className="pm">
                <button onClick={() => setSheet({ ...sheet, reps: Math.max(1, sheet.reps - (timed ? 5 : 1)) })}>−</button>
                <span className="v disp num">{sheet.reps}</span>
                <button onClick={() => setSheet({ ...sheet, reps: sheet.reps + (timed ? 5 : 1) })}>+</button>
              </div>
            </div>
            <div style={{ marginTop: 12 }}>
              <div className="row">
                <span className="lab">How hard was that?</span>
                {sheet.rpe !== null && <b className="num" style={{ fontSize: 13 }}>{sheet.rpe}/10</b>}
              </div>
              <input type="range" min={1} max={10} step={1}
                value={sheet.rpe ?? 6} aria-label="Effort, 1 easy to 10 maximal"
                style={{ ['--pct' as string]: `${(((sheet.rpe ?? 6) - 1) / 9) * 100}%`,
                         marginTop: 8, opacity: sheet.rpe === null ? 0.55 : 1 }}
                onChange={(e) => setSheet({ ...sheet, rpe: +e.target.value })} />
              <div className="row" style={{ marginTop: 2 }}>
                <span className="sub" style={{ margin: 0, fontSize: 11 }}>too easy</span>
                <span className="sub" style={{ margin: 0, fontSize: 11 }}>couldn't do more</span>
              </div>
              <div className="sub" style={{ marginTop: 6, minHeight: 20,
                color: sheet.rpe === null ? 'var(--dim)' : 'var(--ink)', fontWeight: sheet.rpe === null ? 400 : 550 }}>
                {sheet.rpe === null ? 'Slide to rate the effort (optional)'
                  : (timed ? RPE_TEXT_TIMED : RPE_TEXT)[sheet.rpe]}
              </div>
            </div>
            <button className="cta press" style={{ marginTop: 12 }} disabled={saving}
              onClick={() => commitSheet(sheet)}>
              {sheet.edit !== undefined
                ? 'Save correction'
                : `Log ${timed ? `${sheet.reps} s hold` : `set · ${sheet.reps} ${unitWord}`}`}
            </button>
            <button className="ghost press" onClick={() => setSheet(null)}>Cancel</button>
          </div>
        </div>
      )}
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
  const { log, logDispatch, finishSession, go } = useApp();
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
        <div key={i} className="lrow" style={{ padding: 0 }}>
          <button className="press" aria-label={log.cdDone[i] ? 'Mark not done' : 'Mark done'}
            style={{ padding: '13px 2px 13px 0', fontSize: 17 }}
            onClick={() => logDispatch({ type: 'cdTick', i })}>
            {log.cdDone[i] ? <span className="tick">✓</span> : <span className="chev">○</span>}
          </button>
          <button className="press" style={{ flex: 1, display: 'flex', flexDirection: 'column',
            alignItems: 'flex-start', padding: '11px 0' }}
            onClick={() => go('learn', { learnSlug: c.slug, learnFrom: 'cooldown' })}>
            <b>{c.name || c.slug}{c.why ? ' ✳' : ''} <span style={{ fontSize: 12, color: 'var(--volt)' }}>how ▶</span></b>
            <span className="rsub" style={{ textAlign: 'left' }}>
              {c.hold || ''}{c.why ? <><br />{c.why}</> : null}
            </span>
          </button>
        </div>
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
            {g.sets.map((s) => s.reps).join('/')}{isTimed(g.slug) ? ' s' : ''}
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
