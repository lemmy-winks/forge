/* MuscleMap — front/back body silhouettes with the muscles an exercise hits.
   Primary muscles glow volt, secondary volt at low opacity; everything else
   stays a quiet raised tone. Region names map from the library's muscle labels. */

type Shape =
  | { e: [number, number, number, number] }          // ellipse cx cy rx ry
  | { r: [number, number, number, number, number] }; // rect x y w h rx

interface Region { view: 'front' | 'back'; shapes: Shape[]; }

// Coordinates live in a 60×140 space per view.
const sym = (cx: number, cy: number, rx: number, ry: number): Shape[] =>
  [{ e: [30 - (30 - cx), cy, rx, ry] }, { e: [30 + (30 - cx), cy, rx, ry] }];

const REGIONS: Record<string, Region> = {
  chest: { view: 'front', shapes: sym(24, 36, 6.5, 4.5) },
  'front delts': { view: 'front', shapes: sym(16.5, 29, 4, 3.2) },
  shoulders: { view: 'front', shapes: sym(16.5, 29, 4.5, 3.6) },
  biceps: { view: 'front', shapes: sym(13.5, 42, 3.2, 6) },
  forearms: { view: 'front', shapes: sym(11.5, 56, 2.8, 7) },
  abs: { view: 'front', shapes: [{ r: [25, 44, 10, 17, 3] }] },
  obliques: { view: 'front', shapes: sym(21.5, 50, 2.6, 7.5) },
  'hip flexors': { view: 'front', shapes: sym(25, 65, 3.6, 3.4) },
  hips: { view: 'front', shapes: sym(24.5, 65, 4, 3.6) },
  quads: { view: 'front', shapes: sym(24, 85, 4.6, 12) },
  'shins': { view: 'front', shapes: sym(24.5, 116, 3, 8.5) },
  traps: { view: 'back', shapes: [{ e: [30, 26, 8, 3.6] }] },
  'rear delts': { view: 'back', shapes: sym(16.5, 29, 4, 3.2) },
  'upper back': { view: 'back', shapes: [{ e: [30, 36, 9.5, 5.5] }] },
  back: { view: 'back', shapes: [{ e: [30, 45, 8.5, 7] }] },
  triceps: { view: 'back', shapes: sym(13.5, 42, 3.2, 6) },
  'lower back': { view: 'back', shapes: [{ e: [30, 57, 5.5, 4.5] }] },
  glutes: { view: 'back', shapes: sym(24.5, 68, 5, 4.6) },
  hamstrings: { view: 'back', shapes: sym(24, 88, 4.6, 11) },
  calves: { view: 'back', shapes: sym(24.5, 114, 3.6, 8.5) },
  grip: { view: 'front', shapes: sym(11.5, 56, 2.8, 7) },
};

// library label (lowercased) → region keys
const LABEL_MAP: Record<string, string[]> = {
  quads: ['quads'], glutes: ['glutes'], hamstrings: ['hamstrings'],
  core: ['abs', 'obliques', 'lower back'], abs: ['abs'], obliques: ['obliques'],
  'lower back': ['lower back'], 'hip flexors': ['hip flexors'], hips: ['hips', 'glutes'],
  chest: ['chest'], triceps: ['triceps'], biceps: ['biceps'], forearms: ['forearms'],
  grip: ['grip'], shoulders: ['shoulders', 'rear delts'], 'front delts': ['front delts'],
  'rear delts': ['rear delts'], back: ['back', 'upper back'], 'upper back': ['upper back'],
  traps: ['traps'], calves: ['calves', 'shins'], legs: ['quads', 'hamstrings', 'calves'],
};

function regionsFor(labels: string[]): Set<string> {
  const out = new Set<string>();
  for (const l of labels) for (const r of LABEL_MAP[l.toLowerCase()] || []) out.add(r);
  return out;
}

function Silhouette({ x }: { x: number }) {
  // head, torso, arms, legs — soft blocky humanoid in a quiet tone
  return (
    <g transform={`translate(${x},0)`} fill="#17191d">
      <circle cx="30" cy="11" r="7.5" />
      <rect x="26.5" y="17" width="7" height="6" rx="2" />
      <rect x="17" y="22" width="26" height="42" rx="9" />
      <rect x="9.5" y="25" width="8.5" height="26" rx="4.2" />
      <rect x="42" y="25" width="8.5" height="26" rx="4.2" />
      <rect x="8.5" y="48" width="6.5" height="18" rx="3.2" />
      <rect x="45" y="48" width="6.5" height="18" rx="3.2" />
      <rect x="18" y="60" width="24" height="14" rx="6" />
      <rect x="18.5" y="70" width="10.5" height="34" rx="5" />
      <rect x="31" y="70" width="10.5" height="34" rx="5" />
      <rect x="19.5" y="102" width="9" height="26" rx="4.4" />
      <rect x="31.5" y="102" width="9" height="26" rx="4.4" />
      <rect x="18.5" y="127" width="10.5" height="5" rx="2.5" />
      <rect x="31" y="127" width="10.5" height="5" rx="2.5" />
    </g>
  );
}

function RegionShapes({ x, names, active, color, opacity }: {
  x: number; names: Set<string>; active: 'front' | 'back'; color: string; opacity: number;
}) {
  return (
    <g transform={`translate(${x},0)`} fill={color} opacity={opacity}>
      {[...names].filter((n) => REGIONS[n]?.view === active).map((n) =>
        REGIONS[n].shapes.map((s, i) =>
          'e' in s
            ? <ellipse key={n + i} cx={s.e[0]} cy={s.e[1]} rx={s.e[2]} ry={s.e[3]} />
            : <rect key={n + i} x={s.r[0]} y={s.r[1]} width={s.r[2]} height={s.r[3]} rx={s.r[4]} />,
        ))}
    </g>
  );
}

export function MuscleMap({ primary, secondary }: { primary: string[]; secondary: string[] }) {
  const prim = regionsFor(primary);
  const sec = regionsFor(secondary);
  for (const n of prim) sec.delete(n); // primary wins
  return (
    <svg viewBox="0 0 140 148"
      style={{ width: '100%', maxWidth: 260, aspectRatio: '140 / 148', display: 'block', margin: '0 auto' }}>
      {(['front', 'back'] as const).map((view, vi) => {
        const x = vi === 0 ? 5 : 75;
        return (
          <g key={view}>
            <Silhouette x={x} />
            <RegionShapes x={x} names={sec} active={view} color="var(--volt)" opacity={0.28} />
            <RegionShapes x={x} names={prim} active={view} color="var(--volt)" opacity={0.92} />
            <text x={x + 30} y="143" textAnchor="middle" fill="var(--dim)" fontSize="5.4"
              letterSpacing="0.8" style={{ textTransform: 'uppercase' }}>{view}</text>
          </g>
        );
      })}
    </svg>
  );
}
