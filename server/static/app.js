'use strict';
/* Forge PWA — vanilla SPA against the Forge API.
   Design system: Void × Volt. Offline: IndexedDB queue for set logging. */

/* ---------------- utils ---------------- */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const fmtT = s => Math.floor(s/60) + ':' + String(Math.max(0, s%60)).padStart(2, '0');
const todayISO = () => new Date().toISOString().slice(0, 10);

function toast(text, volt){
  const el = document.createElement('div');
  el.className = 'toast' + (volt ? ' volt' : '');
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

/* ---------------- offline queue ---------------- */
const Q = {
  db: null,
  open(){
    return new Promise(res => {
      const req = indexedDB.open('forge', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('queue', { autoIncrement: true });
      req.onsuccess = () => { Q.db = req.result; res(); };
      req.onerror = () => res();
    });
  },
  add(item){
    if (!Q.db) return;
    Q.db.transaction('queue', 'readwrite').objectStore('queue').add(item);
  },
  async flush(){
    if (!Q.db) return;
    const store = Q.db.transaction('queue', 'readonly').objectStore('queue');
    const items = await new Promise(res => {
      const out = [];
      store.openCursor().onsuccess = e => {
        const c = e.target.result;
        if (c){ out.push({ key: c.key, val: c.value }); c.continue(); } else res(out);
      };
    });
    for (const it of items){
      try {
        await api(it.val.path, { method: 'POST', body: it.val.body });
        Q.db.transaction('queue', 'readwrite').objectStore('queue').delete(it.key);
      } catch (e){
        if (e && e.network) return; // still offline — retry later
        Q.db.transaction('queue', 'readwrite').objectStore('queue').delete(it.key); // server rejected: drop
      }
    }
    if (items.length) toast('Synced ' + items.length + ' queued set' + (items.length > 1 ? 's' : ''));
  },
};

/* ---------------- api ---------------- */
async function api(path, opts = {}){
  let resp;
  try {
    resp = await fetch(path, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin',
    });
  } catch (e){
    const err = new Error('network'); err.network = true; throw err;
  }
  if (resp.status === 401 && !path.startsWith('/auth')){ S.user = null; go('auth'); throw new Error('401'); }
  if (!resp.ok){
    let detail = resp.statusText;
    try { detail = (await resp.json()).detail || detail; } catch {}
    const err = new Error(detail); err.status = resp.status; throw err;
  }
  return resp.json();
}

async function queuedPost(path, body){
  try { return await api(path, { method: 'POST', body }); }
  catch (e){
    if (e.network){ Q.add({ path, body }); return { queued: true }; }
    throw e;
  }
}

/* ---------------- client-side fitting helpers (mirror server) ---------------- */
function plateStr(kind, weight, profile){
  if (kind === 'db') return weight ? '2 × ' + weight + ' kg dumbbells' : '';
  if (kind !== 'bb' || !profile || !profile.plates_kg || !profile.plates_kg.length) return '';
  let per = (weight - profile.bar_kg) / 2;
  if (per < 0.01) return 'Empty bar (' + profile.bar_kg + ' kg)';
  const out = [];
  for (const p of [...profile.plates_kg].sort((a, b) => b - a)){
    while (per >= p - 1e-9){ out.push(p); per -= p; }
  }
  let txt = 'Per side: ' + out.join(' + ');
  if (per > 0.01) txt += ' — no plate for ' + per.toFixed(2) + ' kg';
  return txt;
}
function warmupsFor(t, profile){
  if (!profile || t.kind !== 'bb' || (t.priority || 2) !== 1 || (t.weight || 0) < 50) return null;
  const rd = x => Math.round(x / 2.5) * 2.5;
  return [[profile.bar_kg, 10], [rd(t.weight * .5), 8], [rd(t.weight * .7), 5], [rd(t.weight * .85), 3]];
}

/* ---------------- state ---------------- */
const S = {
  user: null, authMode: null, denied: null,
  screen: 'boot', tab: 'today', learnFrom: 'today', learnSlug: null,
  today: null, budget: null, budgetTouched: false,
  log: null, timer: null, lastSummary: null,
  history: null, detail: null, progress: null, lift: null, records: null,
  equipment: null, eqIdx: 0, niggles: null, labs: null, connections: null,
  chat: null, typing: false, library: null, libQ: '', exCache: {}, swapAlts: null,
  revealedToken: null,
};
function stopTimer(){ if (S.timer){ clearInterval(S.timer); S.timer = null; } }

/* ---------------- chrome ---------------- */
const ICONS = {
  today: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 9h16M8 3v4M16 3v4"/>',
  history: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
  progress: '<path d="M4 18l5-6 4 3 7-9"/>',
  coach: '<path d="M5 5h14v10H10l-5 4z"/>',
};
function tabsHTML(){
  return '<nav class="tabs">' + ['today', 'history', 'progress', 'coach'].map(t =>
    `<button class="tab ${S.tab === t ? 'on' : ''}" data-act="tab" data-arg="${t}">
      <svg viewBox="0 0 24 24">${ICONS[t]}</svg>${t[0].toUpperCase() + t.slice(1)}</button>`).join('') + '</nav>';
}
function hdrHTML(){
  const initial = S.user ? esc(S.user.name[0] || '?') : '?';
  return `<div class="hdr"><span class="wm">FORGE<i>.</i></span><span class="sp"></span>
    <button class="avatar press" data-act="go" data-arg="settings" aria-label="Settings">${initial}</button></div>`
    + (navigator.onLine ? '' : '<div class="offline">Offline — sets will queue and sync</div>');
}

/* ---------------- views ---------------- */
function vBoot(){ return '<div class="boot">FORGE<span>.</span></div>'; }

function vAuth(){
  const m = S.authMode || {};
  const google = m.google ? `<a class="gbtn press" href="/auth/login" style="text-decoration:none">
      <svg viewBox="0 0 18 18" width="18" height="18"><path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92a8.78 8.78 0 0 0 2.68-6.62z"/><path fill="#34A853" d="M9 18a8.6 8.6 0 0 0 5.96-2.18l-2.92-2.26a5.4 5.4 0 0 1-8.09-2.85H.96v2.33A9 9 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.95 10.71a5.4 5.4 0 0 1 0-3.42V4.96H.96a9 9 0 0 0 0 8.08l2.99-2.33z"/><path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.59A9 9 0 0 0 .96 4.96l2.99 2.33A5.36 5.36 0 0 1 9 3.58z"/></svg>
      Continue with Google</a>` : '';
  const dev = m.dev ? (m.users || []).map(u =>
    `<button class="acct press" data-act="devLogin" data-arg="${esc(u.email)}">
       <span class="avatar">${esc(u.name[0])}</span>
       <span><b>${esc(u.name)}</b><div class="em">${esc(u.email)}</div></span></button>`).join('') : '';
  return `<div class="authbody">
    <div><div class="wordmark">FORGE<i>.</i></div>
      <div class="tagline">Coached by an agent.<br>Evidence from your own body.</div></div>
    ${google}${dev}
    <div class="fine">Private instance — allowlisted accounts only${m.dev ? '<br>Dev sign-in is enabled (no Google configured)' : ''}</div>
  </div>`;
}
function vDenied(){
  return `<div class="authbody">
    <div><div class="kick">Signed in as ${esc(S.denied)}</div>
      <h2 class="title" style="margin-top:6px">Not on the list</h2></div>
    <div class="card" style="text-align:left"><p style="font-size:13px;line-height:1.5">This Forge is
      private — your Google account verified fine, it just isn't allowed here. Ask the admin to add
      you in the server's ALLOWED_USERS.</p></div>
    <button class="ghost press" data-act="go" data-arg="auth">Back</button>
  </div>`;
}

function budgetDefault(){
  const full = (S.today && S.today.full_est) || 50;
  return Math.min(75, Math.max(25, Math.ceil(full / 5) * 5));
}

function vToday(){
  const t = S.today;
  if (!t) return hdrHTML() + '<div class="scroll"><div class="chip">Loading…</div></div>' + tabsHTML();
  const head = `<div><span class="kick">${esc(t.day_name)} · ${esc(t.name || (t.kind === 'rest' ? 'Rest day' : ''))}</span>
    <h2 class="title">${t.kind === 'rest' ? 'Rest day' : esc(t.name || 'Today')}</h2></div>`;

  if (t.kind === 'rest'){
    const r = t.recovery || {};
    const m = (o, unit, dp) => o ? (dp !== undefined ? o.value.toFixed(dp) : o.value) + ' ' + unit : '—';
    return hdrHTML() + `<div class="scroll">${head}
      <div class="chip"><span class="dot"></span>Recovery is training — a walk is fine if you're restless</div>
      <div class="tiles">
        <div class="tile"><div class="k">Last night</div><div class="v disp num">${r.sleep_h ? r.sleep_h.value.toFixed(1) : '—'}<small> h</small></div><div class="d">sleep · Apple Health</div></div>
        <div class="tile"><div class="k">Weight</div><div class="v disp num">${m(r.weight, 'kg', 1)}</div><div class="d">latest · Withings/HAE</div></div>
        <div class="tile"><div class="k">Resting HR</div><div class="v disp num">${m(r.resting_hr, 'bpm', 0)}</div><div class="d">latest</div></div>
        <div class="tile"><div class="k">Tomorrow</div><div class="v disp" style="font-size:15px;line-height:1.3;margin-top:6px">${t.tomorrow ? esc(t.tomorrow.name) : '—'}</div><div class="d">${t.tomorrow ? esc(t.tomorrow.day_name) : ''}</div></div>
      </div></div>` + tabsHTML();
  }

  if (t.kind === 'cardio'){
    const c = t.cardio || {};
    return hdrHTML() + `<div class="scroll">${head}
      <div class="chip"><span class="dot"></span>${esc(c.note || 'Recorded on your Watch; syncs via Health Auto Export')}</div>
      <div class="card"><div class="row"><span class="xname">Prescribed</span>
        <span class="target num">${c.minutes || '?'} min · HR ${c.hr_low || '?'}–${c.hr_high || '?'}</span></div>
        <div class="sub">Start it from your Watch — it lands in History automatically</div></div>
      <div class="fchips">${(t.focus || []).map(f => `<span class="fchip">${esc(f)}</span>`).join('')}</div>
    </div>` + tabsHTML();
  }

  // strength
  const sess = t.session;
  const done = sess && sess.status === 'completed';
  const active = sess && sess.status === 'active';
  const budget = S.budgetTouched ? S.budget : budgetDefault();
  const pct = ((budget - 25) / 50 * 100).toFixed(0);
  const trims = t.trims && t.trims.length
    ? 'Fits ' + budget + ' min: ' + t.trims.join(' · ') + ' — main lift untouched.'
    : 'Full session fits — nothing trimmed.';
  return hdrHTML() + `<div class="scroll">${head}
    ${done ? `<div class="banner">✓ ${esc(t.name)} complete — ${(sess.stats && sess.stats.tonnage) || 0} t lifted. </div>` : ''}
    ${t.rationale && !done ? `<div class="chip"><span class="dot"></span>${esc(t.rationale)}</div>` : ''}
    ${!done ? `<div class="card">
      <div class="row"><span class="xname">Plan for today</span>
        <span class="target num" id="estT">~${t.est} min · ${t.exercises.reduce((x, e) => x + e.sets, 0)} sets</span></div>
      <div class="sub num">Focus <span class="fchips" style="display:inline-flex;vertical-align:middle;margin:0 2px">${(t.focus || []).map(f => `<span class="fchip">${esc(f)}</span>`).join('')}</span> · ${t.tonnage_est} t · ${t.cd === 'short' ? '2' : '5'}-min cool-down</div>
      <div class="row" style="margin-top:10px"><span class="kick" style="font-size:10px">Time available</span>
        <b class="num" id="budLabel">${budget} min</b></div>
      <input type="range" id="budget" min="25" max="75" step="5" value="${budget}" style="--pct:${pct}%" aria-label="Time available today, minutes">
      <div class="sub ${t.trims && t.trims.length ? 'warn' : ''}" id="budNote">${esc(trims)}</div>
    </div>` : ''}
    ${t.exercises.map(e => `<button class="tap press" data-act="learn" data-arg="${e.slug}" data-from="today">
      <div class="card ${!done && e.dropped ? 'dimrow' : ''}">
        <div class="row"><span class="xname">${esc(e.name)}</span>
          <span class="target num">${done ? '✓ done' : e.dropped ? 'not today' : e.sets + '×' + e.reps + (e.weight ? ' · ' + e.weight + ' kg' : '')}</span></div>
        <div class="sub num">${e.last ? 'Last: ' + e.last.weight + ' kg × ' + e.last.reps.join('/') : 'First time — be conservative'} · <span style="color:var(--volt)">form ▶</span></div>
      </div></button>`).join('')}
    ${done
      ? `<button class="ghost press" data-act="openDetail" data-arg="${sess.id}">Session detail</button>`
      : active
        ? `<button class="cta mt press" data-act="startLog">Resume session</button>`
        : `<button class="cta mt press" data-act="startLog">Start session · ~${t.est} min</button>`}
  </div>` + tabsHTML();
}

function vLearn(){
  const e = S.exCache[S.learnSlug];
  if (!e) return hdrHTML() + '<div class="scroll"><div class="chip">Loading…</div></div>' + tabsHTML();
  const dots = (n) => '●'.repeat(n) + '<i style="color:var(--dim);font-style:normal">' + '○'.repeat(3 - n) + '</i>';
  return hdrHTML() + `<div class="scroll">
    <button class="back press" data-act="learnBack">‹ Back</button>
    <div><span class="kick">Form guide · ${esc(e.media_tier)} tier</span><h2 class="title">${esc(e.name)}</h2></div>
    ${e.media_url ? `<div class="card" style="text-align:center;padding:40px"><a href="${esc(e.media_url)}" target="_blank" style="color:var(--volt)">▶ Watch demo</a></div>`
                  : `<div class="card" style="text-align:center;padding:28px;color:var(--mut);font-size:12px">Demo video not filmed yet — cues below.<br>Media pipeline lands in Phase 5.</div>`}
    <div class="card">${(e.primary_muscles || []).map(mu => `<div class="mrow"><span>${esc(mu)}</span><span style="letter-spacing:2px;color:var(--volt);font-size:10px">${dots(3)}</span></div>`).join('')}
      ${(e.secondary_muscles || []).map(mu => `<div class="mrow"><span>${esc(mu)}</span><span style="letter-spacing:2px;color:var(--volt);font-size:10px">${dots(1)}</span></div>`).join('')}</div>
    <div class="card" style="display:flex;flex-direction:column;gap:7px;font-size:12.5px">
      ${(e.cues || []).map((c, i) => `<div style="display:flex;gap:9px"><b style="color:var(--volt)">${i + 1}</b><span>${esc(c)}</span></div>`).join('')}
      ${e.dont ? `<div style="display:flex;gap:9px;color:var(--mut)"><b style="color:var(--volt-deep)">✕</b><span>${esc(e.dont)}</span></div>` : ''}
    </div>
    ${(e.equipment || []).length ? `<div class="chip"><span class="dot"></span>Needs: ${e.equipment.map(esc).join(' · ')}</div>` : ''}
  </div>` + tabsHTML();
}

function curT(){
  const t = S.log.targets[S.log.idx];
  const sw = S.log.swaps[t.slug];
  return sw ? { ...t, slug: sw.slug, name: sw.name, kind: sw.kind || t.kind, substituted_for: t.slug } : t;
}

function vLog(){
  const st = S.log;
  const t = curT();
  const doneSets = st.done[t.slug] || [];
  const allDone = doneSets.length >= t.sets;
  const lastEx = st.idx === st.targets.length - 1;
  const remSets = st.targets.reduce((x, tt) => {
    const slug = st.swaps[tt.slug] ? st.swaps[tt.slug].slug : tt.slug;
    return x + Math.max(0, tt.sets - (st.done[slug] || []).length);
  }, 0);
  const elapsed = Math.floor((Date.now() - st.t0) / 1000);
  const wu = !st.wu[t.slug] && doneSets.length === 0 ? warmupsFor(st.targets[st.idx], S.today && S.today.profile) : null;
  const plate = plateStr(t.kind, st.w, S.today && S.today.profile);
  return hdrHTML() + `<div class="scroll">
    <div><span class="kick">Exercise ${st.idx + 1} of ${st.targets.length}</span>
      <h2 class="title"><button class="press" data-act="learn" data-arg="${t.slug}" data-from="log">${esc(t.name)} <span style="font-size:13px;color:var(--volt)">▶</span></button></h2></div>
    <div class="chip num"><span class="dot"></span>Target ${t.sets}×${t.reps}${t.weight ? ' · ' + t.weight + ' kg' : ''} · rest ${fmtT(t.rest || 90)} ·
      <span id="elapsed">${fmtT(elapsed)}</span> elapsed · ~${remSets * 2} min left</div>
    <button class="press" style="align-self:flex-start;font-size:11.5px;color:var(--volt);font-weight:600;padding:0 2px"
      data-act="swapOpen">Equipment taken? Swap ↺${st.swaps[st.targets[st.idx].slug] ? ' · substituted' : ''}</button>
    ${wu ? `<div class="card"><div class="kick" style="font-size:9.5px;margin-bottom:6px">Warm-up ramp</div>
      ${wu.map(s => `<div class="row num" style="padding:3px 0"><span class="sub" style="margin:0">${s[0]} kg</span><span class="sub" style="margin:0">× ${s[1]}</span></div>`).join('')}
      <button class="ghost press" style="margin-top:8px;padding:8px" data-act="wuDone">Warm-ups done ✓</button></div>` : ''}
    ${doneSets.map((s, i) => `<div class="setline num"><span class="lbl">Set ${i + 1}</span>
      <span class="v">${t.weight ? s.weight + ' kg × ' : '×'}${s.reps}${s.rpe ? ' · RPE ' + s.rpe : ''}</span><span class="tick">✓</span></div>`).join('')}
    ${!allDone ? `<div class="active-set">
      ${t.weight || t.kind !== 'bw' ? `<div class="stepper"><span class="lab">Set ${doneSets.length + 1} · Weight</span>
        <div class="pm"><button data-act="w" data-arg="-1">−</button><span class="v disp num">${st.w}</span><button data-act="w" data-arg="1">+</button></div></div>
      ${plate ? `<div class="sub num" style="margin:0">${esc(plate)}</div>` : ''}` : ''}
      <div class="stepper"><span class="lab">Reps</span>
        <div class="pm"><button data-act="r" data-arg="-1">−</button><span class="v disp num">${st.r}</span><button data-act="r" data-arg="1">+</button></div></div>
      <div class="rpe">${[6, 7, 8, 9, 10].map(n => `<button class="${st.rpe === n ? 'sel' : ''} num" data-act="rpe" data-arg="${n}">${n}</button>`).join('')}</div>
    </div>` : ''}
    ${st.go && !allDone ? `<div class="banner">Rested — go: set ${doneSets.length + 1}</div>` : ''}
    ${st.remain > 0 ? `<div class="resty"><div style="display:flex;align-items:center;gap:12px">
      <svg width="48" height="48" viewBox="0 0 48 48" aria-hidden="true">
        <circle cx="24" cy="24" r="20" fill="none" stroke="var(--hair)" stroke-width="4"/>
        <circle id="ring" cx="24" cy="24" r="20" fill="none" stroke="var(--volt)" stroke-width="4"
          stroke-linecap="round" stroke-dasharray="125.7" stroke-dashoffset="${(125.7 * (1 - st.remain / (t.rest || 90))).toFixed(1)}" transform="rotate(-90 24 24)"/></svg>
      <div><div class="t disp num" id="rt">${fmtT(st.remain)}</div><div class="cap">Rest · target ${fmtT(t.rest || 90)}</div></div></div>
      <button class="ghost press" style="width:auto;padding:8px 14px" data-act="skipRest">Skip</button></div>` : ''}
    <div style="margin-top:auto;display:flex;flex-direction:column;gap:8px">
    ${!allDone
      ? `<button class="cta press" data-act="logSet">Log set ${doneSets.length + 1}</button>`
      : (lastEx
        ? `<button class="cta press" data-act="go" data-arg="cooldown">Cool-down →</button>`
        : `<button class="cta press" data-act="nextEx">Next: ${esc(st.targets[st.idx + 1].name)}</button>`)}
    </div>
  </div>` + tabsHTML();
}

function vSwap(){
  const st = S.log;
  const orig = st.targets[st.idx];
  const alts = S.swapAlts || [];
  const swapped = st.swaps[orig.slug];
  return hdrHTML() + `<div class="scroll">
    <button class="back press" data-act="go" data-arg="log">‹ Back</button>
    <div><span class="kick">Same muscles · your equipment</span><h2 class="title">Swap ${esc(orig.name)}</h2></div>
    ${swapped ? `<button class="lrow press" data-act="swapBack"><b>↺ Back to ${esc(orig.name)}</b><span class="rsub">original prescription</span></button>` : ''}
    ${alts.map((a, i) => a.excluded
      ? `<div class="lrow dimrow"><b>${esc(a.name)}</b><span class="rsub">${esc(a.why)}</span></div>`
      : `<button class="lrow press" data-act="swapPick" data-arg="${i}">
          <b>${esc(a.name)}${swapped && swapped.slug === a.slug ? ' ✓' : ''}</b>
          <span class="rsub">${esc(a.why)}</span></button>`).join('')}
    ${!alts.length ? '<div class="chip">No suitable alternatives in your current equipment profile.</div>' : ''}
    <div class="chip"><span class="dot"></span>Swaps are logged as substitutions — the coach sees the session still happened, and why</div>
  </div>` + tabsHTML();
}

function vCooldown(){
  const st = S.log;
  const list = (st.fitted.cooldown || []);
  const cdMin = st.fitted.cd === 'short' ? 2 : 5;
  const shown = st.fitted.cd === 'short' ? list.slice(0, 2) : list;
  const ticked = shown.filter((c, i) => st.cdDone[i]).length;
  return hdrHTML() + `<div class="scroll">
    <div><span class="kick">Last stop · ${cdMin} min</span><h2 class="title">Cool-down</h2></div>
    ${shown.some(c => c.why) ? `<div class="chip"><span class="dot"></span>Starred holds target your niggles — don't skip those</div>` : ''}
    ${shown.map((c, i) => `<button class="lrow press" data-act="cdTick" data-arg="${i}">
      <b>${esc(c.name || c.slug)}${c.why ? ' ✳' : ''}</b><span class="rsub">${esc(c.hold || '')}${c.why ? '<br>' + esc(c.why) : ''}</span>
      ${st.cdDone[i] ? '<span class="tick">✓</span>' : '<span class="chev">○</span>'}</button>`).join('')}
    <div class="field" style="margin-top:6px"><label>Note for the coach</label>
      <input id="noteBox" placeholder="Knee felt fine · grip gave out first…"></div>
    <div style="margin-top:auto;display:flex;flex-direction:column;gap:8px">
      <button class="cta press" data-act="finish">Finish session${ticked ? ' · ' + ticked + '/' + shown.length + ' done' : ''}</button>
      <button class="ghost press" data-act="cdSkipFinish">Skip cool-down — coach will know</button>
    </div>
  </div>` + tabsHTML();
}

function vSummary(){
  const L = S.lastSummary;
  if (!L) return hdrHTML() + '<div class="scroll"><div class="chip">No session yet today.</div></div>' + tabsHTML();
  const stats = L.stats || {};
  return hdrHTML() + `<div class="scroll">
    <div><span class="kick">${esc(L.day || todayISO())} · ${esc(L.name)}</span><h2 class="title">Session summary</h2></div>
    ${(L.pbs || []).map(p => `<div class="banner">✓ ${esc(p.slug)} ${p.kind === 'e1rm' ? 'e1RM' : 'best set'} ${p.value} kg — new record</div>`).join('')}
    <div class="tiles">
      <div class="tile"><div class="k">Duration</div><div class="v disp num">${stats.duration_s ? fmtT(stats.duration_s) : '—'}</div><div class="d num">vs ~${L.est || '?'} min planned</div></div>
      <div class="tile"><div class="k">Volume</div><div class="v disp num">${stats.tonnage ?? 0} <small>t</small></div><div class="d">lifted total</div></div>
      <div class="tile"><div class="k">Sets</div><div class="v disp num">${stats.sets_done ?? 0}<small>/${stats.sets_planned ?? 0}</small></div><div class="d">${(stats.sets_done ?? 0) >= (stats.sets_planned ?? 0) ? 'all done' : 'short — noted'}</div></div>
      <div class="tile"><div class="k">Avg RPE</div><div class="v disp num">${stats.avg_rpe ?? '—'}</div><div class="d">effort across sets</div></div>
    </div>
    ${(L.exercises || []).map(g => `<div class="card num"><div class="row">
        <span class="xname">${esc(g.name)}${g.substituted_for ? ' <small style="color:var(--mut)">(sub)</small>' : ''}</span>
        <span class="target">${g.sets.map(s => s.reps).join('/')}${g.sets[0] && g.sets[0].weight ? ' @ ' + g.sets[0].weight + ' kg' : ''}</span></div></div>`).join('')}
    <div class="card"><div class="row"><span class="xname">Cool-down</span>
      <span class="target num">${L.cooldown_status === 'done' ? '✓ done' : esc(L.cooldown_status || '')}</span></div>
      ${L.cooldown_status === 'skipped' ? '<div class="sub warn">Skipped — noted for the review</div>' : ''}</div>
    <button class="cta press" data-act="tab" data-arg="today">Done</button>
  </div>` + tabsHTML();
}

function vHistory(){
  const items = S.history;
  return hdrHTML() + `<div class="scroll">
    <div><span class="kick">All sessions</span><h2 class="title">History</h2></div>
    ${items === null ? '<div class="chip">Loading…</div>' : ''}
    ${items && !items.length ? '<div class="chip">Nothing yet — your first logged session lands here.</div>' : ''}
    ${(items || []).map(h => {
      const s = h.stats || {};
      const head = h.kind === 'cardio'
        ? [s.distance ? (s.distance).toFixed(1) + ' km' : null, s.duration_s ? fmtT(s.duration_s) : null, s.avg_hr ? Math.round(s.avg_hr) + ' bpm' : null].filter(Boolean).join(' · ')
        : [s.tonnage != null ? s.tonnage + ' t' : null, s.sets_done != null ? s.sets_done + ' sets' : null].filter(Boolean).join(' · ');
      return `<button class="lrow press num" data-act="openDetail" data-arg="${h.id}">
        <b>${esc(h.day)} · ${esc(h.name)}</b><span class="rsub">${esc(head || h.status)}</span><span class="chev">›</span></button>`;
    }).join('')}
  </div>` + tabsHTML();
}

function vDetail(){
  const d = S.detail;
  if (!d) return hdrHTML() + '<div class="scroll"><div class="chip">Loading…</div></div>' + tabsHTML();
  const targets = {};
  ((d.fitted || {}).targets || []).forEach(t => targets[t.slug] = t);
  return hdrHTML() + `<div class="scroll">
    <button class="back press" data-act="tab" data-arg="history">‹ History</button>
    <div><span class="kick">${esc(d.day)}${d.kind === 'cardio' ? ' · Watch sync' : ''}</span><h2 class="title">${esc(d.name)}</h2></div>
    ${(d.exercises || []).map(g => {
      const t = targets[g.substituted_for || g.slug];
      return `<div class="card num"><div class="row">
        <span class="xname">${esc(g.name)}${g.substituted_for ? ' <small style="color:var(--mut)">(sub)</small>' : ''}</span>
        <span class="target">${g.sets.map(s => s.reps).join('/')}${g.sets[0] && g.sets[0].weight ? ' @ ' + g.sets[0].weight + ' kg' : ''}</span></div>
        ${t ? `<div class="sub">Plan ${t.sets}×${t.reps}${t.weight ? ' @ ' + t.weight + ' kg' : ''}</div>` : ''}</div>`;
    }).join('')}
    ${d.kind === 'cardio' ? `<div class="tiles">${Object.entries(d.stats || {}).map(([k, v]) =>
      `<div class="tile"><div class="k">${esc(k.replace('_', ' '))}</div><div class="v disp num" style="font-size:19px">${k === 'duration_s' ? fmtT(v) : (typeof v === 'number' ? +v.toFixed(1) : esc(String(v)))}</div></div>`).join('')}</div>` : ''}
    ${d.notes ? `<div class="card"><div class="sub" style="margin-top:0"><b style="color:var(--ink)">Note:</b> ${esc(d.notes)}</div></div>` : ''}
    ${d.cooldown_status ? `<div class="chip"><span class="dot"></span>Cool-down: ${esc(d.cooldown_status)}</div>` : ''}
  </div>` + tabsHTML();
}

function lineSVG(points, w = 340, h = 130){
  if (!points || points.length < 2) return '<div class="sub">Not enough data yet — keep logging.</div>';
  const vals = points.map(p => p.v);
  const min = Math.min(...vals) - 1, max = Math.max(...vals) + 1;
  const X = i => 10 + i * (w - 20) / (points.length - 1);
  const Y = v => (h - 18) - ((v - min) / (max - min)) * (h - 38);
  const pts = points.map((p, i) => X(i).toFixed(1) + ',' + Y(p.v).toFixed(1)).join(' ');
  const lx = X(points.length - 1), ly = Y(vals[vals.length - 1]);
  return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;display:block">
    <g stroke="var(--hair)" stroke-width="1"><line x1="10" y1="${Y(max - 1)}" x2="${w - 10}" y2="${Y(max - 1)}"/><line x1="10" y1="${Y(min + 1)}" x2="${w - 10}" y2="${Y(min + 1)}"/></g>
    <g fill="var(--dim)" font-size="9"><text x="${w - 10}" y="${Y(max - 1) - 4}" text-anchor="end">${(max - 1).toFixed(0)}</text><text x="${w - 10}" y="${Y(min + 1) + 11}" text-anchor="end">${(min + 1).toFixed(0)}</text></g>
    <polyline fill="none" stroke="var(--volt)" stroke-width="2" stroke-linejoin="round" points="${pts}"/>
    <circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="4" fill="var(--volt)" stroke="var(--raised)" stroke-width="2"/></svg>`;
}

function vProgress(){
  const p = S.progress;
  if (!p) return hdrHTML() + '<div class="scroll"><div class="chip">Loading…</div></div>' + tabsHTML();
  const slugs = Object.keys(p.e1rm || {});
  if (!S.lift || !slugs.includes(S.lift)) S.lift = slugs.includes('back-squat') ? 'back-squat' : slugs[0];
  const cur = S.lift ? p.e1rm[S.lift] : null;
  const wLast = p.weight && p.weight.length ? p.weight[p.weight.length - 1].v : null;
  const vLast = p.vo2max && p.vo2max.length ? p.vo2max[p.vo2max.length - 1].v : null;
  return hdrHTML() + `<div class="scroll">
    <div><span class="kick">Trends</span><h2 class="title">Progress</h2></div>
    ${slugs.length ? `<div class="seg">${slugs.slice(0, 3).map(s => `<button class="${S.lift === s ? 'sel' : ''}" data-act="lift" data-arg="${s}">${esc((p.e1rm[s].name || s).split(' ')[0])}</button>`).join('')}</div>
    <div class="card">
      <div class="row"><span style="font-size:12.5px;font-weight:600">${esc(cur.name)} · est. 1RM</span>
        <span style="font-size:10.5px;color:var(--mut)">kg</span></div>
      ${cur.points.length ? `<div style="display:flex;align-items:baseline;gap:8px;margin:2px 0 4px">
        <span class="disp num" style="font-size:22px">${cur.points[cur.points.length - 1].v.toFixed(1)}</span></div>` : ''}
      ${lineSVG(cur.points)}
    </div>` : '<div class="chip">Log strength sessions to build the e1RM trend.</div>'}
    <button class="lrow press num" data-act="go" data-arg="records"><b>Records</b><span class="rsub">all-time bests per lift</span><span class="chev">›</span></button>
    <div class="tiles">
      <div class="tile"><div class="k">Bodyweight</div><div class="v disp num">${wLast != null ? wLast.toFixed(1) : '—'} <small>kg</small></div><div class="d">${p.weight.length} readings</div></div>
      <div class="tile"><div class="k">Sessions</div><div class="v disp num">${p.week.done}<small>/${p.week.planned}</small></div><div class="d">this week</div></div>
      <div class="tile"><div class="k">VO₂max</div><div class="v disp num">${vLast != null ? vLast.toFixed(1) : '—'}</div><div class="d">${vLast != null ? 'Watch estimate' : 'waiting for Watch data'}</div></div>
      <div class="tile"><div class="k">Resting HR</div><div class="v disp num">${p.resting_hr.length ? Math.round(p.resting_hr[p.resting_hr.length - 1].v) : '—'} <small>bpm</small></div><div class="d">latest</div></div>
    </div>
  </div>` + tabsHTML();
}

function vRecords(){
  const rows = S.records || [];
  const bySlug = {};
  rows.forEach(r => (bySlug[r.slug] = bySlug[r.slug] || { name: r.name })[r.kind] = r);
  return hdrHTML() + `<div class="scroll">
    <button class="back press" data-act="tab" data-arg="progress">‹ Progress</button>
    <div><span class="kick">All-time bests</span><h2 class="title">Records</h2></div>
    ${!rows.length ? '<div class="chip">No records yet — they appear as you log sets.</div>' : ''}
    ${Object.values(bySlug).map(g => `<div class="lrow num"><b>${esc(g.name)}</b>
      <span class="rsub">${g.e1rm ? '<span style="color:var(--ink);font-size:13px">' + g.e1rm.value.toFixed(1) + ' kg e1RM</span> · ' + esc(g.e1rm.achieved_on) : ''}${g.best_set ? '<br>best set ' + esc(g.best_set.detail) : ''}</span></div>`).join('')}
    <div class="chip"><span class="dot"></span>Computed from logged sets — a PB is celebrated once, in the session summary</div>
  </div>` + tabsHTML();
}

function vCoach(){
  const msgs = S.chat || [];
  return hdrHTML() + `<div class="scroll" id="chatScroll">
    <div><span class="kick">Chat · coach agent lands in Phase 3</span><h2 class="title">Coach</h2></div>
    ${msgs.map(m => `<div class="bub ${m.who === 'me' ? 'me' : ''} num">${esc(m.text)}</div>`).join('')}
    ${S.typing ? '<div class="bub">· · ·</div>' : ''}
  </div>
  <div class="chatin"><input id="chatBox" placeholder="Message your coach…" autocomplete="off">
    <button class="press" data-act="send">Send</button></div>` + tabsHTML();
}

function vSettings(){
  const conn = S.connections;
  const nig = S.niggles || [];
  const activeN = nig.filter(n => n.status === 'active').length;
  return hdrHTML() + `<div class="scroll">
    <button class="back press" data-act="tab" data-arg="${S.tab}">‹ Close</button>
    <h2 class="title">Settings</h2>
    <div style="display:flex;align-items:center;gap:12px;padding:2px 2px 4px">
      <span class="avatar" style="width:42px;height:42px;font-size:17px">${esc(S.user.name[0])}</span>
      <span><b style="font-size:14.5px">${esc(S.user.name)}</b>
        <div style="font-size:11px;color:var(--mut)">${esc(S.user.email)} · ${esc(S.user.units)}</div></span>
      ${S.user.role === 'admin' ? '<span style="margin-left:auto;font-size:9px;padding:2px 8px;border-radius:999px;border:1px solid var(--hair);color:var(--volt);font-weight:700">ADMIN</span>' : ''}</div>
    <button class="lrow press" data-act="go" data-arg="set-conn"><b>Connections</b>
      <span class="rsub">${conn ? (conn.apple_health.last_push ? 'Apple Health ✓' : 'Apple Health — not seen yet') : '…'}</span><span class="chev">›</span></button>
    <button class="lrow press" data-act="go" data-arg="set-equip"><b>Equipment</b><span class="rsub">profiles &amp; plates</span><span class="chev">›</span></button>
    <button class="lrow press" data-act="go" data-arg="set-niggles"><b>Niggles</b><span class="rsub">${activeN} active</span><span class="chev">›</span></button>
    <button class="lrow press" data-act="go" data-arg="set-labs"><b>Labs</b><span class="rsub">lipid panels</span><span class="chev">›</span></button>
    <button class="lrow press" data-act="go" data-arg="library"><b>Exercise library</b><span class="rsub">browse all</span><span class="chev">›</span></button>
    <button class="lrow press" data-act="go" data-arg="set-notif"><b>Notifications</b><span class="rsub">three kinds, no more</span><span class="chev">›</span></button>
    <button class="lrow press" data-act="export"><b>Export my data</b><span class="rsub">JSON download</span></button>
    <button class="lrow press" data-act="logout"><b style="color:var(--volt-deep)">Sign out</b></button>
  </div>` + tabsHTML();
}

function vConn(){
  const c = S.connections;
  if (!c) return hdrHTML() + '<div class="scroll"><div class="chip">Loading…</div></div>' + tabsHTML();
  const ah = c.apple_health;
  return hdrHTML() + `<div class="scroll">
    <button class="back press" data-act="go" data-arg="settings">‹ Settings</button>
    <h2 class="title">Connections</h2>
    <div class="card"><div class="row"><span class="xname">Apple Health</span>
      <span class="${ah.last_push ? 'up' : 'warn'}" style="font-size:11px">● ${ah.last_push ? 'Live' : 'Waiting for first push'}</span></div>
      <div class="sub">${ah.last_push ? 'Last push ' + new Date(ah.last_push).toLocaleString() + ' · ' + ah.samples + ' samples' : 'Point Health Auto Export at this server'}</div>
      <div class="sub num" style="font-family:ui-monospace,Menlo,monospace;background:var(--sunken);border-radius:8px;padding:6px 9px;margin-top:6px">
        ${S.revealedToken ? esc(S.revealedToken) : esc(ah.token_masked || '—')}
        <button class="press" style="color:var(--volt);font-weight:700;float:right" data-act="${S.revealedToken ? 'copyToken' : 'rotateToken'}">${S.revealedToken ? 'COPY' : 'ROTATE'}</button></div>
      <div class="sub">Health Auto Export → Automations → REST API → URL <b style="color:var(--ink)">${location.origin}/ingest</b>, add header <b style="color:var(--ink)">Authorization: Bearer &lt;token&gt;</b>. Rotating kills the old token instantly.</div></div>
    <div class="card"><div class="row"><span class="xname">Withings</span><span class="sub" style="margin:0">${esc(c.withings.note)}</span></div>
      <div class="sub">Direct OAuth link arrives in Phase 4 — weight already flows via Apple Health if Withings syncs there.</div></div>
    <div class="card"><div class="row"><span class="xname">Coach access · MCP</span><span class="sub" style="margin:0">${esc(c.coach_mcp.note)}</span></div></div>
  </div>` + tabsHTML();
}

function vEquip(){
  const eq = S.equipment;
  if (!eq) return hdrHTML() + '<div class="scroll"><div class="chip">Loading…</div></div>' + tabsHTML();
  const prof = eq.profiles[S.eqIdx] || eq.profiles[0];
  return hdrHTML() + `<div class="scroll">
    <button class="back press" data-act="go" data-arg="settings">‹ Settings</button>
    <h2 class="title">Equipment</h2>
    <div class="seg">${eq.profiles.map((p, i) => `<button class="${i === S.eqIdx ? 'sel' : ''}" data-act="eqProfile" data-arg="${i}">${esc(p.name)}${p.shared ? ' ⌂' : ''}</button>`).join('')}</div>
    <div class="chip"><span class="dot"></span>${prof.id === eq.active_id ? 'Active profile — plans are constrained to this list' : 'Tap "make active" to plan against this profile'}</div>
    ${prof.id !== eq.active_id ? `<button class="ghost press" data-act="eqActivate" data-arg="${prof.id}">Make active</button>` : ''}
    ${(prof.items || []).map((it, i) => `<button class="lrow press ${it.available ? '' : 'dimrow'}" data-act="eqToggle" data-arg="${i}">
      <b>${esc(it.name)}</b><span class="rsub">${it.available ? '✓ available' : '✕ not here'}</span></button>`).join('')}
    ${prof.plates_kg && prof.plates_kg.length ? `<div class="chip num"><span class="dot"></span>Bar ${prof.bar_kg} kg · plates per side: ${prof.plates_kg.join(', ')}</div>` : ''}
  </div>` + tabsHTML();
}

function vNiggles(){
  const rows = S.niggles;
  if (!rows) return hdrHTML() + '<div class="scroll"><div class="chip">Loading…</div></div>' + tabsHTML();
  const pill = s => `<span class="fchip ${s === 'active' ? '' : 'dim'}">${s.toUpperCase()}</span>`;
  return hdrHTML() + `<div class="scroll">
    <button class="back press" data-act="go" data-arg="settings">‹ Settings</button>
    <h2 class="title">Niggles</h2>
    ${rows.map(n => `<div class="lrow ${n.status === 'cleared' ? 'dimrow' : ''}"><b>${esc(n.body_part)}</b>
      <span class="rsub">${esc(n.note)}<br>
        ${n.status !== 'cleared' ? `<button class="press" style="color:var(--volt);font-weight:700" data-act="niggleStatus" data-arg="${n.id}:cleared">mark cleared</button>` : 'cleared ' + esc(n.cleared_at || '')}</span>
      ${pill(n.status)}</div>`).join('')}
    <div class="card"><div class="kick" style="font-size:10px;margin-bottom:8px">Log a niggle</div>
      <div class="field"><label>Body part</label><input id="nigPart" placeholder="Left knee"></div>
      <div class="field" style="margin-top:8px"><label>Note</label><input id="nigNote" placeholder="Grumbles in deep lunges"></div>
      <button class="ghost press" style="margin-top:10px" data-act="niggleAdd">Add</button></div>
    <div class="chip"><span class="dot"></span>Active niggles constrain swaps and (from Phase 3) plan proposals</div>
  </div>` + tabsHTML();
}

function vLabs(){
  const panels = S.labs;
  if (!panels) return hdrHTML() + '<div class="scroll"><div class="chip">Loading…</div></div>' + tabsHTML();
  return hdrHTML() + `<div class="scroll">
    <button class="back press" data-act="go" data-arg="settings">‹ Settings</button>
    <h2 class="title">Labs</h2>
    ${!panels.length ? '<div class="chip">No panels yet — add your latest lipid results below.</div>' : ''}
    ${panels.map(p => `<div class="card num"><div class="kick" style="font-size:10px;margin-bottom:6px">${esc(p.drawn_on)}</div>
      ${p.results.map(r => `<div class="row" style="padding:2px 0"><span class="sub" style="margin:0">${esc(r.marker)}</span>
        <span class="sub" style="margin:0;color:var(--ink)">${r.value} ${esc(r.unit)}
        ${r.ref_high != null && r.value <= r.ref_high && (r.ref_low == null || r.value >= r.ref_low) ? '<span class="up">· in range</span>' : ''}</span></div>`).join('')}</div>`).join('')}
    <div class="card"><div class="kick" style="font-size:10px;margin-bottom:8px">Add lipid panel</div>
      <div class="field"><label>Drawn on</label><input id="labDate" placeholder="${todayISO()}" value="${todayISO()}"></div>
      <div class="tiles" style="margin-top:8px">
        ${['LDL', 'HDL', 'Triglycerides', 'Total'].map(m => `<div class="field"><label>${m} mmol/L</label><input id="lab${m}" inputmode="decimal" placeholder="—"></div>`).join('')}
      </div>
      <button class="ghost press" style="margin-top:10px" data-act="labAdd">Save panel</button></div>
  </div>` + tabsHTML();
}

function vLibrary(){
  const rows = S.library;
  return hdrHTML() + `<div class="scroll">
    <button class="back press" data-act="go" data-arg="settings">‹ Settings</button>
    <h2 class="title">Exercise library</h2>
    <div class="field"><input id="libSearch" placeholder="Search…" value="${esc(S.libQ)}"></div>
    ${rows === null ? '<div class="chip">Loading…</div>' : ''}
    ${(rows || []).filter(e => !S.libQ || e.name.toLowerCase().includes(S.libQ.toLowerCase())).map(e =>
      `<button class="lrow press" data-act="learn" data-arg="${e.slug}" data-from="library">
        <b>${esc(e.name)}</b><span class="rsub">${(e.primary_muscles || []).join(' · ')}</span>
        <span class="fchip dim">${esc(e.media_tier.toUpperCase())}</span></button>`).join('')}
  </div>` + tabsHTML();
}

function vNotif(){
  const p = (S.user && S.user.prefs) || {};
  const defs = [['notif_proposal', 'Proposal ready', 'Sunday evening, when the coach lands (Phase 3)'],
                ['notif_reminder', 'Planned-day reminder', '"You planned to train today"'],
                ['notif_film', 'Filming requests', 'When the coach wants footage (Phase 5)']];
  return hdrHTML() + `<div class="scroll">
    <button class="back press" data-act="go" data-arg="settings">‹ Settings</button>
    <h2 class="title">Notifications</h2>
    <div class="chip"><span class="dot"></span>Exactly three kinds — the server can't send anything else. Push delivery wires up in Phase 3–5; toggles apply now.</div>
    ${defs.map(d => `<button class="lrow press" data-act="notif" data-arg="${d[0]}">
      <b>${d[1]}</b><span class="rsub">${d[2]}</span>
      <span style="font-size:11px;font-weight:700;color:${p[d[0]] !== false ? 'var(--volt)' : 'var(--dim)'}">${p[d[0]] !== false ? 'ON' : 'OFF'}</span></button>`).join('')}
  </div>` + tabsHTML();
}

/* ---------------- render & routing ---------------- */
const VIEWS = { boot: vBoot, auth: vAuth, denied: vDenied, today: vToday, learn: vLearn, log: vLog,
  swap: vSwap, cooldown: vCooldown, summary: vSummary, history: vHistory, detail: vDetail,
  progress: vProgress, records: vRecords, coach: vCoach, settings: vSettings,
  'set-conn': vConn, 'set-equip': vEquip, 'set-niggles': vNiggles, 'set-labs': vLabs,
  library: vLibrary, 'set-notif': vNotif };

function render(){
  $('#app').innerHTML = VIEWS[S.screen]();
  if (S.screen === 'coach'){ const sc = $('#chatScroll'); if (sc) sc.scrollTop = sc.scrollHeight; }
}
function go(screen){ if (screen !== 'log') stopTimer(); S.screen = screen; render(); }

/* screen data loaders */
async function openTab(tab){
  S.tab = tab;
  if (tab === 'today'){ go('today'); fetchToday(); }
  else if (tab === 'history'){ S.history = null; go('history'); S.history = await api('/api/history'); render(); }
  else if (tab === 'progress'){ S.progress = null; go('progress'); S.progress = await api('/api/progress'); render(); }
  else if (tab === 'coach'){ go('coach'); if (!S.chat){ S.chat = await api('/api/chat'); render(); } }
}

let budgetTimer = null;
async function fetchToday(){
  const q = S.budgetTouched ? '?budget=' + S.budget : '';
  try { S.today = await api('/api/today' + q); } catch (e){ if (!e.network) throw e; }
  if (S.screen === 'today') render();
}

/* ---------------- session flow ---------------- */
async function startLog(){
  const body = { budget: S.budgetTouched ? S.budget : null };
  let res;
  try { res = await api('/api/sessions', { method: 'POST', body }); }
  catch (e){ toast(e.network ? 'Need a connection to start a session' : e.message); return; }
  const targets = (res.fitted.targets || []).filter(t => t.sets > 0);
  const exmap = {};
  (S.today.exercises || []).forEach(e => exmap[e.slug] = e);
  targets.forEach(t => { t.name = (exmap[t.slug] || {}).name || t.slug; t.kind = (exmap[t.slug] || {}).kind || 'bb'; });
  S.log = { sid: res.id, fitted: res.fitted, targets, idx: 0, done: {}, swaps: {}, wu: {}, cdDone: {},
            w: targets[0].weight || 0, r: targets[0].reps, rpe: null, remain: 0, go: false,
            t0: Date.now(), pbs: [] };
  if (res.resumed){
    try {
      const detail = await api('/api/sessions/' + res.id);
      (detail.exercises || []).forEach(g => {
        S.log.done[g.slug] = g.sets.map(s => ({ weight: s.weight, reps: s.reps, rpe: s.rpe }));
        if (g.substituted_for) S.log.swaps[g.substituted_for] = { slug: g.slug, name: g.name };
      });
      while (S.log.idx < targets.length - 1 &&
             (S.log.done[curT().slug] || []).length >= targets[S.log.idx].sets){ S.log.idx++; }
      const t = curT(); S.log.w = t.weight || 0; S.log.r = t.reps;
    } catch {}
  }
  go('log');
}

function startRest(){
  stopTimer();
  const t = curT();
  S.log.remain = t.rest || 90; S.log.go = false;
  S.timer = setInterval(() => {
    if (!S.log){ stopTimer(); return; }
    S.log.remain--;
    const el = $('#elapsed');
    if (el) el.textContent = fmtT(Math.floor((Date.now() - S.log.t0) / 1000));
    if (S.log.remain <= 0){ stopTimer(); S.log.remain = 0; S.log.go = true; if (S.screen === 'log') render(); return; }
    const rt = $('#rt'); if (rt) rt.textContent = fmtT(S.log.remain);
    const ring = $('#ring');
    if (ring) ring.setAttribute('stroke-dashoffset', (125.7 * (1 - S.log.remain / (t.rest || 90))).toFixed(1));
  }, 1000);
}

async function logSet(){
  const st = S.log; const t = curT();
  const arr = st.done[t.slug] = st.done[t.slug] || [];
  const set = { weight: st.w, reps: st.r, rpe: st.rpe };
  arr.push(set);
  st.rpe = null; st.go = false;
  const res = await queuedPost('/api/sessions/' + st.sid + '/sets', {
    slug: t.slug, substituted_for: t.substituted_for || null,
    set_no: arr.length, weight: set.weight, reps: set.reps, rpe: set.rpe });
  if (res && res.pbs && res.pbs.length){
    st.pbs.push(...res.pbs);
    toast('New record — ' + res.pbs[0].kind.replace('_', ' ') + ' ' + res.pbs[0].value + ' kg', true);
  }
  if (arr.length < t.sets) startRest(); else { stopTimer(); st.remain = 0; }
  render();
}

async function finishSession(skipCd){
  const st = S.log;
  stopTimer();
  const shown = st.fitted.cd === 'short' ? (st.fitted.cooldown || []).slice(0, 2) : (st.fitted.cooldown || []);
  const ticked = shown.filter((c, i) => st.cdDone[i]).length;
  const status = skipCd ? 'skipped' : ticked >= shown.length && shown.length ? 'done' : ticked > 0 ? 'partial' : 'skipped';
  const note = ($('#noteBox') && $('#noteBox').value) || '';
  let res = null;
  try {
    res = await api('/api/sessions/' + st.sid + '/complete', { method: 'POST',
      body: { cooldown_status: status, cooldown_min: st.fitted.cd === 'short' ? 2 : 5, notes: note } });
  } catch (e){ toast(e.network ? 'Offline — finish again when connected' : e.message); if (e.network) return; }
  let detail = null;
  try { detail = await api('/api/sessions/' + st.sid); } catch {}
  S.lastSummary = { name: st.fitted.name, day: todayISO(), est: st.fitted.est, pbs: st.pbs,
                    stats: (res && res.stats) || {}, cooldown_status: status,
                    exercises: (detail && detail.exercises) || [] };
  S.log = null;
  fetchToday();
  go('summary');
}

/* ---------------- events ---------------- */
document.addEventListener('click', async ev => {
  const b = ev.target.closest('[data-act]');
  if (!b) return;
  const act = b.dataset.act, arg = b.dataset.arg;
  try {
    switch (act){
      case 'go':
        if (arg === 'settings' && !S.connections) api('/api/connections').then(c => { S.connections = c; render(); });
        if (arg === 'settings' && !S.niggles) api('/api/niggles').then(n => { S.niggles = n; render(); });
        if (arg === 'set-equip' && !S.equipment) api('/api/equipment').then(e => { S.equipment = e; render(); });
        if (arg === 'set-labs' && !S.labs) api('/api/labs').then(l => { S.labs = l; render(); });
        if (arg === 'library' && !S.library) api('/api/exercises').then(l => { S.library = l; render(); });
        if (arg === 'records' && !S.records) api('/api/records').then(r => { S.records = r; render(); });
        go(arg); break;
      case 'tab': openTab(arg); break;
      case 'devLogin':
        await api('/auth/dev', { method: 'POST', body: { email: arg } });
        S.user = await api('/auth/me'); openTab('today'); break;
      case 'logout': await api('/auth/logout', { method: 'POST' }); location.reload(); break;
      case 'learn': {
        S.learnSlug = arg; S.learnFrom = b.dataset.from || 'today';
        if (!S.exCache[arg]) api('/api/exercises/' + arg).then(e => { S.exCache[arg] = e; render(); });
        go('learn'); break; }
      case 'learnBack': go(S.learnFrom === 'log' ? 'log' : S.learnFrom === 'library' ? 'library' : 'today'); break;
      case 'startLog': startLog(); break;
      case 'w': { const t = curT(); const step = t.kind === 'db' ? 2 : 2.5;
        S.log.w = Math.max(0, +(S.log.w + (+arg) * step).toFixed(1)); render(); break; }
      case 'r': S.log.r = Math.max(1, S.log.r + +arg); render(); break;
      case 'rpe': S.log.rpe = +arg; render(); break;
      case 'wuDone': S.log.wu[curT().slug] = true; render(); break;
      case 'logSet': logSet(); break;
      case 'skipRest': stopTimer(); S.log.remain = 0; S.log.go = true; render(); break;
      case 'nextEx': { stopTimer(); S.log.go = false; S.log.idx++;
        const t = curT(); S.log.w = t.weight || 0; S.log.r = t.reps; S.log.remain = 0; render(); break; }
      case 'swapOpen': {
        S.swapAlts = null; go('swap');
        api('/api/exercises/' + S.log.targets[S.log.idx].slug + '/alternatives')
          .then(a => { S.swapAlts = a; render(); }); break; }
      case 'swapPick': {
        const a = S.swapAlts[+arg];
        if (!a || a.excluded) break;
        const orig = S.log.targets[S.log.idx];
        S.log.swaps[orig.slug] = { slug: a.slug, name: a.name, kind: a.kind };
        S.log.w = orig.weight || 0; S.log.r = orig.reps; go('log'); break; }
      case 'swapBack': { const orig = S.log.targets[S.log.idx]; delete S.log.swaps[orig.slug];
        S.log.w = orig.weight || 0; S.log.r = orig.reps; go('log'); break; }
      case 'cdTick': S.log.cdDone[+arg] = !S.log.cdDone[+arg]; render(); break;
      case 'cdSkipFinish': finishSession(true); break;
      case 'finish': finishSession(false); break;
      case 'openDetail': S.detail = null; S.tab = 'history'; go('detail');
        S.detail = await api('/api/sessions/' + arg); render(); break;
      case 'lift': S.lift = arg; render(); break;
      case 'send': sendChat(); break;
      case 'rotateToken': {
        const r = await api('/api/connections/rotate-token', { method: 'POST' });
        S.revealedToken = r.token; S.connections = await api('/api/connections'); render();
        toast('New token — copy it into Health Auto Export'); break; }
      case 'copyToken':
        try { await navigator.clipboard.writeText(S.revealedToken); toast('Copied'); } catch { toast('Copy failed — long-press to select'); }
        break;
      case 'eqProfile': S.eqIdx = +arg; render(); break;
      case 'eqActivate': await api('/api/equipment/active', { method: 'POST', body: { profile_id: arg } });
        S.equipment = await api('/api/equipment'); S.today = null; fetchToday(); render(); break;
      case 'eqToggle': {
        const prof = S.equipment.profiles[S.eqIdx];
        prof.items[+arg].available = !prof.items[+arg].available;
        render();
        api('/api/equipment/' + prof.id, { method: 'PATCH', body: { items: prof.items } }); break; }
      case 'niggleStatus': {
        const [id, status] = arg.split(':');
        await api('/api/niggles/' + id, { method: 'PATCH', body: { status } });
        S.niggles = await api('/api/niggles'); render(); break; }
      case 'niggleAdd': {
        const part = $('#nigPart').value.trim();
        if (!part){ toast('Body part needed'); break; }
        await api('/api/niggles', { method: 'POST', body: { body_part: part, note: $('#nigNote').value.trim() } });
        S.niggles = await api('/api/niggles'); render(); break; }
      case 'labAdd': {
        const refs = { LDL: [null, 3.0], HDL: [1.0, null], Triglycerides: [null, 1.7], Total: [null, 5.0] };
        const results = [];
        for (const m of ['LDL', 'HDL', 'Triglycerides', 'Total']){
          const v = parseFloat($('#lab' + m).value);
          if (!isNaN(v)) results.push({ marker: m, value: v, ref_low: refs[m][0], ref_high: refs[m][1] });
        }
        if (!results.length){ toast('Enter at least one value'); break; }
        await api('/api/labs', { method: 'POST', body: { drawn_on: $('#labDate').value || todayISO(), results } });
        S.labs = await api('/api/labs'); render(); toast('Panel saved'); break; }
      case 'notif': {
        const p = { ...(S.user.prefs || {}) };
        p[arg] = p[arg] === false;
        S.user.prefs = p; render();
        api('/api/prefs', { method: 'PATCH', body: { prefs: p } }); break; }
      case 'export': {
        const data = await api('/api/export');
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob); a.download = 'forge-export.json'; a.click(); break; }
    }
  } catch (e){
    if (e.message !== '401') toast(e.network ? 'Offline — try again when connected' : ('Error: ' + e.message));
  }
});

document.addEventListener('input', ev => {
  if (ev.target.id === 'budget'){
    S.budget = +ev.target.value; S.budgetTouched = true;
    const el = $('#budLabel'); if (el) el.textContent = S.budget + ' min';
    ev.target.style.setProperty('--pct', ((S.budget - 25) / 50 * 100) + '%');
    clearTimeout(budgetTimer);
    budgetTimer = setTimeout(fetchToday, 250);
  }
  if (ev.target.id === 'libSearch'){ S.libQ = ev.target.value; render();
    const inp = $('#libSearch'); inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
});
document.addEventListener('keydown', ev => {
  if (ev.key === 'Enter' && ev.target.id === 'chatBox') sendChat();
});

async function sendChat(){
  const i = $('#chatBox');
  if (!i || !i.value.trim()) return;
  const text = i.value.trim();
  S.chat.push({ who: 'me', text }); S.typing = true; render();
  try {
    const r = await api('/api/chat', { method: 'POST', body: { text } });
    S.typing = false; S.chat.push({ who: 'coach', text: r.reply });
  } catch (e){
    S.typing = false; S.chat.push({ who: 'coach', text: '(offline — message will need resending)' });
  }
  render();
}

/* ---------------- boot ---------------- */
window.addEventListener('online', () => { Q.flush(); render(); });
window.addEventListener('offline', () => render());

(async function init(){
  if ('serviceWorker' in navigator){ navigator.serviceWorker.register('/sw.js').catch(() => {}); }
  await Q.open();
  Q.flush();
  const denied = new URLSearchParams(location.search).get('denied');
  if (denied){ S.denied = denied; history.replaceState({}, '', '/'); go('denied'); return; }
  try {
    S.user = await api('/auth/me');
    openTab('today');
  } catch {
    try { S.authMode = await api('/auth/mode'); } catch {}
    go('auth');
  }
})();
