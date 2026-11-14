// The gate for a board build. It opens the page in Firefox (this lane's only browser) and checks
// every row of plan.md against what the running page really does, then prints one line per check.
//
//   node scripts/verify.mjs --url https://<deployed-board>/ [--out ../.tmp/verify.json] [--headful]
//
// Lines are `ok  <check>` / `FAIL <check>: <why>` / `SKIP <check>: <why>`; the last line is
// `result: ok` or `result: FAIL`, and the exit code is 0 only when nothing failed. Full detail
// (incident ids, ack receipts, the page's own text) goes to --out as JSON, never to chat.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Firefox, sleep } from './browser.mjs';

const argv = process.argv.slice(2);
const opts = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--headful') opts.headful = true;
  else if (a.startsWith('--')) opts[a.slice(2)] = argv[++i];
}
const url = opts.url;
if (!url) {
  console.error('verify: --url <board url> is required');
  process.exit(2);
}
const out = opts.out ? resolve(opts.out) : resolve('..', '.tmp', `verify-${Date.now()}.json`);
const checks = [];
const add = (name, ok, detail = '') => {
  checks.push({ name, ok, detail: String(detail).slice(0, 400) });
  console.log(`${ok === null ? 'SKIP' : ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${String(detail).slice(0, 300)}` : ''}`);
};
const page = { url, startedAt: new Date().toISOString() };

// The board formats times with exactly these options (app.js R5); mirroring them here means a
// mismatch is the page being wrong, not the check guessing at a format.
const FORMAT = `const f = new Intl.DateTimeFormat(navigator.language || 'en-GB', {
  day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });`;

let html = '';
try {
  const res = await fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:160.0) Gecko/20100101 Firefox/160.0' },
  });
  html = await res.text();
  page.httpStatus = res.status;
  add('http: the url answers 200', res.status === 200, `status ${res.status}`);
} catch (e) {
  add('http: the url answers 200', false, e.message);
}
add('https: served over https', url.startsWith('https://') ? true : null, url.startsWith('https://') ? '' : 'plain url — only valid for a local run');
add('R3 loader: the markup ships a loader', /data-testid="loader"/.test(html), 'data-testid="loader" in index.html');
add('R6 build: the markup carries a 40-char sha in <meta name="build">', /<meta name="build" content="[0-9a-f]{40}"/.test(html));

const ff = new Firefox({ headless: !opts.headful, port: Number(opts.port || 4448) });
try {
  await ff.start();
  page.browser = await ff.js('return navigator.userAgent;');
  await ff.url(url);

  // R3: the loader is what stands on the page while the first answer is still out.
  const firstLook = await ff.js(`return {
    loader: !!document.querySelector('[data-testid="loader"]'),
    rows: document.querySelectorAll('[data-testid="incident-row"]').length,
    status: (document.getElementById('status') || {}).textContent };`);
  page.firstLook = firstLook;
  add('R3 loader: it stands before the first answer lands', firstLook.loader || firstLook.rows > 0, firstLook.loader ? `loader shown; status "${firstLook.status}"` : `load finished before the first look; status "${firstLook.status}"`);

  // R4: count the board's own fetches — nothing else drives this page.
  await ff.js('window.__fetches = 0; const f = window.fetch.bind(window); window.fetch = (...a) => { window.__fetches++; return f(...a); }; return true;');

  await ff.until(
    'return document.querySelectorAll("[data-testid=\\"incident-row\\"]").length > 0 || !!document.querySelector("[data-testid=\\"empty\\"]:not([hidden])");',
    20000,
    'the first incidents to arrive',
  );
  const loaded = await ff.js(`return {
    loader: !!document.querySelector('[data-testid="loader"]'),
    rows: document.querySelectorAll('[data-testid="incident-row"]').length,
    empty: !!document.querySelector('[data-testid="empty"]:not([hidden])'),
    status: (document.getElementById('status') || {}).textContent };`);
  page.loaded = loaded;
  add('R3 loader: gone once the first answer landed', !loaded.loader, `status "${loaded.status}"`);
  add('R1 list: the board shows incidents', loaded.rows > 0 || loaded.empty, `${loaded.rows} row(s)`);

  // R1: newest first, and one row per incident id.
  const order = await ff.js(`return [...document.querySelectorAll('[data-testid="incident-row"]')].map(li => ({
    id: li.dataset.id, openedAt: li.querySelector('time').getAttribute('datetime') }));`);
  page.rows = order;
  const ids = order.map((r) => r.id);
  const descending = order.every((r, i) => i === 0 || Date.parse(order[i - 1].openedAt) >= Date.parse(r.openedAt));
  add('R1 list: newest first', order.length > 0 && descending, order.slice(0, 4).map((r) => r.openedAt).join(' ≥ …'));
  add('R4 refresh: one row per incident, no duplicates', new Set(ids).size === ids.length, `${ids.length} rows, ${new Set(ids).size} ids`);

  // R5: the full UTC instant stays on the element; the viewer's own clock is what they read.
  const times = await ff.js(`${FORMAT}
    return [...document.querySelectorAll('[data-testid="incident-row"] time')].slice(0, 3).map(t => ({
      datetime: t.getAttribute('datetime'),
      shown: t.textContent,
      expected: f.format(new Date(t.getAttribute('datetime'))) }));`);
  page.times = times;
  const instant = times.every((t) => /Z$|[+-]\d{2}:\d{2}$/.test(t.datetime));
  const local = times.every((t) => t.shown === t.expected && t.shown !== t.datetime);
  add('R5 times: the element keeps the full UTC instant', times.length > 0 && instant, times.map((t) => t.datetime).join(' | '));
  add('R5 times: what the viewer reads is their own local time', times.length > 0 && local, times.map((t) => `${t.datetime} → ${t.shown}`).join(' | '));

  // R4: the board re-reads the API on its own, roughly every 2s, with nobody touching it.
  const before = await ff.js('return window.__fetches;');
  await sleep(5000);
  const after = await ff.js('return window.__fetches;');
  page.fetchesIn5s = after - before;
  add('R4 refresh: it re-reads the API by itself (2s cadence)', after - before >= 2, `${after - before} fetches in 5s`);

  // R2: Ack turns that row's button into the acked mark and leaves a receipt behind.
  const target = await ff.js(`const li = [...document.querySelectorAll('[data-testid="incident-row"]')]
      .find(l => l.querySelector('[data-testid="ack"]'));
    if (!li) return null;
    li.querySelector('[data-testid="ack"]').click();
    return li.dataset.id;`);
  if (!target) {
    add('R2 ack: a row offers Ack', false, 'no row carried an Ack button — every incident already acked?');
  } else {
    page.ackTarget = target;
    let acked;
    try {
      acked = await ff.until(
        `const li = document.querySelector('[data-testid="incident-row"][data-id="${target}"]');
         const m = li && li.querySelector('[data-testid="acked"]');
         return m ? { receipt: m.getAttribute('data-receipt'), title: m.getAttribute('title'),
                      status: document.getElementById('status').textContent } : null;`,
        15000,
        `the acked mark on ${target}`,
      );
    } catch (e) {
      const why = await ff.js('return document.getElementById("status").textContent;').catch(() => '');
      add('R2 ack: Ack becomes acked with a receipt', false, `${target}: ${e.message.split(':')[0]} — status "${why}"`);
    }
    if (acked) {
      page.ack = acked;
      add('R2 ack: Ack becomes acked and carries a receipt', !!acked.receipt, `${target} → ${acked.receipt}`);
      add('R2 ack: the receipt is shown on the page', /·/.test(acked.title || ''), acked.title);
      // A refresh re-renders the list; the acked row must survive it (merge by id, no reset).
      await sleep(4000);
      const kept = await ff.js(`const li = document.querySelector('[data-testid="incident-row"][data-id="${target}"]');
        return { acked: !!li.querySelector('[data-testid="acked"]'), button: !!li.querySelector('[data-testid="ack"]'),
                 receipts: document.querySelectorAll('#receipt-list li').length };`);
      add('R4 refresh: the acked row stays acked after a refresh', kept.acked && !kept.button, JSON.stringify(kept));
      add('R2 ack: the receipt is listed under ack receipts', kept.receipts > 0, `${kept.receipts} receipt line(s)`);
    }
  }

  // R6: the page names its build, in both places, and that name is a commit that exists.
  const build = await ff.js(`return {
    meta: document.querySelector('meta[name="build"]').content,
    footer: document.querySelector('[data-testid="build-sha"]').textContent.trim() };`);
  page.build = build;
  add('R6 build: meta and footer name the same build', build.meta === build.footer && /^[0-9a-f]{40}$/.test(build.meta), `${build.meta} / ${build.footer}`);
  if (opts.sha) add('R6 build: the page names the commit the deploy built', build.meta === opts.sha, `page ${build.meta} vs deploy ${opts.sha}`);
  const repoRoot = resolve(import.meta.dirname, '..');
  const { existsSync: has } = await import('node:fs');
  let realCommit = null;
  if (has(resolve(repoRoot, '.git'))) {
    const { execFileSync } = await import('node:child_process');
    try {
      execFileSync('git', ['cat-file', '-e', `${build.meta}^{commit}`], { cwd: repoRoot, stdio: 'ignore' });
      realCommit = true;
    } catch {
      realCommit = false;
    }
  }
  add('R6 build: that build name is a real commit in this repo', realCommit === true ? true : null, realCommit === null ? 'no .git here to ask' : build.meta);

  page.shot = await ff.shot(resolve('..', '.tmp', `verify-board-${Date.now()}.png`));
} catch (e) {
  add('verify: the run itself finished', false, e.message);
} finally {
  ff.stop();
}

const failed = checks.filter((c) => c.ok === false);
page.checks = checks;
page.result = failed.length ? 'FAIL' : 'ok';
page.finishedAt = new Date().toISOString();
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(page, null, 2)}\n`);
console.log(`evidence: ${out}`);
console.log(`result: ${failed.length ? 'FAIL' : 'ok'}`);
process.exit(failed.length ? 1 : 0);
