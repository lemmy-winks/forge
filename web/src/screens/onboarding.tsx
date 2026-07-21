import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  api, type ChatMsg, type ChatResp, type Connections, type EquipmentData, type Me, type ProposalResp,
} from '../api';
import { ChatBubble, toast } from '../ui';

const STEPS = ['Welcome', 'Health data', 'Your gym', 'Your coach', 'Ready'];

export function OnboardingFlow({ me, onDone }: { me: Me; onDone: () => void }) {
  const [step, setStep] = useState<number>(() => {
    const s = Number((me.prefs as any)?.onboarding_step);
    return Number.isFinite(s) && s > 0 && s < STEPS.length ? s : 0;
  });
  const advance = (n: number) => {
    setStep(n);
    api('/api/prefs', { method: 'PATCH', body: { prefs: { onboarding_step: n } } }).catch(() => {});
  };
  const finish = async () => {
    try {
      await api('/api/prefs', { method: 'PATCH', body: { prefs: { onboarded: true } } });
      onDone();
    } catch { toast('No connection — try again in a moment'); }
  };

  return (
    <>
      <div className="hdr">
        <span className="wm">FORGE<i>.</i></span><span className="betatag">BETA</span><span className="sp" />
        <span className="kick" style={{ fontSize: 10.5 }}>Step {step + 1} of {STEPS.length}</span>
      </div>
      <div style={{ display: 'flex', gap: 5, padding: '0 18px 8px' }}>
        {STEPS.map((_, i) => (
          <span key={i} style={{ flex: 1, height: 3, borderRadius: 2,
            background: i <= step ? 'var(--volt)' : 'var(--hair)' }} />
        ))}
      </div>
      {step === 0 && <BasicsStep me={me} onNext={() => advance(1)} />}
      {step === 1 && <DataStep onNext={() => advance(2)} />}
      {step === 2 && <EquipStep onNext={() => advance(3)} />}
      {step === 3 && <IntakeStep name={me.name} onNext={() => advance(4)} />}
      {step === 4 && <DoneStep name={me.name} onFinish={finish} />}
    </>
  );
}

/* ---------------- skip confirmation sheet ----------------
   Every skippable step explains, before skipping, exactly what will and won't
   work — and where the step lives later. The safe choice is always primary. */
function SkipSheet({ title, consequences, later, onStay, onSkip }: {
  title: string; consequences: string[]; later: string;
  onStay: () => void; onSkip: () => void;
}) {
  return (
    <div className="overlay" onClick={onStay}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <div className="sub" style={{ fontSize: 14, lineHeight: 1.55 }}>
          Nothing breaks — the app fully works. But until you come back to this:
        </div>
        {consequences.map((c) => (
          <div key={c} className="obstep"><span className="n" style={{
            background: 'var(--warn-dim, rgba(232,163,96,.2))', color: 'var(--warn)' }}>·</span>
            <span className="t">{c}</span></div>
        ))}
        <div className="banner" style={{ fontSize: 13.5 }}>You can do this any time later — {later}</div>
        <button className="cta press" onClick={onStay}>Stay and finish this step</button>
        <button className="ghost press" onClick={onSkip}>Skip for now</button>
      </div>
    </div>
  );
}

/* ---------------- step 1: welcome + units ---------------- */
function BasicsStep({ me, onNext }: { me: Me; onNext: () => void }) {
  const [units, setUnits] = useState(me.units || 'kg');
  const next = () => {
    api('/api/prefs', { method: 'PATCH', body: { units } }).catch(() => {});
    onNext();
  };
  return (
    <div className="scroll">
      <h2 className="title">Welcome, {me.name} 👋</h2>
      <p className="sub" style={{ fontSize: 14.5, lineHeight: 1.6 }}>
        Forge plans your training week, you log what actually happens, and your coach
        adjusts the plan every Sunday. A few quick questions and you're in — nothing here
        is permanent, everything can be changed later in Settings.
      </p>
      <div className="card">
        <div className="kick" style={{ fontSize: 11, marginBottom: 8 }}>One question: how do you talk about your body weight?</div>
        <div className="seg">
          <button className={units === 'kg' ? 'sel' : ''} onClick={() => setUnits('kg')}>in kilograms</button>
          <button className={units === 'lb' ? 'sel' : ''} onClick={() => setUnits('lb')}>in pounds</button>
        </div>
        <div className="sub" style={{ marginTop: 10 }}>
          Your weight will show as <b style={{ color: 'var(--ink)' }}>
          {units === 'kg' ? 'e.g. 82.1 kg' : 'e.g. 181 lb'}</b>. (Barbell weights are a separate
          setting — the gym's plates don't care how you weigh yourself.)
        </div>
      </div>
      <div style={{ marginTop: 'auto' }}>
        <button className="cta press" onClick={next}>Looks right — continue</button>
      </div>
    </div>
  );
}

/* ---------------- step 2: health data ---------------- */
function FlowArt() {
  // Watch + scale → iPhone Health → Forge, in theme colors
  return (
    <svg viewBox="0 0 300 84" style={{ width: '100%', maxWidth: 330, display: 'block', margin: '2px auto' }}>
      <g fontFamily="inherit">
        <rect x="4" y="6" width="72" height="30" rx="9" fill="var(--raised)" stroke="var(--hair)" />
        <text x="40" y="25" textAnchor="middle" fontSize="12">⌚ Watch</text>
        <rect x="4" y="46" width="72" height="30" rx="9" fill="var(--raised)" stroke="var(--hair)" />
        <text x="40" y="65" textAnchor="middle" fontSize="12">⚖️ Scale</text>
        <path d="M80 21 h20 q8 0 8 8 v3" fill="none" stroke="var(--volt)" strokeWidth="1.8" />
        <path d="M80 61 h20 q8 0 8 -8 v-3" fill="none" stroke="var(--volt)" strokeWidth="1.8" />
        <rect x="112" y="26" width="82" height="30" rx="9" fill="var(--raised)" stroke="var(--hair)" />
        <text x="153" y="45" textAnchor="middle" fontSize="12">📱 Health app</text>
        <path d="M198 41 h34" fill="none" stroke="var(--volt)" strokeWidth="1.8" markerEnd="url(#obarrow)" />
        <defs><marker id="obarrow" markerWidth="7" markerHeight="7" refX="5" refY="3.5" orient="auto">
          <path d="M0 0 L6 3.5 L0 7 z" fill="var(--volt)" /></marker></defs>
        <rect x="238" y="26" width="58" height="30" rx="9" fill="var(--volt)" />
        <text x="267" y="45" textAnchor="middle" fontSize="12" fontWeight="800"
          fill="var(--on-volt)">FORGE</text>
      </g>
    </svg>
  );
}

function DataStep({ onNext }: { onNext: () => void }) {
  const qc = useQueryClient();
  const [revealed, setRevealed] = useState<string | null>(null);
  const [confirmSkip, setConfirmSkip] = useState(false);
  const q = useQuery<Connections>({
    queryKey: ['connections'], queryFn: () => api('/api/connections'),
    refetchInterval: 5000,
  });
  const ah = q.data?.apple_health;
  const live = !!ah?.last_push;
  const rotate = useMutation({
    mutationFn: () => api<{ token: string }>('/api/connections/rotate-token', { method: 'POST' }),
    onSuccess: (r) => { setRevealed(r.token); qc.invalidateQueries({ queryKey: ['connections'] }); },
  });
  const copyKey = async () => {
    if (!revealed) { rotate.mutate(); return; }
    try { await navigator.clipboard.writeText(revealed); toast('Copied ✓', true); }
    catch { toast('Copy failed — long-press the key to select it'); }
  };
  return (
    <div className="scroll">
      <h2 className="title">Let your watch do the typing</h2>
      <p className="sub" style={{ fontSize: 14.5, lineHeight: 1.6 }}>
        Forge can read your workouts, sleep and weight automatically, so your coach sees
        how you're really doing. It flows like this:
      </p>
      <FlowArt />
      {live ? (
        <div className="banner">✓ It's working — {ah!.samples} readings have arrived</div>
      ) : (
        <>
          <p className="sub" style={{ fontSize: 14, lineHeight: 1.6 }}>
            The bridge is an iPhone app called <b style={{ color: 'var(--ink)' }}>Health Auto
            Export</b> (App Store — its auto-send feature is a small one-off purchase).
            Five minutes, once, on the phone that has your health data:
          </p>
          <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
            <div className="obstep"><span className="n">1</span><span className="t">
              Install <b>Health Auto Export</b> from the App Store and open it</span></div>
            <div className="obstep"><span className="n">2</span><span className="t">
              Tap <b>Automations → + → REST API</b></span></div>
            <div className="obstep"><span className="n">3</span><span className="t">
              Where it asks for a URL, type exactly:<br />
              <b style={{ fontFamily: 'ui-monospace,Menlo,monospace', fontSize: 13, wordBreak: 'break-all' }}>
                {location.origin}/ingest?token={revealed || 'YOUR-KEY'}</b></span></div>
            <div className="obstep"><span className="n">4</span><span className="t">
              Your personal key — like a password, just for this{revealed ? '' : ' (tap the button to create it)'}:</span></div>
            <div className="num" style={{ fontFamily: 'ui-monospace,Menlo,monospace', fontSize: 13,
              background: 'var(--sunken)', borderRadius: 10, padding: '9px 11px',
              display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ flex: 1, wordBreak: 'break-all' }}>{revealed || ah?.token_masked || '· · · · · ·'}</span>
              <button className="press" style={{ color: 'var(--volt)', fontWeight: 800, flex: 'none' }}
                onClick={copyKey}>{revealed ? 'COPY' : 'CREATE KEY'}</button>
            </div>
            <div className="obstep"><span className="n">5</span><span className="t">
              Pick what to send — <b>weight, sleep, heart rate, workouts</b> — then run it once
              with <b>Update</b></span></div>
          </div>
          <div className="chip"><span className="dot" />
            This screen turns green by itself when the first data arrives — no need to tell it anything.
          </div>
        </>
      )}
      <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {live
          ? <button className="cta press" onClick={onNext}>Continue</button>
          : <>
              <button className="cta" disabled>Waiting for your first data…</button>
              <button className="ghost press" onClick={() => setConfirmSkip(true)}>Skip this step</button>
            </>}
      </div>
      {confirmSkip && (
        <SkipSheet
          title="Skip health data for now?"
          consequences={[
            'Workouts from your Watch won\'t appear by themselves — you\'d log cardio by hand',
            'Your coach plans without seeing your sleep, weight or recovery',
          ]}
          later="it's in Settings → Connections, with these same instructions."
          onStay={() => setConfirmSkip(false)}
          onSkip={onNext}
        />
      )}
    </div>
  );
}

/* ---------------- step 3: equipment ---------------- */
function EquipStep({ onNext }: { onNext: () => void }) {
  const qc = useQueryClient();
  const [idx, setIdx] = useState(0);
  const q = useQuery<EquipmentData>({ queryKey: ['equipment'], queryFn: () => api('/api/equipment') });
  const eq = q.data;
  const prof = eq?.profiles[Math.min(idx, (eq?.profiles.length || 1) - 1)];
  const toggle = async (i: number) => {
    if (!prof) return;
    const items = prof.items.map((it, j) => (j === i ? { ...it, available: !it.available } : it));
    qc.setQueryData<EquipmentData>(['equipment'], (old) => old && {
      ...old, profiles: old.profiles.map((p) => (p.id === prof.id ? { ...p, items } : p)),
    });
    api('/api/equipment/' + prof.id, { method: 'PATCH', body: { items } }).catch(() => {});
  };
  const activate = (id: string) =>
    api('/api/equipment/active', { method: 'POST', body: { profile_id: id } })
      .then(() => qc.invalidateQueries({ queryKey: ['equipment'] })).catch(() => {});
  return (
    <div className="scroll">
      <h2 className="title">What's in your gym?</h2>
      <p className="sub" style={{ fontSize: 14.5, lineHeight: 1.6 }}>
        Tap anything that's wrong — green means you have it, grey means you don't. Your
        coach will only ever plan exercises you can actually do. Guessing is fine;
        change it any time in Settings → Equipment.
      </p>
      {!eq || !prof ? <div className="chip">Loading…</div> : (
        <>
          <div className="seg">
            {eq.profiles.map((p, i) => (
              <button key={p.id} className={i === idx ? 'sel' : ''} onClick={() => setIdx(i)}>
                {p.name}{p.shared ? ' ⌂' : ''}</button>
            ))}
          </div>
          {prof.id !== eq.active_id && (
            <button className="ghost press" onClick={() => activate(prof.id)}>
              Train here mostly? Make it your default</button>
          )}
          {prof.items.map((it, i) => (
            <button key={it.name} className={'lrow press' + (it.available ? '' : ' dimrow')}
              onClick={() => toggle(i)}>
              <b>{it.name}</b>
              <span className="rsub" style={it.available ? { color: 'var(--volt)' } : {}}>
                {it.available ? '✓ have it' : '✕ don\'t have it'}</span>
            </button>
          ))}
        </>
      )}
      <div style={{ marginTop: 'auto' }}>
        <button className="cta press" onClick={onNext}>That's my gym — continue</button>
      </div>
    </div>
  );
}

/* ---------------- step 4: intake interview ---------------- */
const OPENERS = [
  'I want to get stronger',
  'Help me lose some weight',
  'I\'m completely new to lifting',
  'I run — help me balance both',
];

function IntakeStep({ name, onNext }: { name: string; onNext: () => void }) {
  const qc = useQueryClient();
  const [confirmSkip, setConfirmSkip] = useState(false);
  const chatQ = useQuery<ChatResp>({
    queryKey: ['chat'], queryFn: () => api('/api/chat'),
    refetchInterval: (q) => (q.state.data?.pending ? 1000 : false),
  });
  const propQ = useQuery<ProposalResp>({
    queryKey: ['proposal'], queryFn: () => api('/api/proposal'), refetchInterval: 6000,
  });
  const [pending, setPending] = useState<ChatMsg[]>([]);
  const [typing, setTyping] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const hasProposal = !!propQ.data?.proposal;
  const serverPending = chatQ.data?.pending ?? false;
  const msgs = [...(chatQ.data?.messages || []), ...pending];

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs.length, typing]);

  const send = async (preset?: string) => {
    const el = inputRef.current;
    const text = preset ?? el?.value.trim();
    if (!text || typing || serverPending) return;
    if (el && !preset) el.value = '';
    setPending((p) => [...p, { who: 'me', text }]);
    setTyping(true);
    try {
      await api('/api/chat', { method: 'POST', body: { text } });
      await qc.invalidateQueries({ queryKey: ['chat'] });
      setPending([]);
    } catch { toast('No connection — message not sent'); setPending((p) => p.slice(0, -1)); }
    setTyping(false);
  };

  // reply lands via polling — refresh the proposal card when the coach finishes
  useEffect(() => {
    if (!serverPending) qc.invalidateQueries({ queryKey: ['proposal'] });
  }, [serverPending, qc]);

  return (
    <>
      <div className="scroll" ref={scrollRef} style={{ paddingBottom: 8 }}>
        <h2 className="title">Say hi to your coach</h2>
        <p className="sub" style={{ fontSize: 14, lineHeight: 1.55 }}>
          This is a real conversation — plain words, no fitness-speak needed. Tell it what
          you want and it builds your first week around you.
        </p>
        {msgs.length === 0 && (
          <>
            <div className="bub">Hi {name} — I'm your coach. What are you hoping to get out of
              training? Tap one below or just type.</div>
            <div className="sugg">
              {OPENERS.map((o) => (
                <button key={o} className="press" onClick={() => send(o)}>{o}</button>
              ))}
            </div>
          </>
        )}
        {msgs.map((m, i) => <ChatBubble key={i} who={m.who} text={m.text} />)}
        {(typing || serverPending) && <div className="bub">thinking…</div>}
        {hasProposal && (
          <div className="banner">✓ Your first week is ready — you'll see it on the Today screen</div>
        )}
      </div>
      <div className="chatin">
        <input ref={inputRef} placeholder="Type here — plain words are perfect" autoComplete="off"
          onKeyDown={(e) => { if (e.key === 'Enter') send(); }} />
        <button className="press" onClick={() => send()}>Send</button>
      </div>
      <div style={{ padding: '8px 16px calc(12px + env(safe-area-inset-bottom))', display: 'flex',
        flexDirection: 'column', gap: 8 }}>
        {hasProposal
          ? <button className="cta press" onClick={onNext}>Continue</button>
          : <button className="ghost press" onClick={() => setConfirmSkip(true)}>Skip the chat</button>}
      </div>
      {confirmSkip && (
        <SkipSheet
          title="Skip meeting your coach?"
          consequences={[
            'You\'ll start on a sensible ready-made week instead of one built around your goals',
            'The coach won\'t know about injuries, your schedule, or what you enjoy',
          ]}
          later="the coach lives on the Coach tab — say hi whenever, and it will build your real plan."
          onStay={() => setConfirmSkip(false)}
          onSkip={onNext}
        />
      )}
    </>
  );
}

/* ---------------- step 5: done ---------------- */
function LoopArt() {
  // the weekly rhythm: plan → train & log → Sunday review → back around
  const box = (x: number, label: string, sub: string): ReactNode => (
    <g>
      <rect x={x} y="16" width="88" height="40" rx="10" fill="var(--raised)" stroke="var(--hair)" />
      <text x={x + 44} y="33" textAnchor="middle" fontSize="11.5" fontWeight="650" fill="var(--ink)">{label}</text>
      <text x={x + 44} y="47" textAnchor="middle" fontSize="9.5" fill="var(--mut)">{sub}</text>
    </g>
  );
  return (
    <svg viewBox="0 0 316 92" style={{ width: '100%', maxWidth: 340, display: 'block', margin: '4px auto' }}>
      <defs><marker id="lparrow" markerWidth="7" markerHeight="7" refX="5" refY="3.5" orient="auto">
        <path d="M0 0 L6 3.5 L0 7 z" fill="var(--volt)" /></marker></defs>
      {box(6, '📋 Your week', 'on Today')}
      {box(114, '🏋️ Train & log', 'tap by tap')}
      {box(222, '🧠 Sunday', 'coach reviews')}
      <path d="M96 36 h14" fill="none" stroke="var(--volt)" strokeWidth="1.8" markerEnd="url(#lparrow)" />
      <path d="M204 36 h14" fill="none" stroke="var(--volt)" strokeWidth="1.8" markerEnd="url(#lparrow)" />
      <path d="M266 58 v10 q0 8 -8 8 H58 q-8 0 -8 -8 v-6" fill="none" stroke="var(--volt)"
        strokeWidth="1.8" markerEnd="url(#lparrow)" strokeDasharray="3 4" />
      <text x="158" y="86" textAnchor="middle" fontSize="9.5" fill="var(--mut)">…a fresh week appears for you to approve</text>
    </svg>
  );
}

function DoneStep({ name, onFinish }: { name: string; onFinish: () => void }) {
  return (
    <div className="scroll">
      <h2 className="title">You're set, {name} 🎉</h2>
      <p className="sub" style={{ fontSize: 14.5, lineHeight: 1.6 }}>
        Here's the whole rhythm — this is all there is to it:
      </p>
      <LoopArt />
      <div className="card"><div className="sub" style={{ marginTop: 0, fontSize: 13.5, lineHeight: 1.6 }}>
        <b style={{ color: 'var(--ink)' }}>Honesty beats perfection.</b> Skip a day, cut a session
        short, swap an exercise — all fine, just log it. The coach plans around real life,
        not the plan you wish you'd done.
      </div></div>
      <div className="card"><div className="sub" style={{ marginTop: 0, fontSize: 13.5, lineHeight: 1.6 }}>
        <b style={{ color: 'var(--ink)' }}>One boundary:</b> the coach talks about your training
        and trends, but never gives medical advice — anything clinical gets a
        "talk to your GP", nothing more.
      </div></div>
      <div style={{ marginTop: 'auto' }}>
        <button className="cta press" onClick={onFinish}>Show me my week</button>
      </div>
    </div>
  );
}
