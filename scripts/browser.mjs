// Drive local Firefox over WebDriver. Firefox is the only browser in this lane
// (see .cline/skills/mega-challenge/docs/browser.md); no packages — geckodriver speaks
// WebDriver over plain HTTP and Node's fetch is enough.
//
// One process does the whole job, because nothing here survives between shell calls:
//   node scripts/browser.mjs once --url <url> [--js-file <file>] [--shot <png>] [--wait <ms>]
//   node scripts/browser.mjs start | goto --url | js "<body>" | shot <png> | stop   (same process only)
//
// verify.mjs and record.mjs import the Firefox class and keep one browser open for their run.
// geckodriver.exe and firefox.exe come from GECKODRIVER / FIREFOX, ../tools/, or the usual
// Windows install paths. Nothing here holds the session token; the board reads it from config.js.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function find(exe, envName, extra = []) {
  const cands = [
    process.env[envName],
    ...extra,
    resolve(ROOT, 'tools', exe),
    resolve(ROOT, '..', 'tools', exe),
  ].filter(Boolean);
  for (const c of cands) if (existsSync(c)) return c;
  throw new Error(`cannot find ${exe}; set ${envName} or pass --driver/--binary`);
}

async function call(port, method, path, body) {
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new Error(`cannot reach geckodriver on ${port}: ${e.message}`);
  }
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`geckodriver answered ${res.status}: ${text.slice(0, 200)}`);
  }
  if (!res.ok || (json.value && json.value.error)) {
    throw new Error(`WebDriver ${method} ${path} → ${res.status}: ${JSON.stringify(json.value ?? json).slice(0, 300)}`);
  }
  return json.value;
}

export class Firefox {
  constructor({ port = 4447, headless = true, profile, width = 1280, height = 900 } = {}) {
    this.port = port;
    this.headless = headless;
    this.profile = profile || resolve(ROOT, '..', '.tmp', 'firefox-profile');
    this.width = width;
    this.height = height;
    this.sid = null;
    this.child = null;
  }

  async start() {
    const driver = find('geckodriver.exe', 'GECKODRIVER');
    const firefox = find('firefox.exe', 'FIREFOX', [
      'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
      'C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe',
    ]);
    mkdirSync(this.profile, { recursive: true });
    this.child = spawn(driver, ['--port', String(this.port), '--log', 'error'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      await sleep(250);
      try {
        await call(this.port, 'GET', '/status');
        up = true;
      } catch {}
    }
    if (!up) {
      this.stop();
      throw new Error(`geckodriver never answered on port ${this.port}`);
    }
    const args = ['--profile-rootdir', this.profile, '--width', String(this.width), '--height', String(this.height)];
    if (this.headless) args.push('--headless');
    const value = await call(this.port, 'POST', '/session', {
      capabilities: {
        alwaysMatch: {
          'moz:firefoxOptions': {
            binary: firefox,
            args,
            prefs: {
              'app.update.auto': false,
              'browser.sessionstore.resume_from_crash': false,
              'datareporting.policy.dataSubmissionEnabled': false,
            },
          },
          unhandledPromptBehavior: 'dismiss and notify',
        },
      },
    });
    this.sid = value.sessionId;
    await call(this.port, 'POST', `/session/${this.sid}/window`, {
      rect: { x: null, y: null, width: this.width, height: this.height },
    }).catch(() => {});
    return this;
  }

  url(u) {
    return call(this.port, 'POST', `/session/${this.sid}/url`, { url: u });
  }

  js(script, ...args) {
    return call(this.port, 'POST', `/session/${this.sid}/execute/sync`, { script, args });
  }

  async shot(file) {
    const b64 = await call(this.port, 'GET', `/session/${this.sid}/screenshot`);
    const out = resolve(file);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, Buffer.from(b64, 'base64'));
    return out;
  }

  // --- real pointer input, W3C Actions ---------------------------------------
  // `element.click()` from a script is what a test does. A person moves a pointer over the button
  // and presses it, and the browser sends the pointer events that come with that. These calls send
  // exactly those, at viewport coordinates in CSS pixels, so the page cannot tell the difference.
  async actions(sequences) {
    await call(this.port, 'POST', `/session/${this.sid}/actions`, { actions: sequences });
    return call(this.port, 'DELETE', `/session/${this.sid}/actions`).catch(() => {});
  }

  pointer(steps) {
    return this.actions([{ type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' }, actions: steps }]);
  }

  // Move the pointer to a viewport point. A non-zero duration makes the browser deliver the moves
  // along the way, so :hover states and pointerover events happen the way they do under a hand.
  moveTo(x, y, ms = 0) {
    return this.pointer([
      { type: 'pointerMove', duration: ms, x: Math.round(x), y: Math.round(y), origin: 'viewport' },
      { type: 'pause', duration: 16 },
    ]);
  }

  // Press and release the primary button where the pointer stands. The move is part of the same
  // sequence on purpose: geckodriver keeps no pointer position between action sequences, so a press
  // that names no coordinates lands at (0,0) — the page then reports a trusted click on the header.
  press(x, y, ms = 70) {
    return this.pointer([
      { type: 'pointerMove', duration: 0, x: Math.round(x), y: Math.round(y), origin: 'viewport' },
      { type: 'pointerDown', button: 0 },
      { type: 'pause', duration: ms },
      { type: 'pointerUp', button: 0 },
    ]);
  }

  wheel(deltaY, x, y, ms = 120) {
    return this.actions([{
      type: 'wheel', id: 'wheel',
      actions: [{ type: 'scroll', x: Math.round(x), y: Math.round(y), deltaX: 0, deltaY: Math.round(deltaY), duration: ms }],
    }]);
  }

  viewport() {
    return this.js('return { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio };');
  }

  // Waits until the script returns a truthy value, or throws once the budget runs out.
  async until(script, ms = 20000, what = script.slice(0, 60)) {
    const every = 250;
    for (let waited = 0; waited <= ms; waited += every) {
      const ok = await this.js(script).catch(() => null);
      if (ok) return ok;
      await sleep(every);
    }
    throw new Error(`timed out after ${ms}ms waiting for: ${what}`);
  }

  logs() {
    return call(this.port, 'GET', `/session/${this.sid}/log`, {}).catch(() => []);
  }

  stop() {
    if (this.sid) call(this.port, 'DELETE', `/session/${this.sid}`).catch(() => {});
    if (this.child) {
      try {
        this.child.kill();
      } catch {}
    }
    this.sid = null;
  }
}

// --- command line -------------------------------------------------------------
// The command line runs only when this file is the entry point: verify.mjs and record.mjs import
// the Firefox class and bring their own arguments.
cli: {
  const invokedDirectly = process.argv[1] ? resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)) : false;
  if (!invokedDirectly) break cli;

  const argv = process.argv.slice(2);
const cmd = argv[0];
const usage = `usage:
  node scripts/browser.mjs probe                          start firefox, print its version, stop
  node scripts/browser.mjs once --url <url> [--js "<body>"] [--js-file <f>] [--wait <ms>] [out.png]`;
if (!cmd || cmd === 'help' || cmd === '--help') {
  console.log(usage);
  process.exit(0);
}

const opts = { _: [], args: [] };
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--arg') opts.args.push(JSON.parse(argv[++i]));
  else if (a === '--headful') opts.headful = true;
  else if (a.startsWith('--')) opts[a.slice(2)] = argv[++i];
  else opts._.push(a);
}

const ff = new Firefox({ port: Number(opts.port || 4447), headless: !opts.headful, profile: opts.profile });
try {
  if (cmd === 'probe') {
    await ff.start();
    console.log(JSON.stringify(await ff.js('return { ua: navigator.userAgent, now: new Date().toISOString() };'), null, 2));
    ff.stop();
    process.exit(0);
  }
  if (cmd === 'once') {
    await ff.start();
    if (opts.url) {
      await ff.url(opts.url);
      await ff.until('return document.readyState === "complete";', Number(opts.timeout || 30000), 'page load');
    }
    if (opts.wait) await sleep(Number(opts.wait));
    if (opts.js) console.log(JSON.stringify(await ff.js(opts.js), null, 2));
    if (opts['js-file']) {
      const body = readFileSync(resolve(opts['js-file']), 'utf8');
      console.log(JSON.stringify(await ff.js(body, ...opts.args), null, 2));
    }
    if (opts._[0]) console.log(`screenshot: ${await ff.shot(opts._[0])}`);
    ff.stop();
    process.exit(0);
  }
  console.error(`browser: unknown command "${cmd}"\n${usage}`);
  process.exit(2);
} catch (e) {
  ff.stop();
  console.error(`browser: ${e.message}`);
  process.exit(1);
}
}
