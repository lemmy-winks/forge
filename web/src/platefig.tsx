/* Plate-art engine (E16.2 AC4): palette-native SVG meal illustrations, the
   formfig approach — shared plate/tray/bowl primitives + per-recipe
   compositions keyed by `recipes.platefig`. Tokens only, so Paper × Moss
   light mode adapts for free. No food photography anywhere. */

import type { ReactNode } from 'react';

const RIM = 'var(--hair)';
const WELL = 'var(--bg)';
const FOOD = 'var(--mut)';       // main food mass
const FOOD_DIM = 'var(--dim)';   // shadow food / beans
const LIGHT = 'var(--ink)';      // pale food (fish, yogurt) — used with opacity
const VOLT = 'var(--volt)';      // greens & garnish only

/* ---- primitives (viewBox 0 0 40 40) ---- */
const Plate = ({ well = true }: { well?: boolean }) => (
  <>
    <circle cx="20" cy="20" r="17" fill={RIM} />
    {well && <circle cx="20" cy="20" r="13" fill={WELL} />}
  </>
);
const Bowl = () => (
  <>
    <circle cx="20" cy="20" r="16.5" fill={RIM} />
    <circle cx="20" cy="20" r="12" fill={WELL} />
  </>
);
const Tray = () => (
  <>
    <rect x="4" y="8" width="32" height="24" rx="5" fill={RIM} />
    <rect x="7.5" y="11.5" width="25" height="17" rx="3" fill={WELL} />
  </>
);
const Leaf = ({ x, y, o = 0.85, r = 0 }: { x: number; y: number; o?: number; r?: number }) => (
  <ellipse cx={x} cy={y} rx="2.6" ry="1.4" fill={VOLT} opacity={o} transform={`rotate(${r} ${x} ${y})`} />
);
const Dot = ({ x, y, r = 1.3, f = FOOD_DIM, o = 1 }: { x: number; y: number; r?: number; f?: string; o?: number }) => (
  <circle cx={x} cy={y} r={r} fill={f} opacity={o} />
);

/* ---- compositions ---- */
const COMPS: Record<string, ReactNode> = {
  'tray-chicken': (
    <>
      <Tray />
      <ellipse cx="15" cy="17" rx="4.6" ry="3.4" fill={FOOD} />
      <ellipse cx="25" cy="22" rx="4.6" ry="3.4" fill={FOOD} />
      <Dot x={22} y={15} /><Dot x={12} y={24} /><Dot x={18} y={25.5} r={1.2} /><Dot x={28} y={15.5} r={1.2} />
      <Leaf x={30} y={26} r={-24} /><Leaf x={10.5} y={14} o={0.55} r={18} />
    </>
  ),
  'pan-skillet': (
    <>
      <circle cx="18" cy="20" r="14.5" fill={RIM} />
      <circle cx="18" cy="20" r="11" fill={WELL} />
      <rect x="31" y="18.6" width="8" height="2.8" rx="1.4" fill={RIM} />
      <Dot x={14} y={17} r={2.6} f={FOOD} /><Dot x={21} y={23} r={2.6} f={FOOD} />
      <Dot x={22} y={15.5} r={2} /><Dot x={13} y={23.5} r={2} />
      <Leaf x={18} y={20} o={0.8} r={-15} />
    </>
  ),
  'plate-salmon': (
    <>
      <Plate />
      <ellipse cx="21" cy="24" rx="9.5" ry="5" fill={RIM} opacity="0.7" />
      <Dot x={17} y={24} r={1.2} /><Dot x={24} y={25} r={1.1} />
      <g transform="rotate(-10 19 17)">
        <rect x="10" y="13" width="17" height="8" rx="4" fill={FOOD} />
        <rect x="13.5" y="14.5" width="1.4" height="5" rx="0.7" fill={LIGHT} opacity="0.75" />
        <rect x="18.5" y="14.5" width="1.4" height="5" rx="0.7" fill={LIGHT} opacity="0.75" />
        <rect x="23.5" y="14.5" width="1.4" height="5" rx="0.7" fill={LIGHT} opacity="0.75" />
      </g>
      <Dot x={30} y={17} r={2.6} f={VOLT} o={0.9} /><Dot x={32.5} y={22} r={2} f={VOLT} o={0.55} />
    </>
  ),
  'plate-chicken': (
    <>
      <Plate />
      <ellipse cx="17" cy="19" rx="6" ry="4.4" fill={FOOD} />
      <Dot x={14.5} y={17.5} r={1.4} /><Dot x={19.5} y={20.5} r={1.2} />
      <ellipse cx="26" cy="24" rx="5" ry="3.4" fill={RIM} opacity="0.8" />
      <Dot x={25} y={23.5} r={1.2} /><Dot x={28} y={25} r={1.1} />
      <Leaf x={27} y={14.5} r={-20} /><Leaf x={13} y={26.5} o={0.55} r={22} />
    </>
  ),
  'plate-salad': (
    <>
      <Plate />
      <ellipse cx="20" cy="20" rx="10" ry="8" fill={RIM} opacity="0.6" />
      <Dot x={15} y={18} r={1.6} /><Dot x={21} y={23} r={1.5} /><Dot x={25} y={17.5} r={1.5} />
      <Dot x={17} y={24.5} r={1.3} />
      <Dot x={23} y={14.5} r={1.8} f={LIGHT} o={0.7} /><Dot x={14} y={22} r={1.6} f={LIGHT} o={0.6} />
      <Leaf x={26.5} y={22.5} r={-30} /><Leaf x={13.5} y={15} o={0.65} r={15} /><Leaf x={20} y={26.5} o={0.8} r={8} />
    </>
  ),
  'plate-eggs': (
    <>
      <Plate />
      <circle cx="16" cy="18" r="5" fill={LIGHT} opacity="0.8" />
      <circle cx="16" cy="18" r="2.1" fill={FOOD} />
      <circle cx="24.5" cy="23" r="4.4" fill={LIGHT} opacity="0.7" />
      <circle cx="24.5" cy="23" r="1.9" fill={FOOD} />
      <Leaf x={26} y={14.5} r={-18} /><Leaf x={12.5} y={25} o={0.6} r={25} />
    </>
  ),
  'bowl-chili': (
    <>
      <Bowl />
      <ellipse cx="20" cy="21" rx="9.5" ry="7.5" fill={RIM} opacity="0.85" />
      <Dot x={16} y={19} r={1.6} /><Dot x={21} y={24} r={1.5} /><Dot x={24.5} y={18.5} r={1.5} />
      <Dot x={17.5} y={24.5} r={1.3} f={FOOD} />
      <path d="M13 16 A9 9 0 0 1 27 15 L24 18 A6 6 0 0 0 16 18.5 Z" fill={FOOD} />
      <Dot x={26} y={24} r={1.1} f={VOLT} o={0.9} /><Dot x={14.5} y={21.5} r={1} f={VOLT} o={0.6} />
    </>
  ),
  'bowl-soba': (
    <>
      <Bowl />
      <path d="M11 19 Q16 15 21 19 T30 19" fill="none" stroke={FOOD} strokeWidth="1.5" />
      <path d="M11 23 Q16 19 21 23 T30 23" fill="none" stroke={FOOD_DIM} strokeWidth="1.5" />
      <path d="M12 26.5 Q17 23 22 26.5 T29 26" fill="none" stroke={FOOD} strokeWidth="1.4" />
      <path d="M23 13 a4 4 0 0 1 5 5" fill="none" stroke={LIGHT} strokeWidth="2.4" strokeLinecap="round" opacity="0.8" />
      <path d="M13 14.5 a3.6 3.6 0 0 1 4.6 4" fill="none" stroke={LIGHT} strokeWidth="2.2" strokeLinecap="round" opacity="0.7" />
      <Leaf x={30} y={14.5} o={0.8} r={-30} />
    </>
  ),
  'bowl-stew': (
    <>
      <Bowl />
      <ellipse cx="20" cy="21" rx="10" ry="7.5" fill={RIM} opacity="0.75" />
      <Dot x={14.5} y={21} r={1.4} /><Dot x={18} y={25} r={1.3} /><Dot x={26} y={23.5} r={1.4} />
      <g transform="rotate(-6 20 18)">
        <rect x="13" y="14" width="14" height="7.5" rx="3.2" fill={LIGHT} opacity="0.8" />
        <rect x="17" y="15.2" width="1.2" height="5" rx="0.6" fill={FOOD} opacity="0.6" />
        <rect x="21.5" y="15.2" width="1.2" height="5" rx="0.6" fill={FOOD} opacity="0.6" />
      </g>
      <Leaf x={28.5} y={15.5} r={-20} /><Dot x={12} y={15} r={1} f={VOLT} o={0.55} />
    </>
  ),
  'bowl-pasta': (
    <>
      <Bowl />
      <path d="M12 18 Q17 14 22 18 T29 18" fill="none" stroke={FOOD} strokeWidth="1.7" />
      <path d="M11.5 22 Q16.5 18 21.5 22 T29.5 22" fill="none" stroke={FOOD} strokeWidth="1.7" opacity="0.75" />
      <path d="M13 25.5 Q18 22 23 25.5 T28.5 25" fill="none" stroke={FOOD_DIM} strokeWidth="1.6" />
      <Dot x={16} y={16.5} r={2.2} f={FOOD_DIM} /><Dot x={24} y={20} r={2.2} f={FOOD_DIM} />
      <Leaf x={27} y={14.5} r={-25} />
    </>
  ),
  'bowl-grain': (
    <>
      <Bowl />
      <path d="M8.5 20 A11.5 11.5 0 0 1 31.5 20 Z" fill={RIM} opacity="0.9" transform="rotate(180 20 20)" />
      <rect x="12" y="13" width="16" height="6" rx="3" fill={FOOD} transform="rotate(-14 20 16)" />
      <rect x="24" y="21" width="8" height="3.4" rx="1.7" fill={VOLT} opacity="0.85" transform="rotate(20 28 23)" />
      <Dot x={13} y={23} r={2} /><Dot x={17.5} y={25.5} r={2} />
      <Dot x={26} y={26} r={2.4} f={VOLT} o={0.5} />
    </>
  ),
  'bowl-oats': (
    <>
      <Bowl />
      <circle cx="20" cy="20" r="10" fill={RIM} opacity="0.9" />
      <Dot x={16} y={18} r={1.5} f={LIGHT} o={0.7} /><Dot x={22} y={22} r={1.4} f={LIGHT} o={0.6} />
      <Dot x={24} y={16} r={1.9} f={VOLT} o={0.9} /><Dot x={17} y={23} r={1.7} f={VOLT} o={0.6} />
      <Dot x={21} y={14} r={1.5} f={VOLT} o={0.75} />
    </>
  ),
  'snack-apple': (
    <>
      <circle cx="17" cy="22" r="9" fill={FOOD_DIM} />
      <circle cx="14.5" cy="19" r="3" fill={FOOD} opacity="0.7" />
      <rect x="16.2" y="10.5" width="1.7" height="4.5" rx="0.8" fill={FOOD} />
      <Leaf x={21.5} y={11.5} r={28} />
      <circle cx="30" cy="26" r="5" fill={RIM} />
      <circle cx="30" cy="25" r="3.2" fill={FOOD} />
    </>
  ),
  'snack-nuts': (
    <>
      <Bowl />
      <ellipse cx="16" cy="19" rx="2.6" ry="1.8" fill={FOOD} transform="rotate(-20 16 19)" />
      <ellipse cx="22" cy="21.5" rx="2.6" ry="1.8" fill={FOOD_DIM} transform="rotate(15 22 21.5)" />
      <ellipse cx="25" cy="17" rx="2.4" ry="1.7" fill={FOOD} transform="rotate(40 25 17)" />
      <ellipse cx="18" cy="24.5" rx="2.4" ry="1.7" fill={FOOD} transform="rotate(-35 18 24.5)" />
    </>
  ),
  'snack-yogurt': (
    <>
      <rect x="12" y="10" width="16" height="20" rx="4" fill={RIM} />
      <rect x="14.5" y="13" width="11" height="14" rx="2.5" fill={WELL} />
      <ellipse cx="20" cy="17" rx="4.6" ry="2.8" fill={LIGHT} opacity="0.75" />
      <Dot x={18} y={16} r={1.2} f={VOLT} o={0.9} /><Dot x={22} y={17.5} r={1.1} f={VOLT} o={0.6} />
    </>
  ),
  out: (
    <>
      <circle cx="20" cy="20" r="15.5" fill="none" stroke={RIM} strokeWidth="1.8" strokeDasharray="3.2 3.4" />
      <rect x="15" y="13.5" width="1.8" height="13" rx="0.9" fill={FOOD_DIM} transform="rotate(-22 16 20)" />
      <rect x="23.2" y="13.5" width="1.8" height="13" rx="0.9" fill={FOOD_DIM} transform="rotate(22 24 20)" />
    </>
  ),
  plate: (
    <>
      <Plate />
      <Dot x={17} y={19} r={3.4} f={FOOD} /><Dot x={24} y={23} r={2.6} f={FOOD_DIM} />
      <Leaf x={25} y={15.5} r={-20} />
    </>
  ),
};

export function PlateFig({ id, size = 30, dim = false }: { id: string; size?: number; dim?: boolean }) {
  return (
    <svg viewBox="0 0 40 40" width={size} height={size} aria-hidden="true"
      style={{ flex: 'none', opacity: dim ? 0.55 : 1 }}>
      {COMPS[id] || COMPS.plate}
    </svg>
  );
}
