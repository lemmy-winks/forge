import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  api, fmtLoad, fmtT, kgDisp, kgToDisp, loadUnitFor,
  type HistoryItem, type LoadUnit, type Progress, type RecordRow, type SeriesPoint, type SessionDetail,
} from '../api';
import { smoothPath } from '../chart';
import { Back, Chip, Loading, Shell, Title, toast, useApp } from '../ui';

export function HistoryScreen() {
  const { go } = useApp();
  const q = useQuery<HistoryItem[]>({ queryKey: ['history'], queryFn: () => api('/api/history') });
  const items = q.data;
  return (
    <Shell>
      <Title kick="All sessions">History</Title>
      {!items && <Loading />}
      {items && !items.length && <Chip>Nothing yet — your first logged session lands here.</Chip>}
      {(items || []).map((h) => {
        const s = h.stats || {};
        const head = h.kind === 'cardio'
          ? [s.distance ? s.distance.toFixed(1) + ' km' : null,
             s.duration_s ? fmtT(s.duration_s) : null,
             s.avg_hr ? Math.round(s.avg_hr) + ' bpm' : null].filter(Boolean).join(' · ')
          : [s.tonnage != null ? s.tonnage + ' t' : null,
             s.sets_done != null ? s.sets_done + ' sets' : null].filter(Boolean).join(' · ');
        return (
          <button key={h.id} className="lrow press num" onClick={() => go('detail', { detailId: h.id })}>
            <b>{h.day} · {h.name}</b><span className="rsub">{head || h.status}</span><span className="chev">›</span>
          </button>
        );
      })}
    </Shell>
  );
}

export function DetailScreen() {
  const { detailId, openTab, me, go } = useApp();
  const q = useQuery<SessionDetail>({
    queryKey: ['session', detailId],
    queryFn: () => api('/api/sessions/' + detailId),
    enabled: !!detailId,
  });
  const d = q.data;
  if (!d) return <Shell><Back label="History" onClick={() => openTab('history')} /><Loading /></Shell>;
  const targets: Record<string, { sets: number; reps: number; weight: number }> = {};
  ((d.fitted as any)?.targets || []).forEach((t: any) => { targets[t.slug] = t; });
  return (
    <Shell>
      <Back label="History" onClick={() => openTab('history')} />
      <Title kick={`${d.day}${d.kind === 'cardio' ? ' · Watch sync' : ''}`}>{d.name}</Title>
      {d.exercises.map((g) => {
        const t = targets[g.substituted_for || g.slug];
        const u = loadUnitFor(me.prefs, g.slug);
        return (
          <div key={g.slug} className="card num">
            <div className="row">
              <span className="xname">{g.name}{g.substituted_for && <small style={{ color: 'var(--mut)' }}> (sub)</small>}</span>
              <span className="target">{g.sets.map((s) => s.reps).join('/')}{g.sets[0]?.weight ? ` @ ${fmtLoad(g.sets[0].weight, u)}` : ''}</span>
            </div>
            {t && <div className="sub">Plan {t.sets}×{t.reps}{t.weight ? ` @ ${fmtLoad(t.weight, u)}` : ''}</div>}
          </div>
        );
      })}
      {d.kind === 'cardio' && <CardioStats d={d} />}
      {d.notes && <div className="card"><div className="sub" style={{ marginTop: 0 }}><b style={{ color: 'var(--ink)' }}>Note:</b> {d.notes}</div></div>}
      {d.kind === 'cardio' && <AnnotateRow d={d} />}
      <button className="ghost press" onClick={() =>
        go('coach', { chatContext: { kind: 'session', id: d.id, label: `${d.day} · ${d.name}` } })}>
        Ask the coach about this session
      </button>
      {d.cooldown_status && <Chip>Cool-down: {d.cooldown_status}</Chip>}
    </Shell>
  );
}

/** Watch-synced session: target vs actual when matched to a prescription (E5.2). */
function CardioStats({ d }: { d: SessionDetail }) {
  const s = d.stats || {};
  const t = s.target;
  const fmt = (k: string, v: any) =>
    k === 'duration_s' ? fmtT(v) :
    k === 'pace_min_km' ? `${Math.floor(v)}:${String(Math.round((v % 1) * 60)).padStart(2, '0')} /km` :
    typeof v === 'number' ? String(+v.toFixed(1)) : String(v);
  const rows: [string, string][] = [
    ['Time', s.duration_s != null ? fmtT(s.duration_s) : '—'],
    ['Distance', s.distance != null ? s.distance.toFixed(2) + ' km' : '—'],
    ['Pace', s.pace_min_km != null ? fmt('pace_min_km', s.pace_min_km) : '—'],
    ['Avg HR', s.avg_hr != null ? Math.round(s.avg_hr) + ' bpm' : '—'],
  ];
  return (
    <>
      {t && (
        <div className="card num">
          <div className="row"><span className="xname">Target</span>
            <span className="target">{t.minutes} min · Z {t.hr_low}–{t.hr_high} bpm</span></div>
          {s.pct_in_zone != null && (
            <div className="sub">
              <span className={s.pct_in_zone >= 70 ? 'up' : 'warn'}>{s.pct_in_zone}% in zone</span>
              {s.zone_min != null && ` · ${s.zone_min} of ${Math.round((s.duration_s || 0) / 60)} min in band`}
            </div>
          )}
        </div>
      )}
      <div className="tiles">
        {rows.map(([k, v]) => (
          <div key={k} className="tile"><div className="k">{k}</div>
            <div className="v disp num" style={{ fontSize: 19 }}>{v}</div></div>
        ))}
      </div>
    </>
  );
}

function AnnotateRow({ d }: { d: SessionDetail }) {
  const qc = useQueryClient();
  const [note, setNote] = useState(d.notes || '');
  return (
    <div className="card">
      <div className="field"><label>Note this session</label>
        <input value={note} placeholder="Felt easy, cool morning…"
          onChange={(e) => setNote(e.target.value)} /></div>
      <button className="ghost press" style={{ marginTop: 8 }} onClick={async () => {
        await api('/api/sessions/' + d.id + '/notes', { method: 'PATCH', body: { notes: note } });
        qc.invalidateQueries({ queryKey: ['session', d.id] });
        toast('Saved');
      }}>Save note</button>
    </div>
  );
}

/** Raw dots + smoothed trend — the only honest way to show Watch VO₂max (E5.3). */
function DotTrendChart({ raw, smooth }: { raw: SeriesPoint[]; smooth: SeriesPoint[] }) {
  if (raw.length < 2) return <div className="sub">Not enough readings yet — the Watch adds them after outdoor runs.</div>;
  const w = 340, h = 120;
  const vals = raw.map((p) => p.v).concat(smooth.map((p) => p.v));
  const min = Math.min(...vals) - 0.5, max = Math.max(...vals) + 0.5;
  const X = (i: number) => 10 + (i * (w - 20)) / (raw.length - 1);
  const Y = (v: number) => (h - 14) - ((v - min) / (max - min)) * (h - 28);
  const path = smoothPath(smooth.map((p, i) => [X(i), Y(p.v)]));
  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: '100%', display: 'block' }}>
      {raw.map((p, i) => <circle key={i} cx={X(i)} cy={Y(p.v)} r="2.5" fill="var(--dim)" />)}
      <path d={path} fill="none" stroke="var(--volt)" strokeWidth="2" strokeLinecap="round" />
      <text x={w - 10} y={Y(smooth[smooth.length - 1].v) - 6} textAnchor="end"
        fill="var(--ink)" fontSize="11" fontWeight="600">
        {smooth[smooth.length - 1].v.toFixed(1)}
      </text>
    </svg>
  );
}

function LineChart({ points }: { points: { d: string; v: number }[] }) {
  if (!points || points.length < 2) return <div className="sub">Not enough data yet — keep logging.</div>;
  const w = 340, h = 130;
  const vals = points.map((p) => p.v);
  const min = Math.min(...vals) - 1, max = Math.max(...vals) + 1;
  const X = (i: number) => 10 + (i * (w - 20)) / (points.length - 1);
  const Y = (v: number) => (h - 18) - ((v - min) / (max - min)) * (h - 38);
  const path = smoothPath(points.map((p, i) => [X(i), Y(p.v)]));
  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: '100%', display: 'block' }}>
      <g stroke="var(--hair)" strokeWidth="1">
        <line x1="10" y1={Y(max - 1)} x2={w - 10} y2={Y(max - 1)} />
        <line x1="10" y1={Y(min + 1)} x2={w - 10} y2={Y(min + 1)} />
      </g>
      <g fill="var(--dim)" fontSize="9">
        <text x={w - 10} y={Y(max - 1) - 4} textAnchor="end">{(max - 1).toFixed(0)}</text>
        <text x={w - 10} y={Y(min + 1) + 11} textAnchor="end">{(min + 1).toFixed(0)}</text>
      </g>
      <path d={path} fill="none" stroke="var(--volt)" strokeWidth="2" strokeLinecap="round" />
      {points.map((p, i) => (
        <circle key={i} cx={X(i)} cy={Y(p.v)} r="2" fill="var(--volt)" opacity="0.9" />
      ))}
      <circle cx={X(points.length - 1)} cy={Y(vals[vals.length - 1])} r="4"
        fill="var(--volt)" stroke="var(--raised)" strokeWidth="2" />
    </svg>
  );
}

export function ProgressScreen() {
  const { go, lift, me } = useApp();
  const q = useQuery<Progress>({ queryKey: ['progress'], queryFn: () => api('/api/progress') });
  const p = q.data;
  if (!p) return <Shell><Loading /></Shell>;
  const slugs = Object.keys(p.e1rm);
  const sel = lift && slugs.includes(lift) ? lift : slugs.includes('back-squat') ? 'back-squat' : slugs[0];
  const liftU: LoadUnit = loadUnitFor(me.prefs, sel);
  const cur = sel
    ? { ...p.e1rm[sel], points: p.e1rm[sel].points.map((pt) => ({ ...pt, v: kgToDisp(pt.v, liftU) })) }
    : null;
  const wLast = p.weight.length ? p.weight[p.weight.length - 1].v : null;
  const vLast = p.vo2max.length ? p.vo2max[p.vo2max.length - 1].v : null;
  const bc = p.bodycomp;
  const last = (s: SeriesPoint[]) => (s.length ? s[s.length - 1].v : null);
  return (
    <Shell>
      <Title kick="Trends">Progress</Title>
      {cur ? (
        <>
          <div className="seg">
            {slugs.slice(0, 3).map((s) => (
              <button key={s} className={sel === s ? 'sel' : ''} onClick={() => go('progress', { lift: s })}>
                {(p.e1rm[s].name || s).split(' ')[0]}
              </button>
            ))}
          </div>
          <div className="card">
            <div className="row">
              <span style={{ fontSize: 13.5, fontWeight: 600 }}>{cur.name} · est. 1RM</span>
              <span style={{ fontSize: 11.5, color: 'var(--mut)' }}>{liftU}</span>
            </div>
            {cur.points.length > 0 && (
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, margin: '2px 0 4px' }}>
                <span className="disp num" style={{ fontSize: 22 }}>{cur.points[cur.points.length - 1].v.toFixed(1)}</span>
              </div>
            )}
            <LineChart points={cur.points} />
          </div>
        </>
      ) : <Chip>Log strength sessions to build the e1RM trend.</Chip>}
      <button className="lrow press num" onClick={() => go('records')}>
        <b>Records</b><span className="rsub">all-time bests per lift</span><span className="chev">›</span>
      </button>
      <div className="tiles">
        <div className="tile"><div className="k">Bodyweight</div>
          <div className="v disp num">{wLast != null ? kgDisp(wLast, me.units) : '—'}</div>
          <div className="d">{p.weight.length} readings</div></div>
        <div className="tile"><div className="k">Sessions</div>
          <div className="v disp num">{p.week.done}<small>/{p.week.planned}</small></div>
          <div className="d">this week</div></div>
        <div className="tile"><div className="k">Zone 2</div>
          <div className="v disp num">{Math.round(p.zone2.done)}<small>/{p.zone2.target} min</small></div>
          <div className="d">{p.zone2.target
            ? (p.zone2.done >= p.zone2.target ? 'weekly target hit' : 'this week vs target')
            : 'no cardio prescribed'}</div></div>
        <div className="tile"><div className="k">Resting HR</div>
          <div className="v disp num">{p.resting_hr.length ? Math.round(p.resting_hr[p.resting_hr.length - 1].v) : '—'} <small>bpm</small></div>
          <div className="d">latest</div></div>
      </div>
      {(bc.fat_pct.length > 0 || bc.muscle.length > 0) && (
        <div className="card num">
          <div className="row">
            <span style={{ fontSize: 13.5, fontWeight: 600 }}>Body composition</span>
            <span style={{ fontSize: 11.5, color: 'var(--mut)' }}>scale readings</span>
          </div>
          <div className="row" style={{ marginTop: 6 }}>
            {([['Fat', last(bc.fat_pct), '%'],
               ['Water', last(bc.water_pct), '%'],
               ['Muscle', last(bc.muscle), null],
               ['Bone', last(bc.bone), null]] as const).map(([k, v, pct]) => (
              <span key={k} style={{ textAlign: 'center' }}>
                <span className="lab" style={{ display: 'block' }}>{k}</span>
                <span className="disp num" style={{ fontSize: 17 }}>
                  {v == null ? '—' : pct ? v.toFixed(1) + pct : kgDisp(v, me.units)}
                </span>
              </span>
            ))}
          </div>
          {bc.fat_pct.length >= 2 && <LineChart points={bc.fat_pct} />}
          {bc.fat_pct.length >= 2 && <div className="sub">Body-fat % trend</div>}
        </div>
      )}
      <div className="card">
        <div className="row">
          <span style={{ fontSize: 13.5, fontWeight: 600 }}>VO₂max · raw + trend</span>
          <span style={{ fontSize: 11.5, color: 'var(--mut)' }}>
            {vLast != null ? 'ml/kg/min' : ''}</span>
        </div>
        <DotTrendChart raw={p.vo2max} smooth={p.vo2max_smooth} />
        {p.vo2max.length >= 2 &&
          <div className="sub">Trend over single readings — the coach reads this quarterly.</div>}
      </div>
    </Shell>
  );
}

/** Next round-number milestone for the PR ledger (E6.2), in display units. */
function milestone(v: number): number {
  const step = v >= 100 ? 10 : 5;
  return Math.floor(v / step) * step + step;
}

export function RecordsScreen() {
  const { openTab, me } = useApp();
  const q = useQuery<RecordRow[]>({ queryKey: ['records'], queryFn: () => api('/api/records') });
  const rows = q.data || [];
  const bySlug: Record<string, { name: string; e1rm?: RecordRow; best_set?: RecordRow }> = {};
  rows.forEach((r) => {
    bySlug[r.slug] = bySlug[r.slug] || { name: r.name };
    (bySlug[r.slug] as any)[r.kind] = r;
  });
  return (
    <Shell>
      <Back label="Progress" onClick={() => openTab('progress')} />
      <Title kick="All-time bests">Records</Title>
      {!q.data && <Loading />}
      {q.data && !rows.length && <Chip>No records yet — they appear as you log sets.</Chip>}
      {Object.entries(bySlug).map(([slug, g]) => {
        const u = loadUnitFor(me.prefs, slug);
        return (
          <div key={slug} className="lrow num"><b>{g.name}</b>
            <span className="rsub">
              {g.e1rm && <><span style={{ color: 'var(--ink)', fontSize: 14 }}>{fmtLoad(g.e1rm.value, u)} e1RM</span> · {g.e1rm.achieved_on}</>}
              {g.best_set && <><br />best set {fmtLoad(g.best_set.value, u)} × {g.best_set.detail.split('×')[1]?.trim() || '?'}</>}
              {g.e1rm && <><br /><span style={{ color: 'var(--volt)' }}>next: {milestone(kgToDisp(g.e1rm.value, u))} {u}</span></>}
            </span></div>
        );
      })}
      <Chip>Computed from logged sets — a PB is celebrated once, in the session summary</Chip>
    </Shell>
  );
}
