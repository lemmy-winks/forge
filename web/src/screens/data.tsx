import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import {
  api, fmtDur, fmtLoad, kgDisp, kgToDisp, loadUnitFor,
  type HistoryItem, type LoadUnit, type MetricHistory, type Progress, type RecordRow,
  type SeriesPoint, type SessionDetail,
} from '../api';
import { smoothPath } from '../chart';
import { RouteCard } from '../routemap';
import { Back, Chip, Loading, Shell, Title, toast, useApp } from '../ui';

/** What was actually done, at a glance: strength barbell, or the cardio
    flavour (run / walk / hike / ride / swim) sniffed from the matched
    prescription or the Watch workout name. */
function ActivityGlyph({ h }: { h: HistoryItem }) {
  const c = h.status === 'completed' ? 'var(--volt)' : 'var(--mut)';
  const sw = { fill: 'none' as const, stroke: c, strokeWidth: 1.6,
               strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  const svg = (kids: ReactNode) =>
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">{kids}</svg>;
  if (h.kind !== 'cardio') {
    return svg(<>
      <line x1="4" y1="8" x2="12" y2="8" stroke={c} strokeWidth="1.6" />
      <rect x="1.2" y="4.5" width="2.4" height="7" rx="1" fill={c} />
      <rect x="12.4" y="4.5" width="2.4" height="7" rx="1" fill={c} /></>);
  }
  const sub = `${h.stats?.target?.type || ''} ${h.name || ''}`.toLowerCase();
  if (sub.includes('hik')) {
    return svg(<polyline points="1,12.5 5.5,4.5 8.5,9.5 11,6 15,12.5" {...sw} />);
  }
  if (sub.includes('walk')) {
    return svg(<>
      <ellipse cx="5" cy="4.5" rx="1.7" ry="2.4" fill={c} transform="rotate(-14 5 4.5)" />
      <ellipse cx="11" cy="10.5" rx="1.7" ry="2.4" fill={c} transform="rotate(14 11 10.5)" /></>);
  }
  if (sub.includes('run')) {
    return svg(<>
      <polyline points="3,3.5 8,8 3,12.5" {...sw} />
      <polyline points="8,3.5 13,8 8,12.5" {...sw} /></>);
  }
  if (sub.includes('cycl') || sub.includes('ride') || sub.includes('bike')) {
    return svg(<>
      <circle cx="4.2" cy="10.5" r="3" {...sw} />
      <circle cx="11.8" cy="10.5" r="3" {...sw} />
      <polyline points="4.2,10.5 6.8,5 11,5" {...sw} /></>);
  }
  if (sub.includes('swim')) {
    return svg(<>
      <path d="M1 6 q1.8 -2.4 3.5 0 t3.5 0 t3.5 0 t3.5 0" {...sw} />
      <path d="M1 10.5 q1.8 -2.4 3.5 0 t3.5 0 t3.5 0 t3.5 0" {...sw} /></>);
  }
  return svg(<polyline points="1,9 4.5,9 6.5,4 9,12 10.8,8 15,8" {...sw} />);
}

const HISTORY_PAGE = 30;

export function HistoryScreen() {
  const { go } = useApp();
  const q = useInfiniteQuery<HistoryItem[]>({
    queryKey: ['history'],
    queryFn: ({ pageParam }) => api(`/api/history?limit=${HISTORY_PAGE}&offset=${pageParam}`),
    initialPageParam: 0,
    getNextPageParam: (last, all) =>
      last.length === HISTORY_PAGE ? all.reduce((n, p) => n + p.length, 0) : undefined,
  });
  const items = q.data?.pages.flat();
  return (
    <Shell>
      <Title kick="All sessions">History</Title>
      {!items && <Loading />}
      {items && !items.length && <Chip>Nothing yet — your first logged session lands here.</Chip>}
      {(items || []).map((h) => {
        const s = h.stats || {};
        const head = h.kind === 'cardio'
          ? [s.distance ? s.distance.toFixed(1) + ' km' : null,
             s.duration_s ? fmtDur(s.duration_s) : null,
             s.avg_hr ? Math.round(s.avg_hr) + ' bpm' : null].filter(Boolean).join(' · ')
          : [s.tonnage != null ? s.tonnage + ' t' : null,
             s.sets_done != null ? s.sets_done + ' sets' : null,
             s.partial ? 'partial' : null].filter(Boolean).join(' · ');
        return (
          <button key={h.id} className="lrow press num" onClick={() => go('detail', { detailId: h.id })}>
            <span className="glyphslot"><ActivityGlyph h={h} /></span>
            <b>{h.day} · {h.name}</b><span className="rsub">{head || h.status}</span><span className="chev">›</span>
          </button>
        );
      })}
      {q.hasNextPage && (
        <button className="ghost press" disabled={q.isFetchingNextPage}
          onClick={() => q.fetchNextPage()}>
          {q.isFetchingNextPage ? 'Loading…' : 'Earlier sessions'}
        </button>
      )}
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
      {d.stats?.partial && (
        <Chip>Saved incomplete — {d.stats.sets_done} of {d.stats.sets_planned} planned sets logged</Chip>
      )}
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
      {d.series?.route && d.series.route.length > 1 && <RouteCard pts={d.series.route} />}
      {d.series?.hr && d.series.hr.length > 1 && <HrTrace d={d} />}
      {d.zones && <ZoneBars z={d.zones} />}
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
    k === 'duration_s' ? fmtDur(v) :
    k === 'pace_min_km' ? `${Math.floor(v)}:${String(Math.round((v % 1) * 60)).padStart(2, '0')} /km` :
    typeof v === 'number' ? String(+v.toFixed(1)) : String(v);
  const rows: [string, string][] = [
    ['Time', s.duration_s != null ? fmtDur(s.duration_s) : '—'],
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

/** HR over time with the prescribed band shaded. Single series — no legend. */
function HrTrace({ d }: { d: SessionDetail }) {
  const hr = d.series!.hr!;
  const W = 320, H = 120, PAD = { l: 30, r: 8, t: 8, b: 16 };
  const t1 = hr[hr.length - 1][0] || 1;
  const bpms = hr.map((p) => p[1]);
  const band = d.stats?.target;
  const lo = Math.floor(Math.min(...bpms, band?.hr_low ?? Infinity) / 10) * 10;
  const hi = Math.ceil(Math.max(...bpms, band?.hr_high ?? 0) / 10) * 10;
  const x = (t: number) => PAD.l + ((W - PAD.l - PAD.r) * t) / t1;
  const y = (v: number) => PAD.t + (H - PAD.t - PAD.b) * (1 - (v - lo) / Math.max(1, hi - lo));
  const step = Math.max(1, Math.floor(hr.length / 150));
  const line = smoothPath(hr.filter((_, i) => i % step === 0 || i === hr.length - 1)
    .map((p) => [x(p[0]), y(p[1])] as [number, number]));
  const mins = Math.round(t1 / 60);
  return (
    <div className="card num">
      <div className="row"><span className="xname">Heart rate</span>
        {d.stats?.avg_hr && <span className="target">avg {Math.round(d.stats.avg_hr)} bpm</span>}</div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', display: 'block', marginTop: 6 }}
        role="img" aria-label="Heart rate trace">
        {band?.hr_low && band?.hr_high && (
          <rect x={PAD.l} y={y(band.hr_high)} width={W - PAD.l - PAD.r}
            height={Math.max(0, y(band.hr_low) - y(band.hr_high))} fill="var(--volt-dim)" />
        )}
        {[lo, hi].map((v) => (
          <g key={v}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} stroke="var(--hair)" />
            <text x={PAD.l - 5} y={y(v) + 3} textAnchor="end" fontSize="9" fill="var(--mut)">{v}</text>
          </g>
        ))}
        <path d={line} fill="none" stroke="var(--volt)" strokeWidth="2"
          strokeLinejoin="round" strokeLinecap="round" />
        <text x={PAD.l} y={H - 4} fontSize="9" fill="var(--mut)">0 min</text>
        <text x={W - PAD.r} y={H - 4} textAnchor="end" fontSize="9" fill="var(--mut)">{mins} min</text>
      </svg>
      {band?.hr_low && <div className="sub">shaded: prescribed {band.hr_low}–{band.hr_high} bpm</div>}
    </div>
  );
}

/** Time in each of five HR-max zones. One hue, deeper = harder; labels carry
    identity so color is never load-bearing. */
const ZONE_ALPHA = [0.35, 0.5, 0.65, 0.82, 1];
function ZoneBars({ z }: { z: NonNullable<SessionDetail['zones']> }) {
  const total = Math.max(...z.zones.map((r) => r.min), 0.1);
  return (
    <div className="card num">
      <div className="row"><span className="xname">Zones</span>
        <span className="target num">max {z.estimated ? '≈' : ''}{z.hr_max} bpm</span></div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginTop: 8 }}>
        {z.zones.map((r) => (
          <div key={r.zone} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="sub" style={{ width: 86, margin: 0, whiteSpace: 'nowrap' }}>
              Z{r.zone} {r.zone === 1 ? `<${r.high}` : r.high ? `${r.low}–${r.high}` : `${r.low}+`}
            </span>
            <div style={{ flex: 1, height: 8, borderRadius: 4, background: 'var(--sunken)' }}>
              {r.min > 0 && (
                <div style={{ width: `${Math.max(2, (100 * r.min) / total)}%`, height: 8, borderRadius: 4,
                  background: 'var(--volt)', opacity: ZONE_ALPHA[r.zone - 1] }} />
              )}
            </div>
            <span className="sub" style={{ width: 44, textAlign: 'right', margin: 0 }}>{r.min ? `${r.min}m` : '—'}</span>
          </div>
        ))}
      </div>
      {z.estimated && <div className="sub">Max HR estimated from this run — tell the coach your tested max to refine zones.</div>}
    </div>
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

/* ---------------- metric drill-down (Progress → tap a number) ---------------- */

type Sex = 'm' | 'f' | null;
interface BandFor { range: [number, number]; label: string; }
interface MetricMeta {
  title: string; unit: (units: string) => string;
  /** convert canonical → display value */
  disp: (v: number, units: string) => number;
  /** age/sex-aware reference band; null = no meaningful universal range */
  band?: (sex: Sex, age: number | null) => BandFor;
  higherBetter?: boolean;
  blurb: string;
}

const GENERIC_NOTE = 'general adult range — set sex & birth year in Settings to tune this to you';
const sexWord = (s: Sex) => (s === 'f' ? 'women' : 'men');
/** Decade bucket label like "40–49" (clamped to the tables we carry). */
const decade = (age: number) => {
  const d = Math.min(60, Math.max(20, Math.floor(age / 10) * 10));
  return d === 60 ? '60+' : `${d}–${d + 9}`;
};

/** Healthy body-fat % by sex/age (ACE/Gallagher-style, rounded). */
function fatBand(sex: Sex, age: number | null): BandFor {
  if (!sex || age == null) return { range: [10, 25], label: GENERIC_NOTE };
  const table: Record<string, [number, number][]> = {
    m: [[8, 20], [11, 22], [13, 25]], f: [[21, 33], [23, 34], [24, 36]],
  };
  const i = age < 40 ? 0 : age < 60 ? 1 : 2;
  return { range: table[sex][i], label: `healthy range · ${sexWord(sex)} ${decade(age)}` };
}

function waterBand(sex: Sex): BandFor {
  if (!sex) return { range: [45, 65], label: GENERIC_NOTE };
  return sex === 'f' ? { range: [45, 60], label: 'typical range · women' }
                     : { range: [50, 65], label: 'typical range · men' };
}

/** VO2max "good" decade bands (Cooper-style norms, rounded). */
function vo2Band(sex: Sex, age: number | null): BandFor {
  if (!sex || age == null) return { range: [35, 48], label: `${GENERIC_NOTE} · higher is better` };
  const table: Record<string, [number, number][]> = {
    m: [[44, 51], [41, 48], [39, 46], [36, 43], [33, 40]],
    f: [[36, 44], [34, 41], [32, 38], [29, 36], [27, 33]],
  };
  const i = Math.min(4, Math.max(0, Math.floor((age - 20) / 10)));
  return { range: table[sex][i],
           label: `"good" band · ${sexWord(sex)} ${decade(age)} · higher is better` };
}

/** Reference bands are broad healthy ranges — context, never diagnosis. */
const METRIC_META: Record<string, MetricMeta> = {
  weight: {
    title: 'Bodyweight', unit: (u) => (u === 'lb' ? 'lb' : 'kg'),
    disp: (v, u) => (u === 'lb' ? +(v * 2.20462).toFixed(1) : v),
    blurb: 'Scale weight, whenever a reading syncs. Day-to-day swings of ±1–2 kg are water and food, not fat or muscle — read the month, not the morning.',
  },
  body_fat_pct: {
    title: 'Body fat', unit: () => '%', disp: (v) => v, band: fatBand,
    blurb: 'Share of total weight that is fat tissue, estimated by your scale\'s bio-impedance. Single readings are noisy (hydration skews them) — the trend is the signal.',
  },
  water_pct: {
    title: 'Body water', unit: () => '%', disp: (v) => v,
    band: (sex) => waterBand(sex),
    blurb: 'Total body water as a share of weight, derived from the scale\'s water-mass reading. Tracks hydration and inversely mirrors body-fat %.',
  },
  muscle_mass: {
    title: 'Muscle mass', unit: (u) => (u === 'lb' ? 'lb' : 'kg'),
    disp: (v, u) => (u === 'lb' ? +(v * 2.20462).toFixed(1) : v),
    blurb: 'Estimated lean muscle tissue. There is no universal "healthy range" — what matters is holding or growing it while training. Watch it against your strength trend.',
  },
  bone_mass: {
    title: 'Bone mass', unit: (u) => (u === 'lb' ? 'lb' : 'kg'),
    disp: (v, u) => (u === 'lb' ? +(v * 2.20462).toFixed(1) : v),
    blurb: 'Estimated mineral mass of your skeleton. Very stable — big jumps are measurement noise, not biology.',
  },
  vo2max: {
    title: 'VO₂max', unit: () => 'ml/kg/min', disp: (v) => v, higherBetter: true,
    band: vo2Band,
    blurb: 'Your engine size: the most oxygen you can use per minute per kg. The Watch estimates it after outdoor runs. It moves slowly — the coach reads it quarterly.',
  },
  resting_hr: {
    title: 'Resting HR', unit: () => 'bpm', disp: (v) => v,
    band: () => ({ range: [50, 70], label: 'typical adult range · lower usually fitter' }),
    blurb: 'Heart rate at full rest. Aerobic training pushes it down over months; a sudden +5–10 bpm above your normal often means fatigue or oncoming illness.',
  },
  sleep_h: {
    title: 'Sleep', unit: () => 'h', disp: (v) => v,
    band: (_s, age) => (age != null && age >= 65
      ? { range: [7, 8], label: 'recommended · 65+' }
      : { range: [7, 9], label: 'recommended for adults' }),
    blurb: 'Nightly sleep from Apple Health. Recovery is training — lifting progress and resting HR both track this closely.',
  },
};

/** Full-history line with the healthy band shaded. */
function BandChart({ points, band, disp, units }: {
  points: SeriesPoint[]; band?: [number, number];
  disp: (v: number, u: string) => number; units: string;
}) {
  if (points.length < 2) return <div className="sub">Not enough readings yet.</div>;
  // cap the draw at ~240 points so years of history stay smooth
  const step = Math.max(1, Math.floor(points.length / 240));
  const pts = points.filter((_, i) => i % step === 0 || i === points.length - 1)
    .map((p) => ({ d: p.d, v: disp(p.v, units) }));
  const b = band ? [disp(band[0], units), disp(band[1], units)] as [number, number] : null;
  const w = 340, h = 150;
  const vals = pts.map((p) => p.v).concat(b ? b : []);
  const min = Math.min(...vals) - 1, max = Math.max(...vals) + 1;
  const X = (i: number) => 10 + (i * (w - 20)) / (pts.length - 1);
  const Y = (v: number) => (h - 18) - ((v - min) / (max - min)) * (h - 38);
  const path = smoothPath(pts.map((p, i) => [X(i), Y(p.v)]));
  const yearMarks: { i: number; label: string }[] = [];
  pts.forEach((p, i) => {
    if (i > 0 && p.d.slice(0, 4) !== pts[i - 1].d.slice(0, 4)) yearMarks.push({ i, label: p.d.slice(0, 4) });
  });
  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: '100%', display: 'block' }}>
      {b && (
        <rect x="10" y={Y(b[1])} width={w - 20} height={Math.max(0, Y(b[0]) - Y(b[1]))}
          fill="var(--volt)" opacity="0.10" />
      )}
      {b && b.map((v, i) => (
        <g key={i}>
          <line x1="10" x2={w - 10} y1={Y(v)} y2={Y(v)} stroke="var(--volt)" opacity="0.35" strokeDasharray="3 4" />
          <text x={w - 12} y={Y(v) + (i ? -4 : 11)} textAnchor="end" fontSize="9" fill="var(--mut)">{v}</text>
        </g>
      ))}
      {yearMarks.map((m) => (
        <g key={m.label}>
          <line x1={X(m.i)} x2={X(m.i)} y1={12} y2={h - 16} stroke="var(--hair)" />
          <text x={X(m.i) + 3} y={h - 5} fontSize="9" fill="var(--dim)">{m.label}</text>
        </g>
      ))}
      {pts.length <= 80 && pts.map((p, i) => (
        <circle key={i} cx={X(i)} cy={Y(p.v)} r="1.8" fill="var(--volt)" opacity="0.55" />
      ))}
      <path d={path} fill="none" stroke="var(--volt)" strokeWidth="2" strokeLinecap="round" />
      <circle cx={X(pts.length - 1)} cy={Y(pts[pts.length - 1].v)} r="4"
        fill="var(--volt)" stroke="var(--raised)" strokeWidth="2" />
    </svg>
  );
}

/** One metric's full story — latest value, history chart with the reference
 * band shaded, the band/zone description, and the plain-words blurb. Rendered
 * inline under the Progress KPI grid (no navigation) and by the legacy
 * /metric deep-link screen. `chartOverride` swaps in a custom chart (VO₂max
 * keeps its raw-dots + quarterly-trend view) while the band text stays. */
export function MetricPanel({ mtype, chartOverride }: { mtype: string; chartOverride?: ReactNode }) {
  const { go, me } = useApp();
  const meta = METRIC_META[mtype];
  const q = useQuery<MetricHistory>({
    queryKey: ['metric-history', mtype],
    queryFn: () => api(`/api/metrics/${mtype}/history`),
    enabled: !!meta,
  });
  if (!meta) return <Chip>Unknown metric.</Chip>;
  const h = q.data;
  const unit = meta.unit(me.units);
  const pts = h?.points || [];
  const lastV = pts.length ? meta.disp(pts[pts.length - 1].v, me.units) : null;
  const firstD = pts.length ? pts[0].d : null;
  // profile-tuned band: sex + birth year come from Settings → About you
  const sex: Sex = me.prefs?.sex === 'm' || me.prefs?.sex === 'f' ? me.prefs.sex : null;
  const age = me.prefs?.birth_year ? new Date().getFullYear() - me.prefs.birth_year : null;
  const bandFor = meta.band ? meta.band(sex, age) : null;
  const band = bandFor?.range;
  const untuned = !!meta.band && (!sex || (age == null && mtype !== 'water_pct' && mtype !== 'resting_hr'));
  const inBand = lastV != null && band
    ? lastV >= meta.disp(band[0], me.units) && lastV <= meta.disp(band[1], me.units)
    : null;
  const bandWord = inBand == null ? null
    : inBand ? 'inside the reference range'
    : (lastV! > meta.disp(band![1], me.units)) === !!meta.higherBetter
      ? 'above the reference range' : 'below the reference range';
  return (
    <>
      <div className="card num">
        <div className="row">
          <span style={{ fontSize: 13.5, fontWeight: 600 }}>
            {meta.title}
            {firstD && <small style={{ color: 'var(--mut)', fontWeight: 400 }}> · since {firstD}</small>}
          </span>
          <span className="disp num" style={{ fontSize: 22, color: 'var(--volt)' }}>
            {lastV != null ? lastV : '—'}
            <small style={{ fontSize: 11.5, color: 'var(--mut)', fontWeight: 400 }}> {unit}</small>
          </span>
        </div>
        {!h && <Loading />}
        {h && (chartOverride
          ?? <BandChart points={pts} band={band ?? undefined} disp={meta.disp} units={me.units} />)}
        {band && bandFor && (
          <div className="sub">
            {chartOverride ? 'Reference' : 'Shaded'}: {meta.disp(band[0], me.units)}–{meta.disp(band[1], me.units)} {unit} · {bandFor.label}
            {bandWord && <> — you're <b style={{ color: inBand ? 'var(--volt)' : 'var(--warn)' }}>{bandWord}</b></>}
          </div>
        )}
        <p className="sub" style={{ lineHeight: 1.5 }}>{meta.blurb}</p>
      </div>
      {untuned && (
        <button className="lrow press" onClick={() => go('settings')}>
          <b>Tune this range to you</b>
          <span className="rsub">set sex & birth year · Settings → About you</span>
          <span className="chev">›</span>
        </button>
      )}
      {band && (
        <Chip>Reference ranges are broad healthy guidance, not targets or diagnosis — bring
          questions about your numbers to your GP.</Chip>
      )}
    </>
  );
}

export function MetricScreen() {
  const { openTab, lift: mtype } = useApp();
  const meta = METRIC_META[mtype];
  return (
    <Shell>
      <Back label="Progress" onClick={() => openTab('progress')} />
      <Title kick="All readings">{meta ? meta.title : 'Metric'}</Title>
      <MetricPanel mtype={mtype} />
    </Shell>
  );
}

export function ProgressScreen() {
  const { go, lift, me } = useApp();
  const q = useQuery<Progress>({ queryKey: ['progress'], queryFn: () => api('/api/progress') });
  const [selMetric, setSelMetric] = useState(
    () => localStorage.getItem('forge-progress-metric') || 'weight');
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
  const ringPct = p.week.planned ? Math.min(1, p.week.done / p.week.planned) : 0;
  const C = 2 * Math.PI * 27;
  return (
    <Shell>
      <Title kick="Trends">Progress</Title>

      {/* this week, at a glance */}
      <div className="card" style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <div className="ringwrap num">
          <svg viewBox="0 0 64 64">
            <circle cx="32" cy="32" r="27" fill="none" stroke="var(--sunken)" strokeWidth="7" />
            {ringPct > 0 && (
              <circle cx="32" cy="32" r="27" fill="none" stroke="var(--volt)" strokeWidth="7"
                strokeLinecap="round" strokeDasharray={`${C * ringPct} ${C}`} transform="rotate(-90 32 32)" />
            )}
          </svg>
          <div className="t"><b>{p.week.done}/{p.week.planned}</b><span>done</span></div>
        </div>
        <div>
          <b style={{ fontSize: 15 }}>This week</b>
          <div className="sub num" style={{ marginTop: 2 }}>
            {p.zone2.target
              ? `${Math.round(p.zone2.done)} of ${p.zone2.target} Zone-2 min banked`
              : 'no cardio prescribed this week'}
          </div>
        </div>
      </div>

      <div className="sect">Strength</div>
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
              <span className="disp num" style={{ fontSize: 20, color: 'var(--volt)' }}>
                {cur.points.length ? cur.points[cur.points.length - 1].v.toFixed(1) : '—'}
                <small style={{ fontSize: 11.5, color: 'var(--mut)', fontWeight: 400 }}> {liftU}</small>
              </span>
            </div>
            <LineChart points={cur.points} />
          </div>
        </>
      ) : <Chip>Log strength sessions to build the e1RM trend.</Chip>}
      <button className="lrow press num" onClick={() => go('records')}>
        <b>Records</b><span className="rsub">all-time bests per lift</span><span className="chev">›</span>
      </button>

      {/* Every health KPI in one grid; tapping a chip swaps the chart +
          band/zone description below it in place — no screen hopping. */}
      <div className="sect">Health</div>
      {(() => {
        const kpis: { type: string; k: string; v: string }[] = [
          { type: 'weight', k: 'Weight', v: wLast != null ? kgDisp(wLast, me.units) : '—' },
          { type: 'vo2max', k: 'VO₂max', v: vLast != null ? String(vLast) : '—' },
          { type: 'resting_hr', k: 'Resting HR',
            v: p.resting_hr.length ? `${Math.round(p.resting_hr[p.resting_hr.length - 1].v)} bpm` : '—' },
          { type: 'sleep_h', k: 'Sleep',
            v: p.sleep_h.length ? `${p.sleep_h[p.sleep_h.length - 1].v.toFixed(1)} h` : '—' },
        ];
        if (bc.fat_pct.length) kpis.push({ type: 'body_fat_pct', k: 'Fat %', v: `${last(bc.fat_pct)!.toFixed(1)}%` });
        if (bc.water_pct.length) kpis.push({ type: 'water_pct', k: 'Water %', v: `${last(bc.water_pct)!.toFixed(1)}%` });
        if (bc.muscle.length) kpis.push({ type: 'muscle_mass', k: 'Muscle', v: kgDisp(last(bc.muscle)!, me.units) });
        if (bc.bone.length) kpis.push({ type: 'bone_mass', k: 'Bone', v: kgDisp(last(bc.bone)!, me.units) });
        const selType = kpis.some((x) => x.type === selMetric) ? selMetric : 'weight';
        return (
          <>
            <div className="statchips num">
              {kpis.map((kpi) => {
                const on = selType === kpi.type;
                return (
                  <button key={kpi.type} className="statchip press"
                    style={on ? { background: 'var(--sel)' } : undefined}
                    onClick={() => {
                      setSelMetric(kpi.type);
                      localStorage.setItem('forge-progress-metric', kpi.type);
                    }}>
                    <div className="k" style={on ? { color: 'var(--volt)' } : undefined}>{kpi.k}</div>
                    <div className="v">{kpi.v}</div>
                  </button>
                );
              })}
            </div>
            <MetricPanel mtype={selType}
              chartOverride={selType === 'vo2max' && p.vo2max.length
                ? <DotTrendChart raw={p.vo2max} smooth={p.vo2max_smooth} />
                : undefined} />
          </>
        );
      })()}
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
