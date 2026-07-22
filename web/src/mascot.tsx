/* CoachMascot — Rep, a chunky little strongman who sometimes hops up onto the
   chat bar to keep the coach thread company. Tap him and he busts out a mini
   workout — the move, rep count and tempo are re-rolled every time, so no two
   sets look quite the same — then he flexes and drops a one-liner.

   Purely cosmetic: CSS keyframes in styles.css (".mascot" block) drive all the
   motion; this component only decides when he shows up and what plays next.
   localStorage 'forge-mascot' = 'always' | 'never' overrides the dice. */
import { useCallback, useEffect, useRef, useState } from 'react';

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
    if (pref === 'never') return;
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
  }, [armLeave]);

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

  if (phase === 'hidden') return null;
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
        <svg viewBox="0 0 72 72" aria-hidden="true">
          <ellipse className="m-shadow" cx="36" cy="66.5" rx="15" ry="2.4" fill="var(--hair)" />
          <g className="m-all" onAnimationEnd={onSetDone}>
            {/* stubby legs */}
            <rect className="m-leg m-legL" x="25" y="49" width="9" height="16" rx="4.4"
              fill="var(--volt)" stroke="var(--bg)" strokeWidth="1.4" />
            <rect className="m-leg m-legR" x="38" y="49" width="9" height="16" rx="4.4"
              fill="var(--volt)" stroke="var(--bg)" strokeWidth="1.4" />
            {/* stubby arms (dumbbells ride inside so curls carry them) */}
            <g className="m-arm m-armL">
              <rect x="12.5" y="28" width="8" height="14.5" rx="4" fill="var(--volt)"
                stroke="var(--bg)" strokeWidth="1.4" />
              <g className="m-db">
                <rect x="10" y="40.4" width="13" height="3" rx="1.4" fill="var(--mut)" />
                <rect x="9" y="38.8" width="3.4" height="6.2" rx="1.4" fill="var(--raised)"
                  stroke="var(--mut)" strokeWidth="0.8" />
                <rect x="20.6" y="38.8" width="3.4" height="6.2" rx="1.4" fill="var(--raised)"
                  stroke="var(--mut)" strokeWidth="0.8" />
              </g>
            </g>
            <g className="m-arm m-armR">
              <rect x="51.5" y="28" width="8" height="14.5" rx="4" fill="var(--volt)"
                stroke="var(--bg)" strokeWidth="1.4" />
              <g className="m-db">
                <rect x="49" y="40.4" width="13" height="3" rx="1.4" fill="var(--mut)" />
                <rect x="48" y="38.8" width="3.4" height="6.2" rx="1.4" fill="var(--raised)"
                  stroke="var(--mut)" strokeWidth="0.8" />
                <rect x="59.6" y="38.8" width="3.4" height="6.2" rx="1.4" fill="var(--raised)"
                  stroke="var(--mut)" strokeWidth="0.8" />
              </g>
            </g>
            {/* one chunky meat-boy body: head and torso are the same blob */}
            <rect x="20" y="16" width="32" height="38" rx="12" fill="var(--volt)" />
            <rect x="22.5" y="23" width="27" height="4.6" rx="2.3" fill="var(--on-volt)" opacity="0.9" />
            <circle className="m-eye" cx="29.5" cy="34" r="2.7" fill="var(--on-volt)" />
            <circle className="m-eye" cx="42.5" cy="34" r="2.7" fill="var(--on-volt)" />
            <path className="m-smile" d="M31 41.5 q5 4.4 10 0" fill="none"
              stroke="var(--on-volt)" strokeWidth="2.2" strokeLinecap="round" />
            <circle className="m-grit" cx="36" cy="43" r="2.5" fill="var(--on-volt)" />
            {/* barbell (front rack for squats, chest→overhead for presses) */}
            <g className="m-bar">
              <line x1="12" y1="38" x2="60" y2="38" stroke="var(--mut)" strokeWidth="2.6"
                strokeLinecap="round" />
              <rect x="11" y="32.5" width="4.4" height="11" rx="2" fill="var(--raised)"
                stroke="var(--mut)" strokeWidth="0.9" />
              <rect x="56.6" y="32.5" width="4.4" height="11" rx="2" fill="var(--raised)"
                stroke="var(--mut)" strokeWidth="0.9" />
            </g>
            {/* effort sweat */}
            <circle className="m-sweat" cx="18" cy="20" r="1.5" fill="var(--mut)" />
            <circle className="m-sweat s2" cx="55" cy="17" r="1.2" fill="var(--mut)" />
          </g>
        </svg>
      </span>
    </button>
  );
}
