// Forge visual driver: launches headless Chrome against a running Forge
// server, walks the PWA as the demo user, and screenshots every major screen.
// Doubles as a visual smoke: exits 1 on any page JS error.
//
//   node driver.mjs [flows] [--base http://localhost:8600] [--out /tmp/forge-shots]
//   flows: app | welcome | light | all (default)
//
// Needs puppeteer-core installed next to this file (see SKILL.md) and a demo
// account already created (POST /api/admin/demo as the admin — see SKILL.md).
import { createRequire } from 'module';
import fs from 'fs';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const BASE = opt('--base', 'http://localhost:8600');
const OUT = opt('--out', '/tmp/forge-shots');
const flows = args.filter((a) => !a.startsWith('--') && a !== opt('--base', '') && a !== opt('--out', ''));
const want = (f) => flows.length === 0 || flows.includes('all') || flows.includes(f);
fs.mkdirSync(OUT, { recursive: true });

const CHROME = process.env.CHROME_BIN
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new',
  args: process.env.CHROME_NO_SANDBOX ? ['--no-sandbox'] : [],
});
const page = await browser.newPage();
const problems = [];
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
// signed-out boot probes /auth/me and gets a 401 by design — not a finding
const expectedUrl = (u) => u && u.endsWith('/auth/me');
page.on('console', (m) => {
  if (m.type() !== 'error' || expectedUrl(m.location()?.url)) return;
  problems.push(`console.error: ${m.text()}`);
});
page.on('response', (r) => {
  if (r.status() < 400 || (r.status() === 401 && expectedUrl(r.url()))) return;
  problems.push(`HTTP ${r.status()}: ${r.url()}`);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (name) => { await page.screenshot({ path: `${OUT}/${name}.png` }); console.log('shot', name); };
// NB: .kick labels are CSS-uppercased and innerText reflects that — match case-insensitively.
const waitText = (t, ms = 8000) =>
  page.waitForFunction((x) => document.body.innerText.toLowerCase().includes(x.toLowerCase()), { timeout: ms }, t);
const clickText = async (sel, text) => {
  const ok = await page.$$eval(sel, (els, t) => {
    const el = els.find((e) => e.textContent.toLowerCase().includes(t.toLowerCase()));
    if (el) { el.click(); return true; }
    return false;
  }, text);
  if (!ok) throw new Error(`no ${sel} matching "${text}"`);
};
const scrollTo = (px) => page.$eval('.scroll', (el, y) => { el.scrollTop = y; }, px);
const phone = () => page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });

await phone();

if (want('app') || want('light')) {
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  await waitText('Try the demo').catch(() => {
    throw new Error('No "Try the demo" on the sign-in screen — create the demo first (see SKILL.md)');
  });
  await shot('01-auth');
  await clickText('button', 'Try the demo');
  await waitText('This week');
  await sleep(1200);
}

if (want('app')) {
  await shot('02-plan');
  try { await clickText('.coachnote', 'more'); await sleep(300); await shot('03-plan-note'); } catch {}
  await page.$eval('.herocard', (el) => el.click());
  await sleep(1100);
  await shot('04-day');
  await scrollTo(700); await sleep(300);
  await shot('05-day-scrolled');

  await clickText('.tab', 'History');
  await waitText('All sessions');
  await sleep(600);
  await shot('06-history');
  const run = await page.$$eval('.lrow', (els) => {
    const el = els.find((e) => /km/.test(e.textContent));
    if (el) { el.click(); return true; }
    return false;
  });
  if (run) {
    await sleep(1000);
    await shot('07-run');
    await scrollTo(700); await sleep(300); await shot('08-run-charts');
    await scrollTo(1500); await sleep(300); await shot('09-run-zones');
  }

  await clickText('.tab', 'Progress');
  await waitText('Trends');
  await sleep(900);
  await shot('10-progress');
  await scrollTo(900); await sleep(300); await shot('11-progress-mid');
  await scrollTo(1900); await sleep(300); await shot('12-progress-end');

  await clickText('.tab', 'Coach');
  await sleep(1100);
  await shot('13-coach');
  try {
    await clickText('.propbar', 'Review');
    await sleep(500);
    await shot('14-proposal');
    await page.mouse.click(195, 60); // tap scrim to close
    await sleep(300);
  } catch { console.log('no pending proposal — sheet skipped'); }
}

if (want('light')) {
  // Light mode toggles via data-theme (NOT prefers-color-scheme).
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await clickText('.tab', 'Plan');
  await sleep(700);
  await shot('20-plan-light');
  await page.$eval('.herocard', (el) => el.click());
  await sleep(900);
  await shot('21-day-light');
  await clickText('.tab', 'Progress');
  await sleep(900);
  await shot('22-progress-light');
  await page.evaluate(() => { delete document.documentElement.dataset.theme; });
}

if (want('welcome')) {
  await phone();
  await page.goto(BASE + '/welcome.html', { waitUntil: 'networkidle0' });
  await sleep(400);
  await shot('30-welcome-mobile');
  const charts = await page.evaluate(() => ({
    route: document.getElementById('route')?.innerHTML.length || 0,
    e1rm: document.getElementById('e1rm')?.innerHTML.length || 0,
  }));
  if (!charts.route || !charts.e1rm) problems.push(`welcome charts empty: ${JSON.stringify(charts)}`);
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  await sleep(400);
  await shot('31-welcome-desktop');
}

await browser.close();
if (problems.length) {
  console.error('\nPROBLEMS:\n' + problems.map((p) => '  - ' + p).join('\n'));
  process.exit(1);
}
console.log(`\nclean run — screenshots in ${OUT}`);
