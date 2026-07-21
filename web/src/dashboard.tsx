/* Desktop dashboard (E14.1): trends at width, same queries the agent uses.
   Void×Volt: one hue, one axis per chart, direct labels, no borders. */
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import {
  api, kgDisp, kgToDisp, lipidDisp, loadUnitFor,
  type Dashboard, type Me, type SeriesPoint,
} from './api';
import { smoothPath } from './chart';

const W = 320, H = 110;

function scales(vals: number[], pad = 1) {
  const min = Math.min(...vals) - pad, max = Math.max(...vals) + pad;
  return { min, max, Y: (v: number) => (H - 16) - ((v - min) / (max - min || 1)) * (H - 32) };
}
const X = (i: number, n: number) => 10 + (i * (W - 20)) / Math.max(1, n - 1);

function Line({ points, goal, unit }: { points: SeriesPoint[]; goal?: number | null; unit?: string }) {
  if (points.length < 2) return <div className="sub">Not enough data yet.</div>;
  const vals = points.map((p) => p.v).concat(goal != null ? [goal] : []);
  const { Y } = scales(vals);
  const path = smoothPath(points.map((p, i) => [X(i, points.length), Y(p.v)]));
  const last = points[points.length - 1];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="dchart">
      {goal != null && (
        <g>
          <line x1="10" x2={W - 10} y1={Y(goal)} y2={Y(goal)} stroke="var(--hair)"
            strokeWidth="1" strokeDasharray="4 4" />
          <text x="10" y={Y(goal) - 4} fill="var(--dim)" fontSize="9">goal {goal}</text>
        </g>
      )}
      <path d={path} fill="none" stroke="var(--volt)" strokeWidth="2" strokeLinecap="round" />
      {points.map((p, i) => (
        <circle key={i} cx={X(i, points.length)} cy={Y(p.v)} r="2" fill="var(--volt)" opacity="0.9" />
      ))}
      {points.map((p, i) => (
        <circle key={'h' + i} cx={X(i, points.length)} cy={Y(p.v)} r="6" fill="transparent">
          <title>{p.d}: {p.v}{unit ? ' ' + unit : ''}</title>
        </circle>
      ))}
      <circle cx={X(points.length - 1, points.length)} cy={Y(last.v)} r="3.5"
        fill="var(--volt)" stroke="var(--raised)" strokeWidth="2" />
      <text x={W - 10} y={Y(last.v) - 7} textAnchor="end" fill="var(--ink)" fontSize="11"
        fontWeight="600">{last.v.toFixed(1)}</text>
    </svg>
  );
}

function DotTrend({ raw, smooth }: { raw: SeriesPoint[]; smooth: SeriesPoint[] }) {
  if (raw.length < 2) return <div className="sub">Waiting for Watch readings.</div>;
  const { Y } = scales(raw.map((p) => p.v).concat(smooth.map((p) => p.v)), 0.5);
  const path = smoothPath(smooth.map((p, i) => [X(i, raw.length), Y(p.v)]));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="dchart">
      {raw.map((p, i) => (
        <circle key={i} cx={X(i, raw.length)} cy={Y(p.v)} r="2.5" fill="var(--dim)">
          <title>{p.d}: {p.v}</title>
        </circle>
      ))}
      <path d={path} fill="none" stroke="var(--volt)" strokeWidth="2" strokeLinecap="round" />
      <text x={W - 10} y={Y(smooth[smooth.length - 1].v) - 7} textAnchor="end" fill="var(--ink)"
        fontSize="11" fontWeight="600">{smooth[smooth.length - 1].v.toFixed(1)}</text>
    </svg>
  );
}

function Bars({ data, target, unit }: { data: { week: string; v: number }[]; target?: number; unit: string }) {
  const max = Math.max(...data.map((d) => d.v), target || 0, 1);
  const bw = (W - 20) / data.length;
  const Y = (v: number) => (H - 16) - (v / max) * (H - 34);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="dchart">
      {target != null && target > 0 && (
        <g>
          <line x1="10" x2={W - 10} y1={Y(target)} y2={Y(target)} stroke="var(--hair)"
            strokeWidth="1" strokeDasharray="4 4" />
          <text x="10" y={Y(target) - 4} fill="var(--dim)" fontSize="9">target {target}</text>
        </g>
      )}
      {data.map((d, i) => {
        const h = Math.max(0, (H - 16) - Y(d.v));
        return (
          <g key={d.week}>
            <rect x={10 + i * bw + 1} y={Y(d.v)} width={bw - 2} height={h || 1}
              rx="2" fill={d.v ? 'var(--volt)' : 'var(--hair)'}
              opacity={i === data.length - 1 ? 1 : 0.75}>
              <title>w/c {d.week}: {d.v} {unit}</title>
            </rect>
          </g>
        );
      })}
      {data[data.length - 1].v > 0 && (
        <text x={10 + (data.length - 1) * bw + bw / 2} y={Y(data[data.length - 1].v) - 4}
          textAnchor="middle" fill="var(--ink)" fontSize="10" fontWeight="600">
          {data[data.length - 1].v}
        </text>
      )}
    </svg>
  );
}

function Heatmap({ rows }: { rows: Dashboard['heatmap'] }) {
  const DAY = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
  return (
    <div className="hm num">
      <div className="hm-row hm-head">
        <span className="hm-lbl" />
        {DAY.map((d, i) => <span key={i} className="hm-lbl">{d}</span>)}
      </div>
      {rows.map((r) => (
        <div key={r.week} className="hm-row">
          <span className="hm-lbl">{r.week.slice(5)}</span>
          {r.days.map((c) => (
            <span key={c.d} className={'hm-cell hm-' + c.s} title={c.d + ' · ' + c.s} />
          ))}
        </div>
      ))}
      <div className="sub" style={{ display: 'flex', gap: 14, marginTop: 8 }}>
        <span><span className="hm-cell hm-done hm-key" /> trained</span>
        <span><span className="hm-cell hm-missed hm-key" /> planned, missed</span>
        <span><span className="hm-cell hm-off hm-key" /> rest</span>
      </div>
    </div>
  );
}

function Lipids({ lipids, unit }: { lipids: Dashboard['lipids']; unit: string }) {
  const markers = Object.keys(lipids);
  if (!markers.length) return <div className="sub">No lab panels yet — add them in the app under Settings → Labs.</div>;
  return (
    <div className="lipids num">
      {markers.map((m) => {
        const pts = lipids[m];
        const last = pts[pts.length - 1];
        const inRange = (last.ref_high == null || last.v <= last.ref_high)
          && (last.ref_low == null || last.v >= last.ref_low);
        return (
          <div key={m} className="lip-row">
            <span className="lip-name">{m}</span>
            <span className="lip-track">
              {pts.map((p, i) => (
                <span key={i} className="lip-dot" title={`${p.d}: ${lipidDisp(m, p.v, unit)}`}
                  style={{ opacity: 0.35 + 0.65 * (i / Math.max(1, pts.length - 1)) }} />
              ))}
            </span>
            <span className={'lip-val ' + (inRange ? 'up' : 'warn')}>
              {lipidDisp(m, last.v, unit)} {inRange ? '· in range' : '· out of range'}
            </span>
          </div>
        );
      })}
      <div className="sub">Trends only — decisions belong in a GP conversation.</div>
    </div>
  );
}

function Panel({ title, sub, children, wide }: {
  title: string; sub?: string; children: React.ReactNode; wide?: boolean;
}) {
  return (
    <section className={'panel' + (wide ? ' wide' : '')}>
      <div className="row">
        <span className="xname" style={{ fontSize: 15 }}>{title}</span>
        {sub && <span style={{ fontSize: 12.5, color: 'var(--mut)' }}>{sub}</span>}
      </div>
      {children}
    </section>
  );
}

function DashInner() {
  const meQ = useQuery<Me>({ queryKey: ['me'], queryFn: () => api('/auth/me'), retry: false });
  const q = useQuery<Dashboard>({
    queryKey: ['dashboard'], queryFn: () => api('/api/dashboard'), enabled: !!meQ.data,
  });
  if (meQ.isLoading) return <div className="boot">FORGE<span>.</span></div>;
  if (!meQ.data) {
    return (
      <div className="authbody">
        <div className="wordmark">FORGE<i>.</i> <span className="betatag">BETA</span></div>
        <p className="tagline">Sign in in the app first, then reload this page.</p>
        <a className="cta" style={{ padding: '12px 28px' }} href="/">Open Forge</a>
      </div>
    );
  }
  const d = q.data;
  if (!d) return <div className="boot">FORGE<span>.</span></div>;
  const wLast = d.weight.length ? d.weight[d.weight.length - 1].v : null;
  const vLast = d.vo2max_smooth.length ? d.vo2max_smooth[d.vo2max_smooth.length - 1].v : null;
  const z2 = d.zone2_weekly.length ? d.zone2_weekly[d.zone2_weekly.length - 1].v : 0;
  const ton = d.tonnage_weekly.length ? d.tonnage_weekly[d.tonnage_weekly.length - 1].v : 0;
  const lifts = Object.entries(d.e1rm);
  return (
    <div className="dash">
      <header className="dash-hdr">
        <span className="wm">FORGE<i>.</i></span><span className="betatag">BETA</span>
        <span className="kick" style={{ fontSize: 14 }}>{d.name} · Dashboard</span>
        <span className="sp" />
        <a href="/" className="back" style={{ alignSelf: 'center' }}>‹ App</a>
      </header>
      <div className="tiles dash-tiles num">
        <div className="tile"><div className="k">Sessions</div>
          <div className="v disp">{d.week.done}<small>/{d.week.planned}</small></div>
          <div className="d">this week</div></div>
        <div className="tile"><div className="k">Tonnage</div>
          <div className="v disp">{ton}<small> t</small></div>
          <div className="d">this week</div></div>
        <div className="tile"><div className="k">Zone 2</div>
          <div className="v disp">{Math.round(z2)}<small>/{d.zone2_target} min</small></div>
          <div className="d">this week vs target</div></div>
        <div className="tile"><div className="k">Bodyweight</div>
          <div className="v disp">{wLast != null ? kgDisp(wLast, d.units) : '—'}</div>
          <div className="d">{d.goal_weight_kg ? `goal ${d.goal_weight_kg} kg` : 'latest'}</div></div>
        <div className="tile"><div className="k">VO₂max</div>
          <div className="v disp">{vLast != null ? vLast.toFixed(1) : '—'}</div>
          <div className="d">smoothed trend</div></div>
      </div>
      <div className="dash-grid num">
        {lifts.map(([slug, s]) => {
          const u = loadUnitFor({ unit_load: d.unit_load, load_units: d.load_units }, slug);
          return (
            <Panel key={slug} title={s.name + ' · e1RM'} sub={u}>
              <Line points={s.points.map((p) => ({ ...p, v: kgToDisp(p.v, u) }))} unit={u} />
            </Panel>
          );
        })}
        <Panel title="Bodyweight" sub="kg">
          <Line points={d.weight} goal={d.goal_weight_kg} unit="kg" />
        </Panel>
        <Panel title="Weekly tonnage" sub="t · 12 weeks">
          <Bars data={d.tonnage_weekly} unit="t" />
        </Panel>
        <Panel title="VO₂max" sub="raw + trend · ml/kg/min">
          <DotTrend raw={d.vo2max} smooth={d.vo2max_smooth} />
        </Panel>
        <Panel title="Zone 2 minutes" sub="weekly vs target">
          <Bars data={d.zone2_weekly} target={d.zone2_target} unit="min" />
        </Panel>
        <Panel title="Resting HR" sub="bpm">
          <Line points={d.resting_hr} unit="bpm" />
        </Panel>
        {d.bodycomp.fat_pct.length >= 2 && (
          <Panel title="Body fat" sub="% · scale readings">
            <Line points={d.bodycomp.fat_pct} unit="%" />
          </Panel>
        )}
        {(d.bodycomp.muscle.length > 0 || d.bodycomp.water_pct.length > 0) && (
          <Panel title="Body composition" sub="latest">
            <div className="lipids num">
              {([['Muscle', d.bodycomp.muscle, 'mass'],
                 ['Water', d.bodycomp.water_pct, '%'],
                 ['Bone', d.bodycomp.bone, 'mass']] as const).map(([k, s, kind]) => (
                <div key={k} className="lip-row">
                  <span className="lip-name">{k}</span>
                  <span className="lip-track" />
                  <span className="lip-val">
                    {s.length ? (kind === '%' ? s[s.length - 1].v.toFixed(1) + ' %' : kgDisp(s[s.length - 1].v, d.units)) : '—'}
                  </span>
                </div>
              ))}
            </div>
          </Panel>
        )}
        <Panel title="Lipids">
          <Lipids lipids={d.lipids} unit={d.unit_lipids} />
        </Panel>
        <Panel title="Consistency" sub="12 weeks" wide>
          <Heatmap rows={d.heatmap} />
        </Panel>
      </div>
    </div>
  );
}

const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });

export default function DashboardApp() {
  return <QueryClientProvider client={qc}><DashInner /></QueryClientProvider>;
}
