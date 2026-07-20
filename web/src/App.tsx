import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useReducer, useState, type JSX } from 'react';
import {
  api, ApiError, kgToDisp, loadStep, loadUnitFor, setUnauthorizedHandler, todayISO,
  type Fitted, type Me, type SessionDetail, type StartSessionResp, type Today,
} from './api';
import { flushQueue } from './queue';
import { AuthScreen, DeniedScreen } from './screens/auth';
import { CoachScreen } from './screens/coach';
import { DetailScreen, HistoryScreen, ProgressScreen, RecordsScreen } from './screens/data';
import { LearnScreen } from './screens/learn';
import { OnboardingFlow } from './screens/onboarding';
import { CooldownScreen, LogScreen, SummaryScreen, SwapScreen } from './screens/session';
import {
  CoachSettingsScreen, ConnectionsScreen, EquipmentScreen, LabsScreen, LibraryScreen,
  NigglesScreen, NotifScreen, ServerScreen, SettingsScreen, UnitsScreen,
} from './screens/settings';
import { DayScreen, PlanScreen } from './screens/today';
import {
  AppCtx, curTarget, toast,
  type AppCtxType, type LogAction, type LogState, type LogTarget, type Screen, type SummaryData, type Tab,
} from './ui';

/* ---------------- log session reducer ---------------- */
function logReducer(state: LogState | null, a: LogAction): LogState | null {
  if (a.type === 'start') {
    const t0 = a.targets[0];
    return {
      sid: a.sid, fitted: a.fitted, targets: a.targets, idx: 0,
      done: {}, swaps: {}, wu: {}, cdDone: {},
      w: t0 ? kgToDisp(t0.weight || 0, t0.unit) : 0, r: t0?.reps || 8, rpe: null,
      remain: 0, goFlag: false, t0: Date.now(), pbs: [],
    };
  }
  if (!state) return state;
  switch (a.type) {
    case 'restore': {
      const t = state.targets[a.idx];
      const wKg = a.w || t?.weight || 0;
      return { ...state, done: a.done, swaps: a.swaps, idx: a.idx,
        w: t ? kgToDisp(wKg, t.unit) : wKg, r: a.r || t?.reps || 8 };
    }
    case 'w': {
      const t = curTarget(state);
      const step = loadStep(t.unit, t.kind);
      return { ...state, w: Math.max(0, +(state.w + a.d * step).toFixed(1)) };
    }
    case 'unit': {
      const t = state.targets[state.idx];
      if (!t || t.unit === a.u) return state;
      const targets = state.targets.map((tt, i) => (i === state.idx ? { ...tt, unit: a.u } : tt));
      // re-derive the display value from the prescription so it stays a round number
      return { ...state, targets, w: kgToDisp(t.weight || 0, a.u) };
    }
    case 'r': return { ...state, r: Math.max(1, state.r + a.d) };
    case 'rpe': return { ...state, rpe: a.n };
    case 'wuDone': return { ...state, wu: { ...state.wu, [curTarget(state).slug]: true } };
    case 'logged': {
      const arr = [...(state.done[a.slug] || []), a.set];
      return { ...state, done: { ...state.done, [a.slug]: arr }, rpe: null, goFlag: false,
        remain: a.moreLeft ? a.rest : 0 };
    }
    case 'tick': {
      if (state.remain <= 0) return state;
      const remain = state.remain - 1;
      return { ...state, remain, goFlag: remain <= 0 ? true : state.goFlag };
    }
    case 'skipRest': return { ...state, remain: 0, goFlag: true };
    case 'next': {
      const idx = state.idx + 1;
      const t = state.targets[idx];
      return { ...state, idx, goFlag: false, remain: 0,
        w: t ? kgToDisp(t.weight || 0, t.unit) : 0, r: t?.reps || 8 };
    }
    case 'swap': {
      const orig = state.targets[state.idx];
      return { ...state, swaps: { ...state.swaps, [orig.slug]: a.alt },
        w: kgToDisp(orig.weight || 0, orig.unit), r: orig.reps };
    }
    case 'swapBack': {
      const orig = state.targets[state.idx];
      const swaps = { ...state.swaps };
      delete swaps[orig.slug];
      return { ...state, swaps, w: kgToDisp(orig.weight || 0, orig.unit), r: orig.reps };
    }
    case 'cdTick': return { ...state, cdDone: { ...state.cdDone, [a.i]: !state.cdDone[a.i] } };
    case 'pbs': return { ...state, pbs: [...state.pbs, ...a.pbs] };
    case 'end': return null;
  }
  return state;
}

/* ---------------- authenticated app ---------------- */
function AppInner({ me }: { me: Me }) {
  const qc = useQueryClient();
  const [screen, setScreen] = useState<Screen>('today');
  const [tab, setTab] = useState<Tab>('today');
  const [learnSlug, setLearnSlug] = useState('');
  const [learnFrom, setLearnFrom] = useState<Screen>('today');
  const [detailId, setDetailId] = useState('');
  const [lift, setLift] = useState('');
  const [dayDate, setDayDate] = useState<string | null>(null);
  const [budget, setBudget] = useState<number | null>(null);
  const [summary, setSummary] = useState<SummaryData | null>(null);
  const [chatContext, setChatContext] = useState<AppCtxType['chatContext']>(null);
  const [log, logDispatch] = useReducer(logReducer, null);

  const go = useCallback<AppCtxType['go']>((s, extra) => {
    if (extra?.learnSlug !== undefined) setLearnSlug(extra.learnSlug);
    if (extra?.learnFrom !== undefined) setLearnFrom(extra.learnFrom);
    if (extra?.detailId !== undefined) setDetailId(extra.detailId);
    if (extra?.lift !== undefined) setLift(extra.lift);
    if (extra && 'dayDate' in extra) setDayDate(extra.dayDate ?? null);
    if (extra && 'chatContext' in extra) setChatContext(extra.chatContext ?? null);
    setScreen(s);
    if (s === 'coach') setTab('coach');
  }, []);

  const openTab = useCallback((t: Tab) => { setTab(t); setScreen(t); }, []);

  const startSession = useCallback(async (today: Today, planDay?: string) => {
    let res: StartSessionResp;
    try {
      res = await api<StartSessionResp>('/api/sessions', {
        method: 'POST', body: { budget, plan_day: planDay || null } });
    } catch (e) {
      toast(e instanceof ApiError && e.network ? 'Need a connection to start a session' : String((e as Error).message));
      return;
    }
    const byslug: Record<string, { name: string; kind: string }> = {};
    (today.exercises || []).forEach((e) => { byslug[e.slug] = { name: e.name, kind: e.kind }; });
    const targets: LogTarget[] = (res.fitted.targets || [])
      .filter((t) => t.sets > 0)
      .map((t) => ({ ...t, name: byslug[t.slug]?.name || t.slug, kind: byslug[t.slug]?.kind || 'bb',
        unit: loadUnitFor(me.prefs, t.slug) }));
    logDispatch({ type: 'start', sid: res.id, fitted: res.fitted, targets });
    if (res.resumed) {
      try {
        const detail = await api<SessionDetail>('/api/sessions/' + res.id);
        const done: LogState['done'] = {};
        const swaps: LogState['swaps'] = {};
        detail.exercises.forEach((g) => {
          done[g.slug] = g.sets.map((s) => ({ weight: s.weight, reps: s.reps, rpe: s.rpe }));
          if (g.substituted_for) swaps[g.substituted_for] = { slug: g.slug, name: g.name };
        });
        let idx = 0;
        while (idx < targets.length - 1) {
          const slug = swaps[targets[idx].slug]?.slug || targets[idx].slug;
          if ((done[slug] || []).length >= targets[idx].sets) idx++; else break;
        }
        const t = targets[idx];
        logDispatch({ type: 'restore', done, swaps, idx, w: t.weight, r: t.reps });
      } catch { /* resume best-effort */ }
    }
    go('log');
  }, [budget, go, me]);

  const finishSession = useCallback(async (skipCd: boolean, note: string) => {
    if (!log) return;
    const shown = log.fitted.cd === 'short' ? (log.fitted.cooldown || []).slice(0, 2) : (log.fitted.cooldown || []);
    const ticked = shown.filter((_, i) => log.cdDone[i]).length;
    const status = skipCd ? 'skipped'
      : shown.length && ticked >= shown.length ? 'done'
      : ticked > 0 ? 'partial' : 'skipped';
    let stats: any = {};
    try {
      const res = await api<{ stats: any }>('/api/sessions/' + log.sid + '/complete', {
        method: 'POST',
        body: { cooldown_status: status, cooldown_min: log.fitted.cd === 'short' ? 2 : 5, notes: note },
      });
      stats = res.stats;
    } catch (e) {
      if (e instanceof ApiError && e.network) { toast('Offline — finish again when connected'); return; }
      toast(String((e as Error).message));
    }
    let exercises: SummaryData['exercises'] = [];
    try {
      const detail = await api<SessionDetail>('/api/sessions/' + log.sid);
      exercises = detail.exercises.map((g) => ({ slug: g.slug, name: g.name, substituted_for: g.substituted_for, sets: g.sets }));
    } catch { /* summary still renders from stats */ }
    setSummary({ sid: log.sid, name: log.fitted.name, day: todayISO(), est: log.fitted.est,
      pbs: log.pbs, stats, cooldown_status: status, exercises });
    logDispatch({ type: 'end' });
    qc.invalidateQueries({ queryKey: ['today'] });
    qc.invalidateQueries({ queryKey: ['week'] });
    qc.invalidateQueries({ queryKey: ['history'] });
    qc.invalidateQueries({ queryKey: ['progress'] });
    qc.invalidateQueries({ queryKey: ['records'] });
    go('summary');
  }, [log, qc, go]);

  const signOut = useCallback(async () => {
    try { await api('/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
    location.reload();
  }, []);

  const ctx = useMemo<AppCtxType>(() => ({
    me, screen, tab, learnSlug, learnFrom, detailId, lift, dayDate, chatContext, setChatContext,
    go, openTab, budget, setBudget, log, logDispatch, startSession, finishSession, summary, signOut,
  }), [me, screen, tab, learnSlug, learnFrom, detailId, lift, dayDate, chatContext, go, openTab,
       budget, log, startSession, finishSession, summary, signOut]);

  const SCREENS: Record<Screen, () => JSX.Element> = {
    today: PlanScreen, day: DayScreen, learn: LearnScreen, log: LogScreen, swap: SwapScreen,
    cooldown: CooldownScreen, summary: SummaryScreen,
    history: HistoryScreen, detail: DetailScreen, progress: ProgressScreen, records: RecordsScreen,
    coach: CoachScreen, settings: SettingsScreen, 'set-conn': ConnectionsScreen,
    'set-equip': EquipmentScreen, 'set-niggles': NigglesScreen, 'set-labs': LabsScreen,
    library: LibraryScreen, 'set-notif': NotifScreen, 'set-coach': CoachSettingsScreen,
    'set-units': UnitsScreen, 'set-server': ServerScreen,
  };
  const Cur = SCREENS[screen];
  const curKey = screen === 'day' ? 'day:' + (dayDate || 'today') : screen;
  return <AppCtx.Provider value={ctx}><Cur key={curKey} /></AppCtx.Provider>;
}

/* ---------------- auth gate ---------------- */
function Gate() {
  const qc = useQueryClient();
  const denied = new URLSearchParams(location.search).get('denied');
  const meQ = useQuery<Me>({
    queryKey: ['me'],
    queryFn: () => api<Me>('/auth/me'),
    retry: false,
    staleTime: Infinity,
  });
  setUnauthorizedHandler(() => qc.setQueryData(['me'], null));

  if (denied) return <DeniedScreen email={denied} />;
  if (meQ.isLoading) return <div className="boot">FORGE<span>.</span></div>;
  if (!meQ.data) return <AuthScreen onSignedIn={() => meQ.refetch()} />;
  if (!meQ.data.prefs?.onboarded) return <OnboardingFlow me={meQ.data} onDone={() => meQ.refetch()} />;
  return <AppInner me={meQ.data} />;
}

const qc = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

window.addEventListener('online', () => {
  flushQueue((n) => toast('Synced ' + n + ' queued set' + (n > 1 ? 's' : '')));
});

export default function App() {
  return (
    <QueryClientProvider client={qc}>
      <div className="app"><Gate /></div>
    </QueryClientProvider>
  );
}
