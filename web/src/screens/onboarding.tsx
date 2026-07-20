import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import {
  api, type ChatMsg, type ChatResp, type Connections, type EquipmentData, type Me, type ProposalResp,
} from '../api';
import { ChatBubble, toast } from '../ui';

const STEPS = ['Basics', 'Your data', 'Equipment', 'Meet your coach', 'Done'];

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
    } catch { toast('Offline — try again in a moment'); }
  };

  return (
    <>
      <div className="hdr">
        <span className="wm">FORGE<i>.</i></span><span className="sp" />
        <span className="kick" style={{ fontSize: 9.5 }}>{step + 1} / {STEPS.length} · {STEPS[step]}</span>
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

/* ---------------- step 1: basics ---------------- */
function BasicsStep({ me, onNext }: { me: Me; onNext: () => void }) {
  const [units, setUnits] = useState(me.units || 'kg');
  const next = () => {
    api('/api/prefs', { method: 'PATCH', body: { units } }).catch(() => {});
    onNext();
  };
  return (
    <div className="scroll">
      <h2 className="title">Welcome, {me.name}</h2>
      <p className="sub" style={{ fontSize: 13, lineHeight: 1.55 }}>
        Forge is your training log with a coach attached: it plans your week, you log what
        actually happens, and the coach adjusts every Sunday. Two quick things, then you'll
        meet it.
      </p>
      <div className="card">
        <div className="kick" style={{ fontSize: 10, marginBottom: 6 }}>Bodyweight display</div>
        <div className="seg">
          {(['kg', 'lb'] as const).map((u) => (
            <button key={u} className={units === u ? 'sel' : ''} onClick={() => setUnits(u)}>{u}</button>
          ))}
        </div>
        <div className="sub">Lifting loads have their own unit (default lb) — change it any time in
          Settings → Units, per exercise too. This sets how your
          bodyweight reads.</div>
      </div>
      <div style={{ marginTop: 'auto' }}>
        <button className="cta press" onClick={next}>Continue</button>
      </div>
    </div>
  );
}

/* ---------------- step 2: data ---------------- */
function DataStep({ onNext }: { onNext: () => void }) {
  const qc = useQueryClient();
  const [revealed, setRevealed] = useState<string | null>(null);
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
  return (
    <div className="scroll">
      <h2 className="title">Wire up your data</h2>
      <p className="sub" style={{ fontSize: 13, lineHeight: 1.55 }}>
        Your Apple Watch and scale feed the coach through the <b style={{ color: 'var(--ink)' }}>Health
        Auto Export</b> app (App Store, small one-off purchase for its REST automation). Totally
        skippable now — the app works without it, the coach just flies without recovery data.
      </p>
      {live ? (
        <div className="banner">✓ Data is flowing — {ah!.samples} samples received</div>
      ) : (
        <div className="card">
          <div className="kick" style={{ fontSize: 10, marginBottom: 6 }}>Setup</div>
          <div className="sub">1 · Install "Health Auto Export" and unlock automations</div>
          <div className="sub">2 · Automations → REST API → URL:
            <b style={{ color: 'var(--ink)' }}> {location.origin}/ingest</b></div>
          <div className="sub">3 · Add header <b style={{ color: 'var(--ink)' }}>Authorization: Bearer
            &lt;your token&gt;</b> — or append ?token=&lt;token&gt; to the URL</div>
          <div className="sub">4 · Select weight, sleep, resting HR, VO₂max, workouts · run once</div>
          <div className="sub num" style={{ fontFamily: 'ui-monospace,Menlo,monospace',
            background: 'var(--sunken)', borderRadius: 8, padding: '6px 9px', marginTop: 8 }}>
            {revealed || ah?.token_masked || '—'}
            <button className="press" style={{ color: 'var(--volt)', fontWeight: 700, float: 'right' }}
              onClick={async () => {
                if (revealed) {
                  try { await navigator.clipboard.writeText(revealed); toast('Copied'); }
                  catch { toast('Copy failed — long-press to select'); }
                } else rotate.mutate();
              }}>{revealed ? 'COPY' : 'GET TOKEN'}</button>
          </div>
          <div className="sub" style={{ color: 'var(--dim)' }}>This card turns green by itself when
            the first push lands.</div>
        </div>
      )}
      <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <button className="cta press" onClick={onNext}>{live ? 'Continue' : 'Continue anyway'}</button>
        {!live && <button className="ghost press" onClick={onNext}>I'll set this up later</button>}
      </div>
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
      <h2 className="title">What have you got?</h2>
      <p className="sub" style={{ fontSize: 13, lineHeight: 1.55 }}>
        The coach only prescribes what's actually available — tick your gym honestly and your
        first plan will be loadable to the plate.
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
            <button className="ghost press" onClick={() => activate(prof.id)}>Make this my active profile</button>
          )}
          {prof.items.map((it, i) => (
            <button key={it.name} className={'lrow press' + (it.available ? '' : ' dimrow')}
              onClick={() => toggle(i)}>
              <b>{it.name}</b><span className="rsub">{it.available ? '✓ available' : '✕ not here'}</span>
            </button>
          ))}
        </>
      )}
      <div style={{ marginTop: 'auto' }}>
        <button className="cta press" onClick={onNext}>Continue</button>
      </div>
    </div>
  );
}

/* ---------------- step 4: intake interview ---------------- */
function IntakeStep({ name, onNext }: { name: string; onNext: () => void }) {
  const qc = useQueryClient();
  const chatQ = useQuery<ChatResp>({
    queryKey: ['chat'], queryFn: () => api('/api/chat'),
    refetchInterval: (q) => (q.state.data?.pending ? 2000 : false),
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

  const send = async () => {
    const el = inputRef.current;
    const text = el?.value.trim();
    if (!el || !text || typing || serverPending) return;
    el.value = '';
    setPending((p) => [...p, { who: 'me', text }]);
    setTyping(true);
    try {
      await api('/api/chat', { method: 'POST', body: { text } });
      await qc.invalidateQueries({ queryKey: ['chat'] });
      setPending([]);
    } catch { toast('Offline — message not sent'); setPending((p) => p.slice(0, -1)); }
    setTyping(false);
  };

  // reply lands via polling — refresh the proposal card when the coach finishes
  useEffect(() => {
    if (!serverPending) qc.invalidateQueries({ queryKey: ['proposal'] });
  }, [serverPending, qc]);

  return (
    <>
      <div className="scroll" ref={scrollRef} style={{ paddingBottom: 8 }}>
        <h2 className="title">Meet your coach</h2>
        {msgs.length === 0 && (
          <div className="bub">Hi {name} — I'm your coach. Tell me what you're training for and
            we'll build your first week together. Say hello to get going.</div>
        )}
        {msgs.map((m, i) => <ChatBubble key={i} who={m.who} text={m.text} />)}
        {(typing || serverPending) && <div className="bub">thinking…</div>}
        {hasProposal && (
          <div className="banner">✓ Your first week is ready — it's waiting on the Today screen</div>
        )}
      </div>
      <div className="chatin">
        <input ref={inputRef} placeholder="Message your coach…" autoComplete="off"
          onKeyDown={(e) => { if (e.key === 'Enter') send(); }} />
        <button className="press" onClick={send}>Send</button>
      </div>
      <div style={{ padding: '8px 16px calc(12px + env(safe-area-inset-bottom))', display: 'flex',
        flexDirection: 'column', gap: 8 }}>
        {hasProposal
          ? <button className="cta press" onClick={onNext}>Continue</button>
          : <button className="ghost press" onClick={onNext}>Skip the interview for now</button>}
      </div>
    </>
  );
}

/* ---------------- step 5: done ---------------- */
function DoneStep({ name, onFinish }: { name: string; onFinish: () => void }) {
  return (
    <div className="scroll">
      <h2 className="title">You're set, {name}</h2>
      <div className="card"><div className="sub" style={{ marginTop: 0, fontSize: 12.5, lineHeight: 1.6 }}>
        <b style={{ color: 'var(--ink)' }}>The deal:</b> your plan lives on Today — approve it if
        the coach proposed one. Log sessions honestly, skip what you must; the coach sees
        everything either way and reviews your week every Sunday evening. Niggles, equipment,
        and data connections all live in Settings whenever life changes.
      </div></div>
      <div className="card"><div className="sub" style={{ marginTop: 0, fontSize: 12.5, lineHeight: 1.6 }}>
        <b style={{ color: 'var(--ink)' }}>One boundary:</b> the coach reads your health data and
        will talk about trends, but it never gives medical advice — lab results and anything
        clinical get a "talk to your GP" and nothing more.
      </div></div>
      <div style={{ marginTop: 'auto' }}>
        <button className="cta press" onClick={onFinish}>Go to Today</button>
      </div>
    </div>
  );
}
