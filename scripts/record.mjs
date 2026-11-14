// Record one proof flow on a running board and cut it into a video with a timecode burned in.
// Everything happens in Firefox (this lane's only browser) against the real board, at a real URL.
//
//   node scripts/record.mjs --url https://<deployed-board>/ [--flow ack-incident] [--out ../.tmp/take] [--fps 5]
//
// What it does: opens the board, watches it until the flow's state change is on the screen, taking
// a screenshot every 1/fps seconds and stamping each frame with the wall clock; then ffmpeg turns
// those frames into take.mp4 at their real spacing, with the elapsed time (hh:mm:ss) burned into
// every frame. take.json carries every frame's wall-clock time, the incident the flow touched, and
// `at` — the mm:ss mark inside the video where the state change is on screen. Nothing secret goes
// into either file: the ack receipt is written as it appears on the page, which is the proof.
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Firefox, find, sleep } from './browser.mjs';

const argv = process.argv.slice(2);
const opts = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--headful') opts.headful = true;
  else if (a.startsWith('--')) opts[a.slice(2)] = argv[++i];
}
const url = opts.url;
const flow = opts.flow || 'ack-incident';
if (!url) {
  console.error('record: --url <board url> is required');
  process.exit(2);
}
if (!['ack-incident', 'watch-board'].includes(flow)) {
  console.error(`record: unknown flow "${flow}" (ack-incident, watch-board)`);
  process.exit(2);
}
const fps = Math.max(1, Number(opts.fps || 5));
// Waiting for an incident to land takes minutes; a take nobody wants to sit through proves nothing
// either. So the camera runs slow (1 frame/s) while it waits and switches to `fps` the moment there
// is something to see. Each frame carries its real timestamp, and the video is cut at those times,
// so the switch is honest: the timecode keeps running at wall-clock speed.
const slowFps = Math.max(1, Number(opts.slowfps || 1));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = opts.out ? resolve(opts.out) : resolve('..', '.tmp', `take-${flow}-${stamp}`);
const framesDir = resolve(outDir, 'frames');
mkdirSync(framesDir, { recursive: true });

function ffmpegPath() {
  const p = process.env.FFMPEG || 'ffmpeg';
  return p;
}

// drawtext needs a font file it can open; pick the first one this Windows actually has.
function fontFile() {
  for (const f of ['arial.ttf', 'segoeui.ttf', 'tahoma.ttf', 'consola.ttf']) {
    const p = `C:/Windows/Fonts/${f}`;
    if (existsSync(p)) return p;
  }
  return null;
}

function ffmpegRun(args, label, cwd) {
  const r = spawnSync(ffmpegPath(), args, { encoding: 'utf8', windowsHide: true, cwd });
  if (r.status !== 0) {
    const tail = (r.stderr || '').split('\n').filter(Boolean).slice(-6).join(' | ');
    throw new Error(`ffmpeg ${label} failed (${r.status}): ${tail}`);
  }
  return r;
}

const take = { flow, url, fps, startedAt: new Date().toISOString(), frames: [], outDir };

// --- the run -------------------------------------------------------------------
const frameMs = Math.round(1000 / fps);
let frame = 0;
const ff = new Firefox({ headless: !opts.headful, port: Number(opts.port || 4449) });

async function grab(note) {
  const name = `frame-${String(++frame).padStart(4, '0')}.png`;
  const at = new Date().toISOString();
  const ms = Date.now();
  await ff.shot(resolve(framesDir, name));
  take.frames.push({ name, at, ms, note });
  return { name, ms };
}

// A person does not run `element.click()`. They look at the screen, move the pointer onto the button
// and press it, while the page carries on changing around them. This presses Ack that way: the
// button's own on-screen rectangle is read, the pointer travels to it in steps with the camera
// running, it rests there long enough for the hover state to show, then the primary button goes
// down and up. The board's own 2 s refresh keeps firing underneath.
//
// Whether the click that acked the row was a real one is not taken on trust from this script: the
// page reports it (`isTrusted`), and a scripted click reports false. The listener is fitted when the
// board opens, before anything is watched, so it cannot be chosen to fit the answer.
function watchPointerEvents() {
  return ff.js(`window.__takeEvents = []; window.__takeHovers = 0;
    const testid = (el) => { const c = el && el.closest ? el.closest('[data-testid]') : null;
      return c ? c.getAttribute('data-testid') : (el ? el.tagName : null); };
    const stamp = () => new Date().toISOString();
    document.addEventListener('pointerover', (e) => {
      const b = e.target.closest ? e.target.closest('[data-testid="ack"]') : null;
      if (!b) return;
      window.__takeHovers++;
      window.__takeEvents.push({ type: 'pointerover', trusted: e.isTrusted, x: Math.round(e.clientX), y: Math.round(e.clientY), target: 'ack', at: stamp() });
    }, true);
    document.addEventListener('pointerdown', (e) => {
      window.__takeEvents.push({ type: 'pointerdown', trusted: e.isTrusted, x: Math.round(e.clientX), y: Math.round(e.clientY), target: testid(e.target), at: stamp() });
    }, true);
    document.addEventListener('click', (e) => {
      window.__takeEvents.push({ type: 'click', trusted: e.isTrusted, detail: e.detail, x: Math.round(e.clientX), y: Math.round(e.clientY), target: testid(e.target), at: stamp() });
    }, true);
    return true;`);
}

async function pressAckLikeAPerson(id) {
  const at = await ff.js(`const li = document.querySelector('[data-testid="incident-row"][data-id="${id}"]');
    const b = li && li.querySelector('[data-testid="ack"]');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2),
             w: Math.round(r.width), h: Math.round(r.height) };`);
  if (!at) return { ok: false, why: 'its row offered no Ack button' };

  const vp = await ff.viewport();
  if (at.y < 0 || at.y > vp.h || at.x < 0 || at.x > vp.w) {
    // It is off screen: a person scrolls to it, so the recorder scrolls too — and says so.
    await ff.wheel(at.y - Math.round(vp.h / 2), Math.round(vp.w / 2), Math.round(vp.h / 2));
    await sleep(250);
    return pressAckLikeAPerson(id); // the rect moved; read it again rather than aim at the old one
  }

  const stepNotes = [];
  const step = async (label, x, y, kind) => { await grab(label); stepNotes.push({ kind, label, x, y, frame: take.frames.length }); };
  // A person watching the list clicks a new row about a second after it appears. So the reach is short
  // and few frames are grabbed between the row landing and the press: the press has to fall in the same
  // second the row did, or the take does not show the board picking up a fresh incident at all.
  const from = { x: Math.round(vp.w * 0.62), y: Math.min(vp.h - 24, at.y + 110) };
  await ff.moveTo(from.x, from.y);
  await step('pointer resting before the board', from.x, from.y, 'rest');
  const moves = Number(opts.reach || 2); // pointerMove steps on the way — a short reach, not a crawl
  const restMs = Number(opts.hover || 120); // on the button before the button goes down
  for (let s = 1; s <= moves; s++) {
    const t = s / moves;
    const x = Math.round(from.x + (at.x - from.x) * t);
    const y = Math.round(from.y + (at.y - from.y) * t - 20 * Math.sin(Math.PI * t)); // a slight arc, like a hand
    await ff.moveTo(x, y, 40);
    if (s === moves) await step(`pointer on the Ack of ${id} — the button shows hover`, at.x, at.y, 'hover');
    else await step(`pointer moving to the Ack of ${id}`, x, y, 'move');
  }
  await sleep(restMs); // the button's hover state is on camera in this span
  const pressedAtMs = Date.now();
  await ff.press(at.x, at.y);
  await sleep(150);
  await step(`primary button pressed and released on the Ack of ${id}`, at.x, at.y, 'press');

  const page = await ff.js(`return { events: window.__takeEvents || [], hovers: window.__takeHovers || 0,
    focus: document.activeElement && document.activeElement.getAttribute ? document.activeElement.getAttribute('data-testid') : null };`);
  const hit = page.events.find((e) => e.type === 'click' && e.trusted && e.target === 'ack'
    && Math.abs(e.x - at.x) <= Math.max(8, Math.round(at.w / 2))
    && Math.abs(e.y - at.y) <= Math.max(8, Math.round(at.h / 2)));
  const scripted = page.events.filter((e) => e.type === 'click' && !e.trusted).length;
  // The pace this take actually moved at, measured from the camera's own frames — not a claim about
  // what the script intended.
  const frameOf = (step) => step ? take.frames[step.frame - 1] : null;
  const restStep = stepNotes[0];
  const hoverStep = stepNotes.find((s) => s.kind === 'hover');
  const pressStep = stepNotes.find((s) => s.kind === 'press');
  const travelMs = hoverStep && restStep ? frameOf(hoverStep).ms - frameOf(restStep).ms : null;
  const hoverMs = pressStep && hoverStep ? frameOf(pressStep).ms - frameOf(hoverStep).ms : null;
  take.pointer = {
    how: `W3C pointer actions at the button's own screen rect: ${moves} pointerMove steps over ${travelMs} ms, then ${hoverMs} ms resting on the button, then pointerDown/Up in one sequence — not element.click()`,
    travelMs, hoverMs, moves,
    rect: at, viewport: vp, path: stepNotes, hoverEvents: page.hovers, focusAfter: page.focus,
    at: new Date(pressedAtMs).toISOString(),
  };
  if (!hit) {
    return { ok: false, why: page.events.length ? 'no trusted pointer click landed on that button' : 'the page reported no click event at all' };
  }
  return {
    ok: true, at: new Date(pressedAtMs).toISOString(), trusted: true,
    hovers: page.hovers, scriptedClicks: scripted, focus: page.focus, x: hit.x, y: hit.y,
  };
}

const seen = new Set(); // incidents that were on screen last frame
let firstAtMs = null;
let clicked = null; // the incident this take acks
let receipt = null;
let changeFrame = null; // the frame where the flow's state change is on screen
const receiptsBefore = new Set(); // receipts already on the board before this take clicked
let note = 'board opening';

// A take you can point at. For `ack-incident` that means a race, and not against the board: the
// camera opens on the board as it stands, and the recorder waits — up to --watch seconds, the API
// here emits one incident every ~7 minutes — until an incident that was NOT on screen when the
// camera opened arrives on camera. Only then is Ack pressed, on that row, seconds after it landed.
// A take where the newest row merely happens to be recent proves nothing: it was already there when
// the recording started, so nothing landed on screen. Then eight seconds watching the acked row
// survive the board's own 2s refreshes.
const leadFrames = flow === 'ack-incident' ? fps * 2 : 2;
const tailFrames = fps * (flow === 'ack-incident' ? 8 : 4);
const watchS = Number(opts.watch || (flow === 'ack-incident' ? 900 : 60));
const waitUntil = Date.now() + watchS * 1000; // wall clock to stop watching at — the camera paces itself, so frames do not decide
const maxFrames = 30000; // a guard against a runaway loop, not the plan
let statusBefore = '';
let initialIds = null; // ids on screen when the camera opened — a landing is a row outside this set
let landed = null; // the incident that arrived on camera, and when
let expected = null; // the incident this take means to ack: the one that landed
let got = null; // the incident the board actually shows acked, with a receipt it did not have before


try {
  await ff.start();
  await ff.url(url);
  await watchPointerEvents();

  for (let i = 0; i < maxFrames; i++) {
    if (!clicked && Date.now() > waitUntil) {
      note = `giving up: no incident landed within ${watchS}s of watching`;
      break;
    }
    const spent = Date.now();
    await grab(note);
    if (firstAtMs === null) firstAtMs = take.frames[0].ms;

    const now = await ff.js(`return {
      rows: [...document.querySelectorAll('[data-testid="incident-row"]')].map(li => ({
        id: li.dataset.id,
        acked: !!li.querySelector('[data-testid="acked"]'),
        openedAt: (li.querySelector('time') || {}).getAttribute
          ? li.querySelector('time').getAttribute('datetime') : null,
        receipt: (li.querySelector('[data-testid="acked"]') || {}).getAttribute
          ? li.querySelector('[data-testid="acked"]').getAttribute('data-receipt') : null,
      })),
      status: document.getElementById('status').textContent };`);

    if (!statusBefore) statusBefore = now.status;
    const fresh = now.rows.filter((r) => !seen.has(r.id)).map((r) => r.id);
    now.rows.forEach((r) => seen.add(r.id));
    // Receipts the board already had before this take's click. A row showing one of these is an ack
    // from an earlier take, not the ack this take is reporting.
    if (!clicked) now.rows.forEach((r) => { if (r.receipt) receiptsBefore.add(r.receipt); });
    const newlyAcked = clicked
      ? now.rows.filter((r) => r.acked && r.receipt && !receiptsBefore.has(r.receipt))
      : [];

    if (flow === 'ack-incident') {
      if (initialIds === null && now.rows.length) initialIds = new Set(now.rows.map((r) => r.id));
      const arrivals = initialIds ? now.rows.filter((r) => !initialIds.has(r.id)) : [];
      if (!clicked) {
        const fresh = arrivals.find((r) => !r.acked);
        if (!fresh) {
          const watchedS = firstAtMs ? Math.round((take.frames[frame - 1].ms - firstAtMs) / 1000) : 0;
          note = now.rows.length
            ? `${now.rows.length} incidents on the board, none new yet — watching ${watchedS}s of ${watchS}s`
            : 'waiting for the board to answer';
        } else {
          // This row was not on screen when the camera opened: it landed on camera. Ack it now.
          landed = {
            id: fresh.id,
            openedAt: fresh.openedAt,
            frame,
            onCameraAt: take.frames[frame - 1].at,
            ageOnCameraS: Number(((Date.now() - Date.parse(fresh.openedAt)) / 1000).toFixed(1)),
          };
          take.landed = landed;
          const press = await pressAckLikeAPerson(fresh.id);
          if (press.ok) {
            // The honest age: from the incident opening to the button actually going down, which is a
            // few seconds after the row first showed — the pointer had to travel to it.
            const ageAtPress = Number(((Date.parse(press.at) - Date.parse(fresh.openedAt)) / 1000).toFixed(1));
            clicked = {
              id: fresh.id, at: press.at, ageAtClickS: ageAtPress, ageOnScreenS: landed.ageOnCameraS,
              via: 'pointer', trusted: press.trusted, hoverEvents: press.hovers,
              scriptedClicks: press.scriptedClicks, focusAfter: press.focus, clickXY: [press.x, press.y],
            };
            take.acked = clicked;
            note = `${fresh.id} opened ${landed.ageOnCameraS}s ago and landed on camera — the pointer moved onto its Ack and pressed it ${ageAtPress}s after it opened`;
          } else {
            note = `${fresh.id} landed, but ${press.why} — this take stops here`;
            break;
          }
        }
      } else if (!changeFrame) {
        const row = now.rows.find((r) => r.id === clicked.id);
        if (row && row.acked && row.receipt && !receiptsBefore.has(row.receipt)) {
          changeFrame = frame;
          receipt = row.receipt;
          // The row this take MEANT is the one that landed on camera. Who actually GOT the ack is read
          // off the board: every row carrying a receipt the board did not have before the click.
          expected = clicked.id;
          got = newlyAcked.map((r) => r.id);
          take.expected = expected;
          take.got = got;
          note = got.length === 1 && got[0] === expected
            ? `${expected} shows acked — the new receipt is on that row and on no other`
            : `new receipt on ${got.length ? got.join(', ') : 'no row'}; this take meant ${expected}`;
        } else {
          note = `waiting for ${clicked.id} to come back acked`;
        }
      }
      // Then keep the camera on the row through the board's own refreshes: the ack has to survive them.
      if (changeFrame && i >= changeFrame + tailFrames) break;
    } else {
      // watch-board: the board's own refresh is the state change.
      if (!changeFrame && (now.status !== statusBefore || fresh.length)) {
        changeFrame = frame;
        note = fresh.length ? `${fresh.length} new incident(s) appeared without a reload` : 'the board refreshed its own status line';
      } else if (changeFrame && i >= changeFrame + tailFrames) break;
      else note = fresh.length ? `${fresh.length} incident(s) arrived` : 'watching the board refresh itself';
    }

    const cost = Date.now() - spent;
    const pace = flow === 'ack-incident' && !clicked ? slowFps : fps; // slow while waiting, fast once it lands
    await sleep(Math.max(30, Math.round(1000 / pace) - cost));
  }

  await grab('end of take');
} finally {
  ff.stop();
}

take.frames.forEach((f, i) => (f.elapsedS = Number(((f.ms - firstAtMs) / 1000).toFixed(2))));
const mmss = (s) => {
  const t = Math.max(0, Math.round(s));
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};
take.receipt = receipt;
take.changeFrame = changeFrame;
take.at = changeFrame ? mmss(take.frames[changeFrame - 1].elapsedS) : null;
take.atLanded = landed ? mmss(take.frames[landed.frame - 1].elapsedS) : null;
take.atClicked = clicked && firstAtMs ? mmss((Date.parse(clicked.at) - firstAtMs) / 1000) : null;
take.landedFramesBefore = landed ? landed.frame - 1 : null; // frames showing the board WITHOUT the row, before it lands
take.finishedAt = new Date().toISOString();

// --- cut the video -------------------------------------------------------------
const video = resolve(outDir, 'take.mp4');
const lines = [];
for (let i = 0; i < take.frames.length; i++) {
  const next = take.frames[i + 1];
  lines.push(`file '${take.frames[i].name}'`);
  lines.push(`duration ${next ? ((next.ms - take.frames[i].ms) / 1000).toFixed(3) : '0.800'}`);
}
lines.push(`file '${take.frames[take.frames.length - 1].name}'`);
writeFileSync(resolve(framesDir, 'list.txt'), `${lines.join('\n')}\n`);

const font = fontFile();
const host = url.replace(/^https?:\/\//, '').replace(/[^A-Za-z0-9._-]+/g, '-');
const label = `flow ${flow} - ${host}`; // ascii only: it travels into a filter value
const draw = [];
const bs = String.fromCharCode(92); // ffmpeg wants a literal backslash before this colon
if (font) {
  // A font path with a drive colon would have to survive two layers of ffmpeg escaping, so the
  // font is copied next to the take and named relative to it: `fontfile=font.ttf`, nothing to escape.
  copyFileSync(font, resolve(outDir, 'font.ttf'));
  draw.push(`drawtext=fontfile=font.ttf:text='%{pts${bs}:hms}':fontsize=34:fontcolor=yellow:x=14:y=14:box=1:boxcolor=black@0.65`);
  draw.push(`drawtext=fontfile=font.ttf:text='${label}':fontsize=22:fontcolor=white:x=14:y=h-44:box=1:boxcolor=black@0.55`);
}
const args = ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', 'frames/list.txt'];
// A WebDriver screenshot carries no operating-system cursor, so the pointer the person moved is drawn
// in here: a ring at the coordinates the recorder aimed at, held for the seconds that step lasted.
// It is an overlay in the same way the timecode is, and the report says so — `take.pointer.path` holds
// where and when, `take.pointer.rect` the button's own box on the screen.
function pngSize(file) {
  try {
    const b = readFileSync(file);
    if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47) return null;
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  } catch {
    return null;
  }
}
const marks = [];
if (take.pointer && take.frames.length) {
  const px = pngSize(resolve(framesDir, take.frames[0].name));
  const vp = take.pointer.viewport;
  if (px && vp && vp.w && vp.h) {
    const fx = px.w / vp.w;
    const fy = px.h / vp.h;
    const sec = (step) => take.frames[step.frame - 1].elapsedS;
    take.pointer.path.forEach((step, i) => {
      const next = take.pointer.path[i + 1];
      const until = next ? sec(next) : sec(step) + 0.45;
      const size = step.kind === 'press' ? 46 : step.kind === 'hover' ? 30 : 14;
      const colour = step.kind === 'press' ? 'red' : step.kind === 'hover' ? 'yellow' : 'cyan';
      const X = Math.max(0, Math.round(step.x * fx - size / 2));
      const Y = Math.max(0, Math.round(step.y * fy - size / 2));
      marks.push(`drawbox=x=${X}:y=${Y}:w=${size}:h=${size}:color=${colour}@0.95:t=${step.kind === 'rest' ? 2 : 3}:enable='between(t,${sec(step).toFixed(2)},${until.toFixed(2)})'`);
    });
    if (font) {
      draw.push(`drawtext=fontfile=font.ttf:text='ring = pointer at the button rect (overlay)':fontsize=18:fontcolor=white:x=w-470:y=16:box=1:boxcolor=black@0.55`);
    }
  }
}
// The browser's viewport can land on an odd height (Firefox full-page capture did: 1280x815), and
// yuv420p needs even edges — so the frames are rounded down to even before anything is drawn on them.
const filters = ['scale=trunc(iw/2)*2:trunc(ih/2)*2', ...marks, ...draw];
if (filters.length) args.push('-vf', filters.join(','));
args.push('-r', '30', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', 'take.mp4');
ffmpegRun(args, 'cut', outDir); // frames, list and font all stay relative to the take folder

writeFileSync(resolve(outDir, 'take.json'), `${JSON.stringify(take, null, 2)}\n`);

const secs = take.frames.length ? take.frames[take.frames.length - 1].elapsedS : 0;
console.log(`take: ${take.frames.length} frames over ${secs}s from Firefox at ${url}`);
console.log(`take: video ${video}`);
console.log(`take: detail ${resolve(outDir, 'take.json')}`);
if (take.landed) {
  console.log(`take: ${take.landed.id} opened ${take.landed.openedAt}; not on screen for the first ${take.landedFramesBefore} frames; first on camera at ${take.atLanded}`);
  console.log(`take: Ack pressed on it at ${take.atClicked}, ${take.acked.ageAtClickS}s after it opened`);
}
console.log(take.at ? `take: state change on screen at ${take.at} (${take.frames[changeFrame - 1].at})` : 'take: no state change seen');
// One row, one value: this take names the row it meant and the row the board shows acked. Anything
// other than one row carrying the new receipt is a FAIL, not a report.
const oneRow = Array.isArray(take.got) && take.got.length === 1 && take.expected && take.got[0] === take.expected;
console.log(`take: expected ${take.expected || 'none'}; got ${Array.isArray(take.got) ? take.got.join(', ') || 'none' : 'none'}`);
// How the page was pressed matters as much as what was pressed: a scripted `element.click()` is a test
// talking to the DOM. The page itself answered whether the click was a real pointer one.
if (take.pointer) {
  console.log(`take: pressed by pointer — ${take.pointer.how}`);
  console.log(`take: page reports isTrusted=${take.acked ? take.acked.trusted : 'n/a'}, ${take.pointer.hoverEvents} pointerover on that button, ${take.acked ? take.acked.scriptedClicks : 0} scripted clicks in the page, focus after: ${take.pointer.focusAfter || 'none'}`);
} else {
  console.log('take: no pointer press in this take');
}
const pressedLikeAPerson = !!take.pointer && !!take.acked && take.acked.via === 'pointer' && take.acked.trusted === true;
const proofed = take.at && take.landed && take.acked && take.landed.id === take.expected && oneRow && pressedLikeAPerson;
console.log(proofed
  ? `result: ok`
  : `result: FAIL — ${!take.landed ? 'no incident landed on camera in this take' : !pressedLikeAPerson ? 'the ack was not pressed by a real pointer click the page reports as trusted' : !oneRow ? 'the new receipt is not on exactly the row this take meant' : 'no ack visible on screen'}`);
process.exit(proofed ? 0 : 1);
