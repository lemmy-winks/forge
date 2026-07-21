import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api, type ChatMsg, type ChatResp, type ProposalResp } from '../api';
import { ChatBubble, Header, Tabs, Title, toast, useApp } from '../ui';

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function ProposalCard({ onChanges, onDecided }: { onChanges: () => void; onDecided?: () => void }) {
  const qc = useQueryClient();
  const q = useQuery<ProposalResp>({ queryKey: ['proposal'], queryFn: () => api('/api/proposal') });
  const [noteOpen, setNoteOpen] = useState(false);
  const [daysOpen, setDaysOpen] = useState(false);
  const p = q.data?.proposal;
  const decide = useMutation({
    mutationFn: (arg: { id: string; verb: 'approve' | 'reject' }) =>
      api(`/api/proposal/${arg.id}/${arg.verb}`, { method: 'POST' }),
    onSuccess: (_d, arg) => {
      toast(arg.verb === 'approve' ? 'Week approved — live now' : 'Proposal dismissed', arg.verb === 'approve');
      qc.invalidateQueries({ queryKey: ['proposal'] });
      qc.invalidateQueries({ queryKey: ['today'] });
      qc.invalidateQueries({ queryKey: ['week'] });
      onDecided?.();
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
    <div>
      <div className="kick" style={{ fontSize: 11 }}>
        Proposed {proposedOn.toLocaleDateString(undefined, { weekday: 'short' })} {proposedOn.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}
        {' · '}plan revision #{p.num} · awaiting your OK
      </div>

      {/* the diff leads: what's changing, one line each */}
      <div style={{ margin: '8px 0' }}>
        {changes.map((c, i) => (
          <div key={i} style={{ display: 'flex', gap: 9, padding: '5px 0', fontSize: 14,
            borderTop: i ? '1px solid var(--hair)' : 'none' }} className="num">
            <b style={{ color: signColor(c.sign), width: 12, flex: 'none', textAlign: 'center' }}>{c.sign}</b>
            <b style={{ flex: 1 }}>{c.what}</b>
            {c.why && <span style={{ fontSize: 12, color: 'var(--mut)', textAlign: 'right', maxWidth: '46%' }}>{c.why}</span>}
          </div>
        ))}
      </div>

      {p.rationale && (
        <button className="coachnote press" onClick={() => setNoteOpen(!noteOpen)}
          style={{ marginBottom: 10 }}>
          <div className={noteOpen ? '' : 'clamp'}>{p.rationale}</div>
          <div className="more">{noteOpen ? 'less' : 'more'}</div>
        </button>
      )}

      <div className="btnrow">
        <button className="cta press" style={{ padding: 11 }} disabled={decide.isPending}
          onClick={() => decide.mutate({ id: p.id, verb: 'approve' })}>Approve week</button>
        <button className="ghost press" style={{ flex: '0 0 auto', width: 'auto', padding: '11px 14px' }}
          onClick={onChanges}>Changes…</button>
      </div>

      {/* the full week, tucked behind an expander */}
      <button className="coachnote press" style={{ marginTop: 10 }} onClick={() => setDaysOpen(!daysOpen)}>
        <div className="more">{daysOpen ? 'hide the day-by-day' : `day-by-day · ${days.length} days`}</div>
      </button>
      {daysOpen && days.map(([k, day]) => (
        <div key={k} style={{ borderTop: '1px solid var(--hair)', padding: '6px 0' }}>
          <div className="row">
            <span style={{ fontSize: 14.5, fontWeight: 600 }}>{DAY_NAMES[+k]} · {day.name}</span>
            <span className="fchips">{(day.focus || []).map((f) => <span key={f} className="fchip">{f}</span>)}</span>
          </div>
          <div className="sub num" style={{ margin: 0 }}>{dayLine(day)}</div>
        </div>
      ))}
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
    refetchInterval: (query) => (query.state.data?.pending ? 1000 : false),
  });
  const propQ = useQuery<ProposalResp>({ queryKey: ['proposal'], queryFn: () => api('/api/proposal') });
  const [pending, setPending] = useState<ChatMsg[]>([]);
  const [reviewing, setReviewing] = useState(false);
  const [propOpen, setPropOpen] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState('');
  const [focused, setFocused] = useState(false);
  const [sentThisVisit, setSentThisVisit] = useState(false);
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
    const text = (raw ?? draft).trim();
    if (!text || thinking) return;
    if (raw === undefined) {
      setDraft('');
      const el = inputRef.current;
      if (el) el.style.height = 'auto';
    }
    setSentThisVisit(true);
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
      if (raw === undefined) setDraft(text); // give the typed message back
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
      toast('Review done — proposal ready', true);
    } catch (e) {
      toast(String((e as Error).message));
    }
    setReviewing(false);
  };

  const prop = propQ.data?.proposal;
  const hasProposal = !!prop;

  /** "Today" / "Yesterday" / "Tue 15 Jul" separators between message days. */
  const sepFor = (at?: string, prev?: string): string | null => {
    if (!at) return null;
    const day = at.slice(0, 10);
    if (prev && prev.slice(0, 10) === day) return null;
    const today = new Date(); const d = new Date(at);
    const diff = Math.round((new Date(today.toDateString()).getTime()
      - new Date(d.toDateString()).getTime()) / 86400000);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  };

  return (
    <>
      <Header />
      <div className="scroll" ref={scrollRef}>
        <div className="row" style={{ alignItems: 'center' }}>
          <Title kick="Weekly review · Sun 20:00 · chat anytime">Coach</Title>
          <button className="ghost press" style={{ width: 'auto', padding: '7px 12px', fontSize: 12.5 }}
            disabled={reviewing} onClick={runReview}>{reviewing ? 'Reviewing…' : 'Run review'}</button>
        </div>
        {msgs.map((m, i) => {
          const sep = sepFor(m.at, msgs[i - 1]?.at);
          return (
            <div key={i} style={{ display: 'contents' }}>
              {sep && <div className="daysep">{sep}</div>}
              <ChatBubble who={m.who} text={m.text} />
            </div>
          );
        })}
        {thinking && <div className="bub">checking your data<span className="dots"><i /><i /><i /></span></div>}
      </div>
      {hasProposal && (
        <button className="propbar press" onClick={() => setPropOpen(true)}>
          <span className="pulse" />
          <b>Next week proposed — rev #{prop!.num}</b>
          <span style={{ color: 'var(--volt)', fontWeight: 700, fontSize: 13 }}>Review ›</span>
        </button>
      )}
      {/* conversation starters, not furniture: gone the moment you're actually
          chatting (typing, focused, or already sent something this visit) */}
      {!thinking && !focused && !draft && !sentThisVisit && (
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
        <textarea ref={inputRef} rows={1} value={draft}
          placeholder={thinking ? 'Coach is thinking…' : 'Message your coach…'}
          autoComplete="off" disabled={thinking}
          onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
          onChange={(e) => {
            setDraft(e.target.value);
            // auto-grow up to ~4 lines, then scroll inside
            e.target.style.height = 'auto';
            e.target.style.height = Math.min(e.target.scrollHeight, 96) + 'px';
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
          }} />
        <button className="press" onClick={() => send()} disabled={thinking}
          style={thinking ? { opacity: 0.5 } : undefined}>Send</button>
      </div>
      <Tabs />
      {propOpen && (
        <div className="overlay" onClick={() => setPropOpen(false)}>
          <div className="sheet" style={{ maxHeight: '78vh', overflowY: 'auto' }}
            onClick={(e) => e.stopPropagation()}>
            <ProposalCard
              onDecided={() => setPropOpen(false)}
              onChanges={() => {
                setPropOpen(false);
                setChatContext({ kind: 'proposal', label: 'the proposed week' });
                inputRef.current?.focus();
              }} />
          </div>
        </div>
      )}
    </>
  );
}
