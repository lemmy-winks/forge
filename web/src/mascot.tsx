/* CoachMascot — Rep, a chunky little strongman who sometimes hops up onto the
   chat bar to keep the coach thread company. Tap him and he busts out a mini
   workout — the move, rep count and tempo are re-rolled every time, so no two
   sets look quite the same — then he flexes and drops a one-liner.

   Purely cosmetic: CSS keyframes in styles.css (".mascot" block) drive all the
   motion; this component only decides when he shows up and what plays next.
   Settings → Appearance owns the on/off switch (prefs.mascot, default on);
   localStorage 'forge-mascot' = 'always' | 'never' is a dev knob on top. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from './ui';

const MOVES = ['squat', 'press', 'curl', 'jacks', 'pushup'] as const;
type Move = (typeof MOVES)[number];

const QUIPS = [
  'light weight!',
  'new PR, probably',
  'phew — one more set?',
  'do NOT skip leg day',
  "that's just the warm-up",
  'coach says: hydrate',
  'felt heavy, lifted anyway',
  'protein o’clock',
];

interface Set_ { move: Move; reps: number; spd: number }

const CHANCE_FIRST = 0.55;   // odds he shows on opening the coach tab
const CHANCE_LATER = 0.35;   // odds per later re-roll while you linger

export function CoachMascot() {
  const { me } = useApp();
  const enabled = me.prefs?.mascot !== false;
  const [phase, setPhase] = useState<'hidden' | 'enter' | 'leave'>('hidden');
  const [set, setSet] = useState<Set_ | null>(null);
  const [flexQuip, setFlexQuip] = useState<string | null>(null);
  const [leftPct, setLeftPct] = useState(20);
  const lastMove = useRef<Move | null>(null);
  const leaveTimer = useRef<number>(0);
  const busy = set !== null || flexQuip !== null;

  // he wanders off if ignored; every tap earns him another stretch on the bar
  const armLeave = useCallback(() => {
    window.clearTimeout(leaveTimer.current);
    leaveTimer.current = window.setTimeout(() => {
      setPhase((p) => (p === 'enter' ? 'leave' : p));
    }, 28000 + Math.random() * 17000);
  }, []);

  useEffect(() => {
    const pref = localStorage.getItem('forge-mascot');
    if (!enabled || pref === 'never') return;
    const timers: number[] = [];
    const appear = () => {
      setLeftPct(12 + Math.random() * 58); // lands somewhere new each visit
      setPhase('enter');
      armLeave();
    };
    const roll = (chance: number) => {
      if (pref === 'always' || Math.random() < chance) {
        timers.push(window.setTimeout(appear, 1500 + Math.random() * 4000));
      } else {
        // missed the dice roll — quietly try again in a couple of minutes
        timers.push(window.setTimeout(() => roll(CHANCE_LATER), 90000 + Math.random() * 120000));
      }
    };
    roll(CHANCE_FIRST);
    return () => { timers.forEach(clearTimeout); window.clearTimeout(leaveTimer.current); };
  }, [armLeave, enabled]);

  // 'leave' plays the drop animation, then he's gone until the next visit
  useEffect(() => {
    if (phase !== 'leave') return;
    const t = window.setTimeout(() => setPhase('hidden'), 600);
    return () => clearTimeout(t);
  }, [phase]);

  const workout = () => {
    if (busy || phase !== 'enter') return;
    armLeave();
    const pool = MOVES.filter((m) => m !== lastMove.current);
    const move = pool[Math.floor(Math.random() * pool.length)];
    lastMove.current = move;
    setSet({ move, reps: 3 + Math.floor(Math.random() * 3), spd: 550 + Math.round(Math.random() * 350) });
  };

  // the torso carries the rep-counting animation for every move — when it
  // finishes, the set is done and he celebrates
  const onSetDone = (e: React.AnimationEvent) => {
    if (!set || !(e.animationName || '').startsWith('m-rep')) return;
    setSet(null);
    setFlexQuip(QUIPS[Math.floor(Math.random() * QUIPS.length)]);
    window.setTimeout(() => setFlexQuip(null), 1900);
  };

  if (!enabled || phase === 'hidden') return null;
  const dataMove = set ? set.move : flexQuip ? 'flex' : undefined;

  return (
    <button
      className={`mascot ${phase === 'leave' ? 'leave' : ''}`}
      style={{ left: `${leftPct}%`, '--spd': `${set?.spd ?? 700}ms`, '--reps': set?.reps ?? 1 } as React.CSSProperties}
      data-move={dataMove}
      aria-label="Rep the mascot — tap for a workout"
      onClick={workout}
    >
      {flexQuip && <span className="m-quip">{flexQuip}</span>}
      <span className="m-fig">
        {/* pixel sprite on a 4px grid — crispEdges keeps every cell square */}
        <svg viewBox="0 0 72 72" aria-hidden="true" shapeRendering="crispEdges">
          <rect className="m-shadow" x="22" y="66" width="28" height="3" fill="var(--hair)" />
          <g className="m-all" onAnimationEnd={onSetDone}>
            {/* stubby legs */}
            <rect className="m-leg m-legL" x="24" y="52" width="8" height="13" fill="var(--volt)" />
            <rect className="m-leg m-legR" x="40" y="52" width="8" height="13" fill="var(--volt)" />
            {/* stub arms (dumbbells ride inside so curls carry them) */}
            <g className="m-arm m-armL">
              <rect x="10" y="28" width="8" height="13" fill="var(--volt)" />
              <g className="m-db">
                <rect x="6" y="39" width="16" height="3" fill="var(--dim)" />
                <rect x="4" y="36" width="4" height="9" fill="var(--mut)" />
                <rect x="20" y="36" width="4" height="9" fill="var(--mut)" />
              </g>
            </g>
            <g className="m-arm m-armR">
              <rect x="54" y="28" width="8" height="13" fill="var(--volt)" />
              <g className="m-db">
                <rect x="50" y="39" width="16" height="3" fill="var(--dim)" />
                <rect x="48" y="36" width="4" height="9" fill="var(--mut)" />
                <rect x="64" y="36" width="4" height="9" fill="var(--mut)" />
              </g>
            </g>
            {/* one blocky body: head and torso are the same slab, ear nubs on top */}
            <rect x="24" y="16" width="4" height="4" fill="var(--volt)" />
            <rect x="44" y="16" width="4" height="4" fill="var(--volt)" />
            <rect x="20" y="20" width="32" height="32" fill="var(--volt)" />
            <rect x="20" y="24" width="32" height="4" fill="var(--on-volt)" opacity="0.9" />
            <rect className="m-eye" x="26" y="32" width="4" height="5" fill="var(--on-volt)" />
            <rect className="m-eye" x="42" y="32" width="4" height="5" fill="var(--on-volt)" />
            <rect className="m-smile" x="30" y="44" width="12" height="3" fill="var(--on-volt)" />
            <rect className="m-grit" x="33" y="42" width="6" height="6" fill="var(--on-volt)" />
            {/* barbell (front rack for squats, chest→overhead for presses) */}
            <g className="m-bar">
              <rect x="10" y="36" width="52" height="4" fill="var(--dim)" />
              <rect x="6" y="29" width="6" height="18" fill="var(--mut)" />
              <rect x="60" y="29" width="6" height="18" fill="var(--mut)" />
            </g>
            {/* effort sweat */}
            <rect className="m-sweat" x="16" y="18" width="3" height="3" fill="var(--mut)" />
            <rect className="m-sweat s2" x="54" y="15" width="3" height="3" fill="var(--mut)" />
          </g>
        </svg>
      </span>
    </button>
  );
}
