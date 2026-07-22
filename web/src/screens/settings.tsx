import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import {
  api, enablePush, heightDisp, lipidDisp, lipidToMmol, todayISO,
  type Connections, type EquipmentData, type LabPanelRow, type Me, type NiggleRow, type Progress,
} from '../api';
import {
  applyPalette, applyTheme, Back, Chip, Loading, PALETTES, Shell, storedPalette, storedTheme,
  Title, toast, useApp, type ThemePref,
} from '../ui';

/* ---------------- settings home ---------------- */
export function SettingsScreen() {
  const { me, go, tab, openTab, signOut } = useApp();
  const qc = useQueryClient();
  const connQ = useQuery<Connections>({ queryKey: ['connections'], queryFn: () => api('/api/connections') });
  const theme: ThemePref = me.prefs?.theme || storedTheme();
  const pickTheme = (v: string) => {
    applyTheme(v as ThemePref);
    qc.setQueryData<Me>(['me'], (old) => old && { ...old, prefs: { ...old.prefs, theme: v } });
    api('/api/prefs', { method: 'PATCH', body: { prefs: { theme: v } } }).catch(() => toast('Offline — not saved'));
  };
  const palette = me.prefs?.palette || storedPalette();
  const palName = (PALETTES.find(([id]) => id === palette) || PALETTES[0])[1];
  const nigQ = useQuery<NiggleRow[]>({ queryKey: ['niggles'], queryFn: () => api('/api/niggles') });
  const activeN = (nigQ.data || []).filter((n) => n.status === 'active').length;
  const exportData = async () => {
    const data = await api('/api/export');
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'forge-export.json';
    a.click();
  };
  const rows: [string, string, () => void][] = [
    ['Nutrition', 'targets, cook nights, budgets', () => go('set-food')],
    ['Units', 'loads, body, labs', () => go('set-units')],
    ['Connections', connQ.data ? (connQ.data.apple_health.last_push ? 'Apple Health ✓' : 'Apple Health — not seen yet') : '…', () => go('set-conn')],
    ['Coach', connQ.data?.coach_mcp.active ? 'agent live · Sun 20:00 review' : 'not configured', () => go('set-coach')],
    ['Equipment', 'profiles & plates', () => go('set-equip')],
    ['Niggles', `${activeN} active`, () => go('set-niggles')],
    ['Labs', 'lipid panels', () => go('set-labs')],
    ['Exercise library', 'browse all', () => go('library')],
    ['Notifications', 'three kinds, no more', () => go('set-notif')],
    ...(me.role === 'admin'
      ? [['Server', 'coach key · withings · push · users', () => go('set-server')] as [string, string, () => void]]
      : []),
  ];
  return (
    <Shell>
      <Back label="Close" onClick={() => openTab(tab)} />
      <h2 className="title">Settings</h2>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '2px 2px 4px' }}>
        <span className="avatar" style={{ width: 42, height: 42, fontSize: 17 }}>{me.name[0]}</span>
        <span><b style={{ fontSize: 15.5 }}>{me.name}</b>
          <div style={{ fontSize: 12, color: 'var(--mut)' }}>{me.email} · {me.units}</div></span>
        {me.role === 'admin' && (
          <span style={{ marginLeft: 'auto', fontSize: 10, padding: '2px 8px', borderRadius: 999,
            border: '1px solid var(--hair)', color: 'var(--volt)', fontWeight: 700 }}>ADMIN</span>
        )}
      </div>
      <AboutYouCard />
      <div className="card">
        <div className="lab" style={{ marginBottom: 8 }}>Appearance</div>
        <UnitSeg value={theme} onPick={pickTheme}
          options={[['dark', 'Dark'], ['light', 'Light'], ['system', 'Auto']]} />
        <button className="press" onClick={() => go('set-accent')}
          style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                   marginTop: 10, fontSize: 13, color: 'var(--mut)' }}>
          Accent color
          <span style={{ marginLeft: 'auto', color: 'var(--volt)', fontWeight: 650 }}>{palName}</span>
          <span className="chev">›</span>
        </button>
      </div>
      {rows.map(([label, sub, onClick]) => (
        <button key={label} className="lrow press" onClick={onClick}>
          <b>{label}</b><span className="rsub">{sub}</span><span className="chev">›</span>
        </button>
      ))}
      <button className="lrow press" onClick={exportData}><b>Export my data</b><span className="rsub">JSON download</span></button>
      <button className="lrow press" onClick={signOut}><b style={{ color: 'var(--volt-deep)' }}>Sign out</b></button>
    </Shell>
  );
}

/* ---------------- accent color ---------------- */
export function AccentScreen() {
  const { me, go } = useApp();
  const qc = useQueryClient();
  const palette = me.prefs?.palette || storedPalette();
  const pick = (v: string) => {
    applyPalette(v);
    qc.setQueryData<Me>(['me'], (old) => old && { ...old, prefs: { ...old.prefs, palette: v } });
    api('/api/prefs', { method: 'PATCH', body: { prefs: { palette: v } } }).catch(() => toast('Offline — not saved'));
  };
  return (
    <Shell>
      <Back label="Settings" onClick={() => go('settings')} />
      <Title kick="appearance">Accent color</Title>
      <div className="card">
        <div className="palrow">
          {PALETTES.map(([id, name, [dk, lt]]) => (
            <button key={id} className={palette === id ? 'sel' : ''} onClick={() => pick(id)}>
              <span className="pdot"
                style={{ background: `linear-gradient(135deg, ${dk} 50%, ${lt} 50%)` }} />
              {name}
            </button>
          ))}
        </div>
        <div className="sub" style={{ marginTop: 10 }}>
          One accent everywhere — actions, trends, charts. Each option is tuned
          separately for dark and light so it stays readable in both.
        </div>
      </div>
    </Shell>
  );
}

/** Sex + birth year — used only to pick the right reference bands on the
    Progress metric screens. Optional; generic adult bands apply until set. */
function AboutYouCard() {
  const { me } = useApp();
  const qc = useQueryClient();
  const yearRef = useRef<HTMLInputElement>(null);
  const save = (patch: Record<string, any>) => {
    qc.setQueryData<Me>(['me'], (old) => old && { ...old, prefs: { ...old.prefs, ...patch } });
    api('/api/prefs', { method: 'PATCH', body: { prefs: patch } }).catch(() => toast('Offline — not saved'));
  };
  const saveYear = () => {
    const y = parseInt(yearRef.current?.value || '', 10);
    if (!y) return;
    if (y < 1930 || y > 2015) { toast('That birth year doesn’t look right'); return; }
    save({ birth_year: y });
    toast('Saved — reference ranges now use your age', true);
  };
  return (
    <div className="card">
      <div className="lab" style={{ marginBottom: 8 }}>About you · tunes healthy ranges</div>
      <UnitSeg value={me.prefs?.sex || ''} options={[['m', 'Male'], ['f', 'Female']]}
        onPick={(v) => save({ sex: v })} />
      <div className="btnrow" style={{ marginTop: 8, alignItems: 'flex-end' }}>
        <div className="field" style={{ flex: 1 }}><label>Birth year</label>
          <input ref={yearRef} inputMode="numeric" placeholder="1988"
            defaultValue={me.prefs?.birth_year || ''} onBlur={saveYear}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} /></div>
      </div>
      <div className="sub">Only used to pick age- and sex-appropriate reference bands on the
        Progress charts — never shared, never sent anywhere.</div>
    </div>
  );
}

/* ---------------- units ---------------- */
function UnitSeg({ value, options, onPick }: {
  value: string; options: [string, string][]; onPick: (v: string) => void;
}) {
  return (
    <div className="seg">
      {options.map(([v, label]) => (
        <button key={v} className={value === v ? 'sel' : ''} onClick={() => onPick(v)}>{label}</button>
      ))}
    </div>
  );
}

/* ---------------- nutrition (beta track, Phase 7 — E16.1) ---------------- */
export function NutritionScreen() {
  const { me, go, openTab } = useApp();
  const qc = useQueryClient();
  const [prefs, setPrefs] = useState<Record<string, any>>(me.prefs || {});
  const groceryRef = useRef<HTMLInputElement>(null);
  const lunchRef = useRef<HTMLInputElement>(null);
  // merge under stored prefs so users whose targets predate the full macro set still see the new ones
  const t = { kcal: 2300, protein_g: 160, carbs_g: 250, sugar_g: 65, fiber_g: 38,
    fat_g: 80, satfat_g: 18, sodium_mg: 2300, ...(prefs.nutrition_targets || {}) };

  const savePrefs = (patch: Record<string, any>) => {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    qc.setQueryData<Me>(['me'], (old) => old && { ...old, prefs: next });
    api('/api/prefs', { method: 'PATCH', body: { prefs: patch } }).catch(() => toast('Offline — not saved'));
  };
  const saveBudgets = () => {
    const g = parseFloat(groceryRef.current?.value || '');
    const l = parseFloat(lunchRef.current?.value || '');
    const patch: Record<string, any> = {};
    if (g > 0) patch.budget_grocery = g;
    if (l > 0) patch.budget_lunch = l;
    if (!Object.keys(patch).length) { toast('Enter a number first'); return; }
    savePrefs(patch);
    toast('Budgets saved', true);
  };

  return (
    <Shell>
      <Back label="Settings" onClick={() => go('settings')} />
      <h2 className="title">Nutrition</h2>

      <div className="card">
        <div className="kick" style={{ fontSize: 11, marginBottom: 6 }}>Daily targets · set by your coach</div>
        <div className="disp num" style={{ fontSize: 17 }}>
          {t.kcal} kcal · P {t.protein_g} · C {t.carbs_g} · F {t.fat_g} · fiber {t.fiber_g}
        </div>
        <div className="disp num" style={{ fontSize: 13, color: 'var(--mut)', marginTop: 2 }}>
          caps · sat fat ≤{t.satfat_g} g · sugar ≤{t.sugar_g} g · sodium ≤{t.sodium_mg} mg
        </div>
        <div className="sub">Proposed from your goals, training load and labs. Change them in chat —
          the coach explains the trade-offs first.</div>
        <button className="ghost press" style={{ marginTop: 8, padding: 9 }} onClick={() => openTab('coach')}>
          Discuss targets with the coach
        </button>
      </div>

      <div className="card">
        <div className="kick" style={{ fontSize: 11, marginBottom: 6 }}>Cook nights per week</div>
        <UnitSeg value={String(prefs.cook_nights ?? 4)}
          options={[['3', '3'], ['4', '4'], ['5', '5'], ['6', '6']]}
          onPick={(v) => savePrefs({ cook_nights: +v })} />
        <div className="sub">The weekly proposal plans this many dinners; the rest are leftovers or out.
          Batch nights count once.</div>
      </div>

      <div className="card">
        <div className="kick" style={{ fontSize: 11, marginBottom: 8 }}>Budgets</div>
        <div className="btnrow">
          <div className="field" style={{ flex: 1 }}><label>Grocery · week</label>
            <input ref={groceryRef} inputMode="decimal" placeholder={String(prefs.budget_grocery ?? 110)} /></div>
          <div className="field" style={{ flex: 1 }}><label>Lunch cap · day</label>
            <input ref={lunchRef} inputMode="decimal" placeholder={String(prefs.budget_lunch ?? 15)} /></div>
        </div>
        <button className="ghost press" style={{ marginTop: 8, padding: 9 }} onClick={saveBudgets}>
          Save budgets
        </button>
      </div>

      <div className="card">
        <div className="kick" style={{ fontSize: 11, marginBottom: 6 }}>Dinners feed the household</div>
        <UnitSeg value={prefs.household_dinners === false ? 'off' : 'on'}
          options={[['on', 'On'], ['off', 'Off']]}
          onPick={(v) => savePrefs({ household_dinners: v === 'on' })} />
        <div className="sub">Portions ×2 when you're both in — each plate logs to its own day,
          each person's targets stay their own.</div>
      </div>

      <Chip>No new notification kinds — your food week rides the existing Sunday proposal push.
        Coach-proposed food weeks and the shopping list land in Phase 8.</Chip>
    </Shell>
  );
}

export function UnitsScreen() {
  const { me, go } = useApp();
  const qc = useQueryClient();
  const [prefs, setPrefs] = useState<Record<string, any>>(me.prefs || {});
  const [units, setUnits] = useState(me.units);
  const ftRef = useRef<HTMLInputElement>(null);
  const inRef = useRef<HTMLInputElement>(null);
  const cmRef = useRef<HTMLInputElement>(null);
  const progQ = useQuery<Progress>({ queryKey: ['progress'], queryFn: () => api('/api/progress') });
  const heightCm = progQ.data?.bodycomp.height_cm ?? null;
  const heightU = prefs.unit_height === 'ftin' ? 'ftin' : 'cm';

  const savePrefs = (patch: Record<string, any>) => {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    qc.setQueryData<Me>(['me'], (old) => old && { ...old, prefs: next });
    api('/api/prefs', { method: 'PATCH', body: { prefs: patch } }).catch(() => toast('Offline — not saved'));
  };
  const saveBodyUnits = (u: string) => {
    setUnits(u);
    qc.setQueryData<Me>(['me'], (old) => old && { ...old, units: u });
    api('/api/prefs', { method: 'PATCH', body: { units: u } }).catch(() => toast('Offline — not saved'));
  };
  const saveHeight = async () => {
    let cm: number;
    if (heightU === 'ftin') {
      cm = ((parseFloat(ftRef.current?.value || '0') * 12) + parseFloat(inRef.current?.value || '0')) * 2.54;
    } else {
      cm = parseFloat(cmRef.current?.value || '');
    }
    if (!cm || cm < 90 || cm > 250) { toast('That height doesn’t look right'); return; }
    await api('/api/body', { method: 'POST', body: { type: 'height', value: +cm.toFixed(1) } });
    qc.invalidateQueries({ queryKey: ['progress'] });
    toast('Height saved');
  };
  const overrideCount = Object.keys(prefs.load_units || {}).length;

  return (
    <Shell>
      <Back label="Settings" onClick={() => go('settings')} />
      <h2 className="title">Units</h2>
      <div className="card">
        <div className="kick" style={{ fontSize: 11, marginBottom: 6 }}>Lifting loads</div>
        <UnitSeg value={prefs.unit_load === 'kg' ? 'kg' : 'lb'}
          options={[['lb', 'Pounds'], ['kg', 'Kilograms']]}
          onPick={(v) => savePrefs({ unit_load: v })} />
        <div className="sub">Default for every lift — flip any single exercise mid-session with the
          lb/kg toggle next to the weight stepper.
          {overrideCount > 0 && <> {overrideCount} exercise{overrideCount > 1 ? 's' : ''} overridden. </>}
        </div>
        {overrideCount > 0 && (
          <button className="ghost press" style={{ marginTop: 6, padding: 8 }}
            onClick={() => savePrefs({ load_units: {} })}>Clear per-exercise overrides</button>
        )}
      </div>
      <div className="card">
        <div className="kick" style={{ fontSize: 11, marginBottom: 6 }}>Bodyweight</div>
        <UnitSeg value={units} options={[['kg', 'Kilograms'], ['lb', 'Pounds']]} onPick={saveBodyUnits} />
      </div>
      <div className="card">
        <div className="kick" style={{ fontSize: 11, marginBottom: 6 }}>Height</div>
        <UnitSeg value={heightU} options={[['cm', 'Centimetres'], ['ftin', 'Feet & inches']]}
          onPick={(v) => savePrefs({ unit_height: v })} />
        <div className="sub num">{heightCm != null ? `On record: ${heightDisp(heightCm, heightU)}` : 'No height on record yet'}</div>
        <div className="btnrow" style={{ marginTop: 8, alignItems: 'flex-end' }}>
          {heightU === 'ftin' ? (
            <>
              <div className="field" style={{ flex: 1 }}><label>ft</label>
                <input ref={ftRef} inputMode="numeric" placeholder="5" /></div>
              <div className="field" style={{ flex: 1 }}><label>in</label>
                <input ref={inRef} inputMode="numeric" placeholder="11" /></div>
            </>
          ) : (
            <div className="field" style={{ flex: 1 }}><label>cm</label>
              <input ref={cmRef} inputMode="decimal" placeholder="180" /></div>
          )}
          <button className="ghost press" style={{ flex: 1, padding: 10 }} onClick={saveHeight}>Save height</button>
        </div>
      </div>
      <div className="card">
        <div className="kick" style={{ fontSize: 11, marginBottom: 6 }}>Cholesterol & lipids</div>
        <UnitSeg value={prefs.unit_lipids === 'mgdl' ? 'mgdl' : 'mmol'}
          options={[['mmol', 'mmol/L'], ['mgdl', 'mg/dL']]}
          onPick={(v) => savePrefs({ unit_lipids: v })} />
        <div className="sub">UK labs report mmol/L; US labs mg/dL. Stored values convert either way.</div>
      </div>
      <Chip>Everything is stored in metric (kg · cm · mmol/L) — these settings only change display
        and entry. Withings syncs are unaffected.</Chip>
    </Shell>
  );
}

/* ---------------- connections ---------------- */
export function ConnectionsScreen() {
  const { go } = useApp();
  const qc = useQueryClient();
  const [revealed, setRevealed] = useState<string | null>(null);
  const q = useQuery<Connections>({ queryKey: ['connections'], queryFn: () => api('/api/connections') });
  const c = q.data;
  const rotate = useMutation({
    mutationFn: () => api<{ token: string }>('/api/connections/rotate-token', { method: 'POST' }),
    onSuccess: (r) => {
      setRevealed(r.token);
      qc.invalidateQueries({ queryKey: ['connections'] });
      toast('New token — copy it into Health Auto Export');
    },
  });
  if (!c) return <Shell><Back label="Settings" onClick={() => go('settings')} /><Loading /></Shell>;
  const ah = c.apple_health;
  return (
    <Shell>
      <Back label="Settings" onClick={() => go('settings')} />
      <h2 className="title">Connections</h2>
      <div className="card">
        <div className="row"><span className="xname">Apple Health</span>
          <span className={ah.last_push ? 'up' : 'warn'} style={{ fontSize: 12 }}>
            ● {ah.last_push ? 'Live' : 'Waiting for first push'}</span></div>
        <div className="sub">
          {ah.last_push
            ? `Last push ${new Date(ah.last_push).toLocaleString()} · ${ah.samples} samples`
            : 'Point Health Auto Export at this server'}
        </div>
        <div className="sub num" style={{ fontFamily: 'ui-monospace,Menlo,monospace', background: 'var(--sunken)',
          borderRadius: 8, padding: '6px 9px', marginTop: 6 }}>
          {revealed || ah.token_masked || '—'}
          <button className="press" style={{ color: 'var(--volt)', fontWeight: 700, float: 'right' }}
            onClick={async () => {
              if (revealed) {
                try { await navigator.clipboard.writeText(revealed); toast('Copied'); }
                catch { toast('Copy failed — long-press to select'); }
              } else rotate.mutate();
            }}>
            {revealed ? 'COPY' : 'ROTATE'}
          </button>
        </div>
        <div className="sub">
          Health Auto Export → Automations → REST API → URL{' '}
          <b style={{ color: 'var(--ink)' }}>{location.origin}/ingest</b>, header{' '}
          <b style={{ color: 'var(--ink)' }}>Authorization: Bearer &lt;token&gt;</b>.
          Rotating kills the old token instantly.
        </div>
      </div>
      <div className="card">
        <div className="row"><span className="xname">Withings</span>
          <span className={c.withings.linked ? (c.withings.warning ? 'warn' : 'up') : 'sub'}
            style={{ fontSize: 12, margin: 0 }}>
            {c.withings.linked ? (c.withings.warning ? '● Needs re-link' : '● Linked') : c.withings.note}
          </span></div>
        {c.withings.warning && <div className="sub warn" style={{ fontWeight: 400 }}>{c.withings.warning}</div>}
        <div className="sub">
          {c.withings.linked
            ? `Weigh-ins sync directly${c.withings.last_sync ? ' · last sync ' + new Date(c.withings.last_sync).toLocaleString() : ''}`
            : c.withings.configured
              ? 'Link your account so weigh-ins sync without the phone in the loop.'
              : 'Server needs Withings API credentials — weight still flows via Apple Health meanwhile.'}
        </div>
        {c.withings.configured && (
          <div className="btnrow" style={{ marginTop: 8 }}>
            {!c.withings.linked || c.withings.warning ? (
              <button className="ghost press" style={{ flex: 1 }}
                onClick={() => { location.href = '/api/withings/connect'; }}
              >{c.withings.linked ? 'Re-link Withings' : 'Link Withings'}</button>
            ) : (
              <>
                <button className="ghost press" style={{ flex: 1 }} onClick={async () => {
                  const r = await api<{ stored: number }>('/api/withings/sync', { method: 'POST' });
                  toast(r.stored ? `Synced ${r.stored} new readings` : 'Up to date');
                  qc.invalidateQueries({ queryKey: ['connections'] });
                }}>Sync now</button>
                <button className="ghost press" style={{ flex: 1 }} onClick={async () => {
                  await api('/api/withings/unlink', { method: 'POST' });
                  toast('Withings unlinked — tokens revoked');
                  qc.invalidateQueries({ queryKey: ['connections'] });
                }}>Unlink</button>
              </>
            )}
          </div>
        )}
      </div>
      <div className="card">
        <div className="row"><span className="xname">Coach access · MCP</span>
          <span className="sub" style={{ margin: 0 }}>{c.coach_mcp.note}</span></div>
      </div>
    </Shell>
  );
}

/* ---------------- equipment ---------------- */
export function EquipmentScreen() {
  const { go } = useApp();
  const qc = useQueryClient();
  const [idx, setIdx] = useState(0);
  const q = useQuery<EquipmentData>({ queryKey: ['equipment'], queryFn: () => api('/api/equipment') });
  const eq = q.data;
  if (!eq) return <Shell><Back label="Settings" onClick={() => go('settings')} /><Loading /></Shell>;
  const prof = eq.profiles[Math.min(idx, eq.profiles.length - 1)];
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['equipment'] });
    qc.invalidateQueries({ queryKey: ['today'] });
  };
  const toggle = async (i: number) => {
    const items = prof.items.map((it, j) => (j === i ? { ...it, available: !it.available } : it));
    qc.setQueryData<EquipmentData>(['equipment'], (old) => old && {
      ...old, profiles: old.profiles.map((p) => (p.id === prof.id ? { ...p, items } : p)),
    });
    await api('/api/equipment/' + prof.id, { method: 'PATCH', body: { items } });
    invalidate();
  };
  const activate = async () => {
    await api('/api/equipment/active', { method: 'POST', body: { profile_id: prof.id } });
    invalidate();
  };
  return (
    <Shell>
      <Back label="Settings" onClick={() => go('settings')} />
      <h2 className="title">Equipment</h2>
      <div className="seg">
        {eq.profiles.map((p, i) => (
          <button key={p.id} className={i === idx ? 'sel' : ''} onClick={() => setIdx(i)}>
            {p.name}{p.shared ? ' ⌂' : ''}
          </button>
        ))}
      </div>
      <Chip>{prof.id === eq.active_id
        ? 'Active profile — plans are constrained to this list'
        : 'Tap "make active" to plan against this profile'}</Chip>
      {prof.id !== eq.active_id && <button className="ghost press" onClick={activate}>Make active</button>}
      {prof.items.map((it, i) => (
        <button key={it.name} className={'lrow press' + (it.available ? '' : ' dimrow')} onClick={() => toggle(i)}>
          <b>{it.name}</b><span className="rsub">{it.available ? '✓ available' : '✕ not here'}</span>
        </button>
      ))}
      {prof.plates_kg.length > 0 && (
        <div className="chip num"><span className="dot" />
          Bar {prof.bar_kg} kg · plates per side: {prof.plates_kg.join(', ')}</div>
      )}
    </Shell>
  );
}

/* ---------------- niggles ---------------- */
export function NigglesScreen() {
  const { go } = useApp();
  const qc = useQueryClient();
  const partRef = useRef<HTMLInputElement>(null);
  const noteRef = useRef<HTMLInputElement>(null);
  const q = useQuery<NiggleRow[]>({ queryKey: ['niggles'], queryFn: () => api('/api/niggles') });
  const rows = q.data;
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['niggles'] });
    qc.invalidateQueries({ queryKey: ['today'] });
  };
  const add = async () => {
    const part = partRef.current?.value.trim();
    if (!part) { toast('Body part needed'); return; }
    await api('/api/niggles', { method: 'POST', body: { body_part: part, note: noteRef.current?.value.trim() || '' } });
    if (partRef.current) partRef.current.value = '';
    if (noteRef.current) noteRef.current.value = '';
    refresh();
  };
  const clear = async (id: string) => {
    await api('/api/niggles/' + id, { method: 'PATCH', body: { status: 'cleared' } });
    refresh();
  };
  if (!rows) return <Shell><Back label="Settings" onClick={() => go('settings')} /><Loading /></Shell>;
  return (
    <Shell>
      <Back label="Settings" onClick={() => go('settings')} />
      <h2 className="title">Niggles</h2>
      {rows.map((n) => (
        <div key={n.id} className={'lrow' + (n.status === 'cleared' ? ' dimrow' : '')}>
          <b>{n.body_part}</b>
          <span className="rsub">
            {n.note}<br />
            {n.status !== 'cleared'
              ? <button className="press" style={{ color: 'var(--volt)', fontWeight: 700 }}
                  onClick={() => clear(n.id)}>mark cleared</button>
              : `cleared ${n.cleared_at || ''}`}
          </span>
          <span className={'fchip' + (n.status === 'active' ? '' : ' dim')}>{n.status.toUpperCase()}</span>
        </div>
      ))}
      <div className="card">
        <div className="kick" style={{ fontSize: 11, marginBottom: 8 }}>Log a niggle</div>
        <div className="field"><label>Body part</label><input ref={partRef} placeholder="Left knee" /></div>
        <div className="field" style={{ marginTop: 8 }}><label>Note</label><input ref={noteRef} placeholder="Grumbles in deep lunges" /></div>
        <button className="ghost press" style={{ marginTop: 10 }} onClick={add}>Add</button>
      </div>
      <Chip>Active niggles constrain swaps and (from Phase 3) plan proposals</Chip>
    </Shell>
  );
}

/* ---------------- labs ---------------- */
const MARKERS = ['LDL', 'HDL', 'Triglycerides', 'Total'] as const;
const REFS: Record<string, [number | null, number | null]> = {
  LDL: [null, 3.0], HDL: [1.0, null], Triglycerides: [null, 1.7], Total: [null, 5.0],
};

export function LabsScreen() {
  const { go, me } = useApp();
  const qc = useQueryClient();
  const refs = useRef<Record<string, HTMLInputElement | null>>({});
  const dateRef = useRef<HTMLInputElement>(null);
  const q = useQuery<LabPanelRow[]>({ queryKey: ['labs'], queryFn: () => api('/api/labs') });
  const panels = q.data;
  const lipU = me.prefs?.unit_lipids === 'mgdl' ? 'mgdl' : 'mmol';
  const save = async () => {
    // Entered in the preferred unit, stored canonical mmol/L.
    const results = MARKERS
      .map((m) => ({ marker: m, value: lipidToMmol(m, parseFloat(refs.current[m]?.value || ''), lipU),
                     ref_low: REFS[m][0], ref_high: REFS[m][1] }))
      .filter((r) => !isNaN(r.value));
    if (!results.length) { toast('Enter at least one value'); return; }
    await api('/api/labs', { method: 'POST', body: { drawn_on: dateRef.current?.value || todayISO(), results } });
    qc.invalidateQueries({ queryKey: ['labs'] });
    toast('Panel saved');
  };
  if (!panels) return <Shell><Back label="Settings" onClick={() => go('settings')} /><Loading /></Shell>;
  return (
    <Shell>
      <Back label="Settings" onClick={() => go('settings')} />
      <h2 className="title">Labs</h2>
      {!panels.length && <Chip>No panels yet — add your latest lipid results below.</Chip>}
      {panels.map((p) => (
        <div key={p.id} className="card num">
          <div className="kick" style={{ fontSize: 11, marginBottom: 6 }}>{p.drawn_on}</div>
          {p.results.map((r) => {
            const inRange = (r.ref_high == null || r.value <= r.ref_high) && (r.ref_low == null || r.value >= r.ref_low);
            return (
              <div key={r.marker} className="row" style={{ padding: '2px 0' }}>
                <span className="sub" style={{ margin: 0 }}>{r.marker}</span>
                <span className="sub" style={{ margin: 0, color: 'var(--ink)' }}>
                  {lipidDisp(r.marker, r.value, lipU)} {inRange && <span className="up">· in range</span>}
                </span>
              </div>
            );
          })}
        </div>
      ))}
      <div className="card">
        <div className="kick" style={{ fontSize: 11, marginBottom: 8 }}>Add lipid panel</div>
        <div className="field"><label>Drawn on</label><input ref={dateRef} defaultValue={todayISO()} /></div>
        <div className="tiles" style={{ marginTop: 8 }}>
          {MARKERS.map((m) => (
            <div key={m} className="field"><label>{m} {lipU === 'mgdl' ? 'mg/dL' : 'mmol/L'}</label>
              <input ref={(el) => { refs.current[m] = el; }} inputMode="decimal" placeholder="—" /></div>
          ))}
        </div>
        <button className="ghost press" style={{ marginTop: 10 }} onClick={save}>Save panel</button>
      </div>
    </Shell>
  );
}

/* ---------------- library ---------------- */
export function LibraryScreen() {
  const { go } = useApp();
  const [qtext, setQtext] = useState('');
  const q = useQuery<{ slug: string; name: string; media_tier: string; primary_muscles: string[] }[]>({
    queryKey: ['exercises'], queryFn: () => api('/api/exercises'), staleTime: 60_000,
  });
  const rows = (q.data || []).filter((e) => !qtext || e.name.toLowerCase().includes(qtext.toLowerCase()));
  return (
    <Shell>
      <Back label="Settings" onClick={() => go('settings')} />
      <h2 className="title">Exercise library</h2>
      <div className="field">
        <input placeholder="Search…" value={qtext} onChange={(e) => setQtext(e.target.value)} />
      </div>
      {!q.data && <Loading />}
      {rows.map((e) => (
        <button key={e.slug} className="lrow press"
          onClick={() => go('learn', { learnSlug: e.slug, learnFrom: 'library' })}>
          <b>{e.name}</b><span className="rsub">{e.primary_muscles.join(' · ')}</span>
          <span className="fchip dim">{e.media_tier.toUpperCase()}</span>
        </button>
      ))}
    </Shell>
  );
}

/* ---------------- coach settings ---------------- */
export function CoachSettingsScreen() {
  const { me, go } = useApp();
  const [prefs, setPrefs] = useState<Record<string, any>>(me.prefs || {});
  const save = (next: Record<string, any>) => {
    setPrefs(next);
    api('/api/prefs', { method: 'PATCH', body: { prefs: next } }).catch(() => toast('Offline — not saved'));
  };
  const style = prefs.coach_style || 'standard';
  const approval = prefs.coach_approval || 'propose';
  return (
    <Shell>
      <Back label="Settings" onClick={() => go('settings')} />
      <h2 className="title">Coach</h2>
      <div className="lrow"><b>Weekly review</b><span className="rsub">Sunday · from 20:00 · automatic</span></div>
      <div className="card">
        <div className="kick" style={{ fontSize: 11, marginBottom: 6 }}>Plan changes</div>
        <div className="seg">
          {(['propose', 'auto'] as const).map((v) => (
            <button key={v} className={approval === v ? 'sel' : ''}
              onClick={() => save({ ...prefs, coach_approval: v })}>
              {v === 'propose' ? 'Propose — I approve' : 'Auto-apply'}
            </button>
          ))}
        </div>
      </div>
      <div className="card">
        <div className="kick" style={{ fontSize: 11, marginBottom: 6 }}>Progression style</div>
        <div className="seg">
          {(['steady', 'standard', 'aggressive'] as const).map((v) => (
            <button key={v} className={style === v ? 'sel' : ''}
              onClick={() => save({ ...prefs, coach_style: v })}>
              {v[0].toUpperCase() + v.slice(1)}
            </button>
          ))}
        </div>
      </div>
      <div className="card">
        <div className="sub" style={{ marginTop: 0 }}>
          <b style={{ color: 'var(--ink)' }}>Hard boundary:</b> the coach never advises on
          medication — lab trends get "discuss with your GP" framing, always. This is fixed in
          its instructions, not a setting.
        </div>
      </div>
      <Chip>Standing constraints live in Niggles — active ones bind the coach automatically</Chip>
      <button className="lrow press" onClick={async () => {
        await api('/api/prefs', { method: 'PATCH',
          body: { prefs: { onboarded: false, onboarding_step: 3 } } }).catch(() => {});
        location.reload();
      }}>
        <b>Redo intake interview</b>
        <span className="rsub">reset goals with the coach — plans stay until you approve a new one</span>
      </button>
    </Shell>
  );
}

/* ---------------- notifications ---------------- */
const NOTIF_DEFS: [string, string, string][] = [
  ['notif_proposal', 'Proposal ready', 'Sunday evening, when the coach lands'],
  ['notif_reminder', 'Planned-day reminder', '"You planned to train today" — quiet hours respected'],
];

export function NotifScreen() {
  const { me, go } = useApp();
  const [prefs, setPrefs] = useState<Record<string, boolean>>(me.prefs || {});
  const [pushState, setPushState] = useState(
    typeof Notification !== 'undefined' && Notification.permission === 'granted' ? 'on' : 'off');
  const flip = (key: string) => {
    const next = { ...prefs, [key]: prefs[key] === false };
    setPrefs(next);
    api('/api/prefs', { method: 'PATCH', body: { prefs: next } }).catch(() => toast('Offline — not saved'));
  };
  const enable = async () => {
    try {
      const r = await enablePush();
      if (r === 'ok') { setPushState('on'); toast('Push enabled on this device', true); }
      else toast(r);
    } catch (e) { toast(String((e as Error).message)); }
  };
  return (
    <Shell>
      <Back label="Settings" onClick={() => go('settings')} />
      <h2 className="title">Notifications</h2>
      <Chip>Exactly two kinds — the server can't send anything else.</Chip>
      <button className="lrow press" onClick={enable}>
        <b>Push on this device</b>
        <span className="rsub">{pushState === 'on' ? 'enabled — tap to re-subscribe' : 'tap to enable'}</span>
        <span style={{ fontSize: 12, fontWeight: 700,
          color: pushState === 'on' ? 'var(--volt)' : 'var(--dim)' }}>
          {pushState === 'on' ? 'ON' : 'OFF'}
        </span>
      </button>
      {NOTIF_DEFS.map(([key, label, sub]) => (
        <button key={key} className="lrow press" onClick={() => flip(key)}>
          <b>{label}</b><span className="rsub">{sub}</span>
          <span style={{ fontSize: 12, fontWeight: 700,
            color: prefs[key] !== false ? 'var(--volt)' : 'var(--dim)' }}>
            {prefs[key] !== false ? 'ON' : 'OFF'}
          </span>
        </button>
      ))}
    </Shell>
  );
}

/* ---------------- server (admin) ---------------- */
interface AdminSetting { set: boolean; value: string; source: 'app' | 'env' | null }
type AdminSettings = Record<string, AdminSetting>;
interface AdminUser { id: string; email: string; name: string; role: string }

function ServerField({ k, label, secret, placeholder, data, onSave }: {
  k: string; label: string; secret?: boolean; placeholder?: string;
  data: AdminSettings; onSave: (values: Record<string, string>) => Promise<void>;
}) {
  const [v, setV] = useState('');
  const cur = data[k];
  const status = cur?.set
    ? (secret ? `set ${cur.value}` : cur.value) + (cur.source === 'env' ? ' · from env' : '')
    : 'not set';
  return (
    <div className="field">
      <label>{label} <span style={{ textTransform: 'none', letterSpacing: 0 }}>· {status}</span></label>
      <div className="btnrow">
        <input type={secret ? 'password' : 'text'} value={v} autoComplete="off"
          placeholder={placeholder || (cur?.set ? 'replace…' : 'paste here…')}
          onChange={(e) => setV(e.target.value)} />
        <button className="ghost" style={{ padding: '0 18px' }} disabled={!v.trim()}
          onClick={() => onSave({ [k]: v.trim() }).then(() => setV(''))}>Save</button>
      </div>
    </div>
  );
}

function UserCard({ u, onSaved }: { u: AdminUser; onSaved: () => void }) {
  const [name, setName] = useState(u.name);
  const [email, setEmail] = useState(u.email);
  const dirty = name.trim() !== u.name || email.trim().toLowerCase() !== u.email;
  const save = () =>
    api(`/api/admin/users/${u.id}`, { method: 'PATCH', body: { name: name.trim(), email: email.trim() } })
      .then(() => { toast('User saved', true); onSaved(); })
      .catch((e) => toast(e?.message || 'Could not save'));
  return (
    <div className="card">
      <div className="field"><label>Name · {u.role}</label>
        <input value={name} onChange={(e) => setName(e.target.value)} /></div>
      <div className="field" style={{ marginTop: 8 }}><label>Email (sign-in identity)</label>
        <input type="email" value={email} autoCapitalize="none"
          onChange={(e) => setEmail(e.target.value)} /></div>
      {dirty && <button className="cta" style={{ marginTop: 10, width: '100%' }} onClick={save}>Save user</button>}
    </div>
  );
}

export function ServerScreen() {
  const { go } = useApp();
  const qc = useQueryClient();
  const q = useQuery<AdminSettings>({ queryKey: ['admin-settings'], queryFn: () => api('/api/admin/settings') });
  const uq = useQuery<AdminUser[]>({ queryKey: ['admin-users'], queryFn: () => api('/api/admin/users') });
  const hq = useQuery<{ ok: boolean; build?: string }>({ queryKey: ['healthz'], queryFn: () => api('/healthz') });
  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');

  const save = (values: Record<string, string>) =>
    api('/api/admin/settings', { method: 'PUT', body: { values } })
      .then((d) => {
        qc.setQueryData(['admin-settings'], d);
        qc.invalidateQueries({ queryKey: ['connections'] });
        toast('Saved', true);
      })
      .catch((e) => { toast(e?.message || 'Could not save'); throw e; });

  const genVapid = () => {
    if (q.data?.vapid_public_key.set &&
        !confirm('Replace the existing push keys? Everyone must re-enable notifications.')) return;
    api('/api/admin/settings/vapid', { method: 'POST' })
      .then(() => { qc.invalidateQueries({ queryKey: ['admin-settings'] }); toast('Push keys generated', true); })
      .catch((e) => toast(e?.message || 'Failed'));
  };

  const addUser = () =>
    api('/api/admin/users', { method: 'POST', body: { name: newName.trim(), email: newEmail.trim() } })
      .then(() => { setNewName(''); setNewEmail(''); toast('User added', true);
        qc.invalidateQueries({ queryKey: ['admin-users'] }); })
      .catch((e) => toast(e?.message || 'Could not add'));

  if (!q.data || !uq.data) return <Shell><Back label="Settings" onClick={() => go('settings')} /><Loading /></Shell>;
  const vapidSet = q.data.vapid_public_key.set && q.data.vapid_private_key.set;

  return (
    <Shell>
      <Back label="Settings" onClick={() => go('settings')} />
      <Title kick="Admin">Server</Title>

      <div className="card">
        <b style={{ fontSize: 15 }}>Coach</b>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 8 }}>
          <ServerField k="anthropic_api_key" label="Anthropic API key" secret
            placeholder="sk-ant-…" data={q.data} onSave={save} />
          <ServerField k="coach_model" label="Model"
            placeholder={q.data.coach_model.value || 'claude-sonnet-5'} data={q.data} onSave={save} />
        </div>
        <div className="rsub" style={{ marginTop: 8 }}>
          Key from console.anthropic.com. Applies immediately — chat and the Sunday review use it
          on their next run.
        </div>
      </div>

      <div className="card">
        <b style={{ fontSize: 15 }}>Withings</b>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 8 }}>
          <ServerField k="withings_client_id" label="Client ID" data={q.data} onSave={save} />
          <ServerField k="withings_client_secret" label="Client secret" secret data={q.data} onSave={save} />
        </div>
        <div className="rsub" style={{ marginTop: 8 }}>
          From developer.withings.com. Each of you then links your own account under
          Settings → Connections.
        </div>
      </div>

      <div className="card">
        <b style={{ fontSize: 15 }}>Web push</b>
        <div className="rsub" style={{ margin: '6px 0 10px' }}>
          {vapidSet ? `Keys set — public …${q.data.vapid_public_key.value.slice(-8)}`
            : 'No keys yet — generate once, then everyone enables notifications on their phone.'}
        </div>
        <button className={vapidSet ? 'ghost' : 'cta'} style={{ width: '100%' }} onClick={genVapid}>
          {vapidSet ? 'Re-generate keys' : 'Generate keys'}
        </button>
      </div>

      <DemoCard />

      <h3 className="title" style={{ fontSize: 16, margin: '10px 2px 0' }}>Users</h3>
      {uq.data.map((u) => <UserCard key={u.id} u={u}
        onSaved={() => qc.invalidateQueries({ queryKey: ['admin-users'] })} />)}
      {uq.data.length < 2 && (
        <div className="card">
          <b style={{ fontSize: 15 }}>Add the second user</b>
          <div className="field" style={{ marginTop: 8 }}><label>Name</label>
            <input value={newName} onChange={(e) => setNewName(e.target.value)} /></div>
          <div className="field" style={{ marginTop: 8 }}><label>Email</label>
            <input type="email" value={newEmail} autoCapitalize="none"
              onChange={(e) => setNewEmail(e.target.value)} /></div>
          <button className="cta" style={{ marginTop: 10, width: '100%' }}
            disabled={!newName.trim() || !newEmail.trim()} onClick={addUser}>Add user</button>
        </div>
      )}
      <div className="rsub" style={{ padding: '0 2px' }}>
        Google sign-in credentials stay in the server's compose file — they have to exist before
        anyone can log in.
      </div>
      <div className="rsub" style={{ padding: '0 2px' }}>
        Server build {hq.data?.build ?? '…'} · app build {__BUILD_ID__}. If the app build looks
        old after a deploy, fully close and reopen the PWA.
      </div>
    </Shell>
  );
}

function DemoCard() {
  const qc = useQueryClient();
  const q = useQuery<{ exists: boolean }>({ queryKey: ['admin-demo'], queryFn: () => api('/api/admin/demo') });
  const [busy, setBusy] = useState(false);
  const call = (method: 'POST' | 'DELETE', msg: string) => async () => {
    setBusy(true);
    try {
      await api('/api/admin/demo', { method });
      qc.invalidateQueries({ queryKey: ['admin-demo'] });
      toast(msg, true);
    } catch (e: any) { toast(e?.message || 'Failed'); }
    setBusy(false);
  };
  const exists = q.data?.exists;
  return (
    <div className="card">
      <b style={{ fontSize: 15 }}>Demo account</b>
      <div className="rsub" style={{ margin: '6px 0 10px' }}>
        {exists
          ? 'Live — "Try the demo" shows on the sign-in screen. Bruce Willis, a year of history, real coach.'
          : 'Adds a "Try the demo" button to the sign-in screen: Bruce Willis with a year of believable training data. Anyone who can reach this app can open it — demo data only, never yours.'}
      </div>
      {exists ? (
        <div className="btnrow">
          <button className="ghost press" disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await api<{ added: string[] }>('/api/admin/demo/enrich', { method: 'POST' });
                toast(r.added.length ? `Added: ${r.added.join(', ')}` : 'Demo already has everything', true);
              } catch (e: any) { toast(e?.message || 'Failed'); }
              setBusy(false);
            }}>Top up data</button>
          <button className="ghost press" disabled={busy}
            onClick={call('POST', 'Demo data reset')}>Reset data</button>
          <button className="ghost press" disabled={busy} style={{ color: 'var(--warn)' }}
            onClick={() => confirm('Remove the demo account and all its data?')
              && call('DELETE', 'Demo removed')()}>Remove</button>
        </div>
      ) : (
        <button className="cta press" style={{ width: '100%' }} disabled={busy || q.isLoading}
          onClick={call('POST', 'Demo account created')}>{busy ? 'Building a year of data…' : 'Create demo account'}</button>
      )}
    </div>
  );
}
