import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api, type ChatMsg, type ChatResp, type ProposalResp } from '../api';
import { ChatBubble, Header, Tabs, Title, toast, useApp } from '../ui';

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function ProposalCard({ onChanges }: { onChanges: () => void }) {
  const qc = useQueryClient();
  const q = useQuery<ProposalResp>({ queryKey: ['proposal'], queryFn: () => api('/api/proposal') });
  const p = q.data?.proposal;
  const decide = useMutation({
    mutationFn: (arg: { id: string; verb: 'approve' | 'reject' }) =>
      api(`/api/proposal/${arg.id}/${arg.verb}`, { method: 'POST' }),
    onSuccess: (_d, arg) => {
      toast(arg.verb === 'approve' ? 'Week approved — live now' : 'Proposal dismissed', arg.verb === 'approve');
      qc.invalidateQueries({ queryKey: ['proposal'] });
      qc.invalidateQueries({ queryKey: ['today'] });
      qc.invalidateQueries({ queryKey: ['week'] });
    },
  });
  if (!p) return null;
  const days = Object.entries(p.content.days || {}).sort(([a], [b]) => +a - +b);
  const changes = p.content.changes || [];
  const proposedOn = new Date(p.created_at);
  const signColor = (s: string) => s === '+' ? 'var(--volt)' : s === '-' ? 'var(--warn)' : 'var(--mut)';

  const dayLine = (day: (typeof days)[number][1]): string => {
    if (day.why) return day.why;
    return day.kind === 'cardio'
      ? `${day.cardio?.minutes ?? '?'} min · HR ${day.cardio?.hr_low ?? '?'}–${day.cardio?.hr_high ?? '?'}`
      : `${(day.exercises || []).length} lifts`;
  };

  return (
    <div className="card">
      <div className="kick" style={{ fontSize: 11 }}>
        Proposed {proposedOn.toLocaleDateString(undefined, { weekday: 'short' })} {proposedOn.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}
        {' · '}plan revision #{p.num} · awaiting your OK
      </div>
      <p style={{ fontSize: 14.5, lineHeight: 1.5, margin: '6px 0 8px' }}>{p.rationale}</p>
      {changes.map((c, i) => (
        <div key={i} style={{ display: 'flex', gap: 9, padding: '4px 0', fontSize: 14 }} className="num">
          <b style={{ color: signColor(c.sign), width: 12, flex: 'none', textAlign: 'center' }}>{c.sign}</b>
          <span>
            <b>{c.what}</b>
            {c.why && <span style={{ display: 'block', fontSize: 12.5, color: 'var(--mut)' }}>{c.why}</span>}
          </span>
        </div>
      ))}
      <div style={{ marginTop: changes.length ? 8 : 0 }}>
        {days.map(([k, day]) => (
          <div key={k} style={{ borderTop: '1px solid var(--hair)', padding: '6px 0' }}>
            <div className="row">
              <span style={{ fontSize: 14.5, fontWeight: 600 }}>{DAY_NAMES[+k]} · {day.name}</span>
              <span className="fchips">{(day.focus || []).map((f) => <span key={f} className="fchip">{f}</span>)}</span>
            </div>
            <div className="sub num" style={{ margin: 0 }}>{dayLine(day)}</div>
          </div>
        ))}
      </div>
      <div className="btnrow" style={{ marginTop: 10 }}>
        <button className="cta press" style={{ padding: 11 }} disabled={decide.isPending}
          onClick={() => decide.mutate({ id: p.id, verb: 'approve' })}>Approve week</button>
        <button className="ghost press" style={{ flex: '0 0 auto', width: 'auto', padding: '11px 14px' }}
          onClick={onChanges}>Changes…</button>
      </div>
    </div>
  );
}

/** Contextual one-tap prompts: the fastest way to start the useful conversations. */
function suggestionsFor(hasProposal: boolean, msgCount: number): string[] {
  if (hasProposal) {
    return ['Walk me through the changes', 'Make next week a bit easier',
            'I can only train 3 days next week'];
  }
  if (msgCount < 3) {
    return ["How's my week looking?", 'Why this weight on my main lift?',
            'My knee grumbled today'];
  }
  return ['How am I progressing?', "I've only got 30 minutes today",
          'Plan feels heavy this week', 'I missed yesterday — what now?'];
}

export function CoachScreen() {
  const qc = useQueryClient();
  const { chatContext, setChatContext } = useApp();
  const q = useQuery<ChatResp>({
    queryKey: ['chat'], queryFn: () => api('/api/chat'),
    // while the coach is thinking, poll — the reply lands in history even if
    // the phone locks or the user wanders off mid-thought
    refetchInterval: (query) => (query.state.data?.pending ? 2000 : false),
  });
  const propQ = useQuery<ProposalResp>({ queryKey: ['proposal'], queryFn: () => api('/api/proposal') });
  const [pending, setPending] = useState<ChatMsg[]>([]);
  const [reviewing, setReviewing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const thinking = q.data?.pending ?? false;
  const msgs = [...(q.data?.messages || []), ...pending];

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs.length, thinking]);

  // mark read + clear optimistic copies once the server echoes them
  useEffect(() => {
    const last = msgs[msgs.length - 1];
    if (last?.at) localStorage.setItem('forge-chat-seen', last.at);
    if (pending.length && (q.data?.messages || []).some((m) => m.text.startsWith(pending[0].text))) {
      setPending([]);
    }
  }, [q.data, msgs, pending]);

  // a finished reply can carry writes (proposal, niggle, plan) — refresh the world
  const wasThinking = useRef(false);
  useEffect(() => {
    if (wasThinking.current && !thinking) {
      qc.invalidateQueries({ queryKey: ['proposal'] });
      qc.invalidateQueries({ queryKey: ['today'] });
      qc.invalidateQueries({ queryKey: ['week'] });
      qc.invalidateQueries({ queryKey: ['niggles'] });
    }
    wasThinking.current = thinking;
  }, [thinking, qc]);

  const send = async (raw?: string) => {
    const el = inputRef.current;
    const text = (raw ?? el?.value ?? '').trim();
    if (!text || thinking) return;
    if (el && raw === undefined) el.value = '';
    const ctx = chatContext;
    setChatContext(null);
    setPending((p) => [...p, { who: 'me', text }]);
    try {
      await api('/api/chat', { method: 'POST',
        body: { text, context: ctx ? { kind: ctx.kind, id: ctx.id } : null } });
      qc.invalidateQueries({ queryKey: ['chat'] });
    } catch (e) {
      toast((e as Error).message === 'network' ? 'Offline — message not sent' : String((e as Error).message));
      setPending((p) => p.slice(0, -1));
      if (ctx) setChatContext(ctx);
    }
  };

  const runReview = async () => {
    if (reviewing) return;
    setReviewing(true);
    toast('Running your review — this takes a minute…');
    try {
      await api('/api/coach/run-review', { method: 'POST' });
      qc.invalidateQueries({ queryKey: ['chat'] });
      qc.invalidateQueries({ queryKey: ['proposal'] });
      toast('Review done — proposal below', true);
    } catch (e) {
      toast(String((e as Error).message));
    }
    setReviewing(false);
  };

  const hasProposal = !!propQ.data?.proposal;

  return (
    <>
      <Header />
      <div className="scroll" ref={scrollRef}>
        <div className="row" style={{ alignItems: 'center' }}>
          <Title kick="Weekly review · Sun 20:00 · chat anytime">Coach</Title>
          <button className="ghost press" style={{ width: 'auto', padding: '7px 12px', fontSize: 12.5 }}
            disabled={reviewing} onClick={runReview}>{reviewing ? 'Reviewing…' : 'Run review'}</button>
        </div>
        <ProposalCard onChanges={() => {
          setChatContext({ kind: 'proposal', label: 'the proposed week' });
          inputRef.current?.focus();
        }} />
        {msgs.map((m, i) => <ChatBubble key={i} who={m.who} text={m.text} />)}
        {thinking && <div className="bub">thinking — checking your data…</div>}
      </div>
      {!thinking && (
        <div className="sugg">
          {suggestionsFor(hasProposal, msgs.length).map((s) => (
            <button key={s} className="fchip press" onClick={() => send(s)}>{s}</button>
          ))}
        </div>
      )}
      {chatContext && (
        <div className="ctxchip num">
          <span className="dot" style={{ background: 'var(--volt)', width: 6, height: 6,
            borderRadius: '50%', flex: 'none' }} />
          <span style={{ flex: 1 }}>About: <b>{chatContext.label}</b> — data attached</span>
          <button className="press" style={{ color: 'var(--mut)', fontWeight: 700 }}
            onClick={() => setChatContext(null)}>✕</button>
        </div>
      )}
      <div className="chatin">
        <input ref={inputRef} placeholder={thinking ? 'Coach is thinking…' : 'Message your coach…'}
          autoComplete="off" disabled={thinking}
          onKeyDown={(e) => { if (e.key === 'Enter') send(); }} />
        <button className="press" onClick={() => send()} disabled={thinking}
          style={thinking ? { opacity: 0.5 } : undefined}>Send</button>
      </div>
      <Tabs />
    </>
  );
}
