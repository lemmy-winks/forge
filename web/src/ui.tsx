import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react';
import type { ChatContext, ChatResp, Fitted, FittedTarget, LoadUnit, Me, Pb, Today } from './api';
import { useQuery } from '@tanstack/react-query';

/* ---------------- toast (imperative, lives outside the React tree) ---------------- */
export function toast(text: string, volt = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (volt ? ' volt' : '');
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

/* ---------------- navigation / app context ---------------- */
export type Tab = 'today' | 'history' | 'progress' | 'coach';
export type Screen =
  | 'today' | 'day' | 'learn' | 'log' | 'swap' | 'cooldown' | 'summary'
  | 'history' | 'detail' | 'progress' | 'records' | 'coach'
  | 'settings' | 'set-conn' | 'set-equip' | 'set-niggles' | 'set-labs' | 'library' | 'set-notif'
  | 'set-coach' | 'set-units' | 'set-server';

export interface LoggedSetLocal { weight: number; reps: number; rpe: number | null; } // weight in kg
/** unit = display unit for this lift; target weights stay kg, LogState.w is display-unit. */
export interface LogTarget extends FittedTarget { name: string; kind: string; unit: LoadUnit; }
export interface LogState {
  sid: string; fitted: Fitted; targets: LogTarget[]; idx: number;
  done: Record<string, LoggedSetLocal[]>;
  swaps: Record<string, { slug: string; name: string; kind?: string }>;
  wu: Record<string, boolean>;
  cdDone: Record<number, boolean>;
  w: number; r: number; rpe: number | null;
  remain: number; goFlag: boolean; t0: number; pbs: Pb[];
}
export interface SummaryData {
  sid: string; name: string; day: string; est: number; pbs: Pb[]; stats: any; cooldown_status: string;
  exercises: { slug: string; name: string; substituted_for: string | null;
    sets: { weight: number; reps: number; rpe: number | null }[] }[];
}

export interface AppCtxType {
  me: Me;
  screen: Screen; tab: Tab;
  learnSlug: string; learnFrom: Screen; detailId: string; lift: string;
  dayDate: string | null;
  chatContext: ChatContext | null;
  setChatContext: (c: ChatContext | null) => void;
  go: (s: Screen, extra?: Partial<Pick<AppCtxType, 'learnSlug' | 'learnFrom' | 'detailId' | 'lift' | 'dayDate' | 'chatContext'>>) => void;
  openTab: (t: Tab) => void;
  budget: number | null;
  setBudget: (n: number) => void;
  log: LogState | null;
  logDispatch: (a: LogAction) => void;
  startSession: (today: Today, planDay?: string) => Promise<void>;
  finishSession: (skipCd: boolean, note: string) => Promise<void>;
  summary: SummaryData | null;
  signOut: () => void;
}

export type LogAction =
  | { type: 'start'; sid: string; fitted: Fitted; targets: LogTarget[] }
  | { type: 'restore'; done: LogState['done']; swaps: LogState['swaps']; idx: number; w: number; r: number }
  | { type: 'w'; d: number } | { type: 'r'; d: number } | { type: 'rpe'; n: number }
  | { type: 'wuDone' }
  | { type: 'logged'; slug: string; set: LoggedSetLocal; rest: number; moreLeft: boolean }
  | { type: 'tick' } | { type: 'skipRest' } | { type: 'next' }
  | { type: 'swap'; alt: { slug: string; name: string; kind?: string } } | { type: 'swapBack' }
  | { type: 'unit'; u: LoadUnit }
  | { type: 'cdTick'; i: number } | { type: 'pbs'; pbs: Pb[] } | { type: 'end' };

export const AppCtx = createContext<AppCtxType | null>(null);
export function useApp(): AppCtxType {
  const ctx = useContext(AppCtx);
  if (!ctx) throw new Error('AppCtx missing');
  return ctx;
}

/** Current target with any swap applied. */
export function curTarget(log: LogState): LogTarget & { substituted_for?: string } {
  const t = log.targets[log.idx];
  const sw = log.swaps[t.slug];
  return sw ? { ...t, slug: sw.slug, name: sw.name, kind: sw.kind || t.kind, substituted_for: t.slug } : t;
}

/* ---------------- online status ---------------- */
const subscribeOnline = (cb: () => void) => {
  window.addEventListener('online', cb);
  window.addEventListener('offline', cb);
  return () => { window.removeEventListener('online', cb); window.removeEventListener('offline', cb); };
};
export function useOnline(): boolean {
  return useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);
}

/* ---------------- chrome components ---------------- */
const ICONS: Record<Tab, ReactNode> = {
  today: <><rect x="4" y="5" width="16" height="15" rx="2" /><path d="M4 9h16M8 3v4M16 3v4" /></>,
  history: <><circle cx="12" cy="12" r="8" /><path d="M12 8v4l3 2" /></>,
  progress: <path d="M4 18l5-6 4 3 7-9" />,
  coach: <path d="M5 5h14v10H10l-5 4z" />,
};

export function Header() {
  const { me, go } = useApp();
  const online = useOnline();
  return (
    <>
      <div className="hdr">
        <span className="wm">FORGE<i>.</i></span><span className="sp" />
        <button className="avatar press" aria-label="Settings" onClick={() => go('settings')}>
          {me.name[0] || '?'}
        </button>
      </div>
      {!online && <div className="offline">Offline — sets will queue and sync</div>}
    </>
  );
}

const TAB_LABELS: Record<Tab, string> = { today: 'Plan', history: 'History', progress: 'Progress', coach: 'Coach' };

/** Volt dot on the Coach tab when the last coach message is newer than the last visit. */
function useCoachUnread(active: boolean): boolean {
  const chat = useQuery<ChatResp>({ queryKey: ['chat'], queryFn: () => Promise.reject(), enabled: false });
  if (active) return false;
  const msgs = chat.data?.messages || [];
  const lastCoach = [...msgs].reverse().find((m) => m.who === 'coach');
  if (!lastCoach?.at) return false;
  return lastCoach.at > (localStorage.getItem('forge-chat-seen') || '');
}

export function Tabs() {
  const { tab, openTab } = useApp();
  const unread = useCoachUnread(tab === 'coach');
  return (
    <nav className="tabs">
      {(['today', 'history', 'progress', 'coach'] as Tab[]).map((t) => (
        <button key={t} className={'tab' + (tab === t ? ' on' : '')} onClick={() => openTab(t)}
          style={{ position: 'relative' }}>
          <svg viewBox="0 0 24 24">{ICONS[t]}</svg>
          {TAB_LABELS[t]}
          {t === 'coach' && unread && (
            <span style={{ position: 'absolute', top: 2, right: '28%', width: 7, height: 7,
              borderRadius: '50%', background: 'var(--volt)' }} />
          )}
        </button>
      ))}
    </nav>
  );
}

/** Standard screen shell: header, scrollable body, tab bar. */
export function Shell({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  return (
    <>
      <Header />
      <div className="scroll">{children}</div>
      {footer}
      <Tabs />
    </>
  );
}

export function Title({ kick, children }: { kick: string; children: ReactNode }) {
  return (
    <div>
      <span className="kick">{kick}</span>
      <h2 className="title">{children}</h2>
    </div>
  );
}

export function Chip({ children }: { children: ReactNode }) {
  return <div className="chip"><span className="dot" />{children}</div>;
}

export function Back({ label, onClick }: { label: string; onClick: () => void }) {
  return <button className="back press" onClick={onClick}>‹ {label}</button>;
}

export function Loading() {
  return <div className="chip">Loading…</div>;
}

/* ---------------- chat bubbles ---------------- */
/** Minimal markdown for coach messages: bold, italics, bullets, line breaks.
    The model writes markdown; raw asterisks in a bubble read as a bug. */
function mdHTML(text: string): string {
  const escaped = text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
  return escaped
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|\s)\*([^*\n]+)\*(?=\s|[.,!?]|$)/g, '$1<i>$2</i>')
    .replace(/^#{1,4}\s*(.+)$/gm, '<b>$1</b>')
    .replace(/^\s*[-•]\s+/gm, '&nbsp;&nbsp;•&nbsp;')
    .replace(/\n/g, '<br>');
}

export function ChatBubble({ who, text }: { who: 'me' | 'coach'; text: string }) {
  if (who === 'coach') {
    return <div className="bub num" dangerouslySetInnerHTML={{ __html: mdHTML(text) }} />;
  }
  // my messages may carry a context tag — render it as a quiet second line
  const m = text.match(/^([\s\S]*?)\n(\[re: [^\]]+\])\s*$/);
  return (
    <div className="bub me num">
      {m ? m[1] : text}
      {m && <div style={{ fontSize: 10.5, opacity: 0.65, marginTop: 3 }}>{m[2]}</div>}
    </div>
  );
}
