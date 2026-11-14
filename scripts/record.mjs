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
// --race parked turns this take into an ack race. What makes it a race and not a staged click: the
// pointer parks on the Ack button of a row that is ALREADY on the board, and the coordinates of that
// button are measured once and never aimed at again. The board keeps refreshing on its own; when the
// next incident opens, the app's own merge inserts a row at the top and every row below it slides
// down, so another incident's Ack button ends up under the pointer. The press goes down at the parked
// coordinates, and which row carries the receipt afterwards is read off the board. `expected` is the
// row the hand rested on; `got` is the row the board acked. The recorder does not move the list, does
// not fire an event from script and does not pick which row gets acked — it reads the page, and presses
// the mouse where the hand was already lying.
const race = opts.race === 'parked';
if (race && flow !== 'ack-incident') {
  console.error('record: --race parked needs --flow ack-incident');
  process.exit(2);
}
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

// A hand is never still. WebDriver parks the pointer at (0,0) and leaves it there, so a recorder
// that only moves the mouse once the row lands is a test waiting for the page to hold still. This
// one keeps the pointer drifting over the list while it waits, and the reach to a new row continues
// from wherever the pointer already stood: one motion, not a jump after the page settles.
let pointerNow = { x: 0, y: 0 };
const lookNotes = []; // every look-move, with when it happened
const pointerPath = []; // the steps the video draws a ring for: rest, tremor, hover, press

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
    // When the board's own refresh puts a row into the list, that instant is stamped here. It watches
    // the page and changes nothing in it: a MutationObserver sees the node the app itself inserted.
    window.__takeInserts = [];
    const ol = document.querySelector('[data-testid="incident-list"]');
    if (ol && window.MutationObserver) {
      new MutationObserver((muts) => {
        for (const m of muts) for (const n of m.addedNodes) {
          if (n && n.dataset && n.dataset.id) {
            const r = n.getBoundingClientRect();
            window.__takeInserts.push({ id: n.dataset.id, at: stamp(), ms: Date.now(), top: Math.round(r.top), h: Math.round(r.height) });
          }
        }
      }).observe(ol, { childList: true });
    }
    return true;`);
}

// One drift over the list, like an eye moving down the rows. Kept clear of the right-hand edge,
// where the Ack buttons live, so the wait does not hover the very button this take will press.
async function lookAround() {
  const vp = await ff.viewport();
  const span = Math.max(90, Math.round(vp.h * 0.18));
  const target = {
    x: Math.round(vp.w * (0.22 + Math.random() * 0.33)),
    y: Math.round(Math.min(vp.h - 60, Math.max(110, pointerNow.y + (Math.random() * 2 - 1) * span))),
  };
  await ff.moveTo(target.x, target.y, 170); // eased, so the pointer is in motion across frames
  pointerNow = target;
  lookNotes.push({ x: target.x, y: target.y, ms: Date.now(), at: new Date().toISOString(), frame });
}

// The hand goes to a row that is already on the board and stays there. The button's own rectangle is
// measured once, reached from wherever the pointer stands, and after that nothing is re-aimed: when a
// row arrives above this one, another incident's Ack button is what sits under these coordinates, and a
// hand resting here presses that one.
async function parkOnRow() {
  // The second row down, when the board has one: parked on the top row, a slide would leave the hand
  // on the Ack of the incident that just appeared, and that reads as aim rather than as a race.
  const row = await ff.js(`const all = [...document.querySelectorAll('[data-testid="incident-row"]')];
    const li = all[1] || all[0];
    if (!li) return null;
    const b = li.querySelector('[data-testid="ack"]');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    if (r.top < 0 || r.bottom > window.innerHeight) return null;
    return { id: li.dataset.id, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2),
      w: Math.round(r.width), h: Math.round(r.height), rowTop: Math.round(li.getBoundingClientRect().top) };`);
  if (!row) return null;
  const from = { x: pointerNow.x, y: pointerNow.y };
  for (let k = 1; k <= 4; k++) {
    const t = k / 4;
    const x = Math.round(from.x + (row.x - from.x) * t + (k < 4 ? Math.random() * 10 - 5 : 0));
    const y = Math.round(from.y + (row.y - from.y) * t + (k < 4 ? Math.random() * 8 - 4 : 0));
    await ff.moveTo(x, y, k === 4 ? 220 : 120);
    pointerNow = { x, y };
    const at = new Date().toISOString();
    lookNotes.push({ x, y, ms: Date.now(), at, frame, reach: true });
    // The reach is on camera and on the timeline: the video has to show a hand arriving at this button,
    // not a cursor that was always there. Every step grabs its own frame, so its ring has a real span.
    await grab(k === 4 ? `pointer rests on ${row.id}'s Ack at ${row.x},${row.y}` : `pointer moving to ${row.id}'s Ack at ${x},${y}`);
    pointerPath.push({ kind: k === 4 ? 'rest' : 'move', x, y, ms: Date.now(), frame: take.frames.length, at });
  }
  park = { meant: row.id, x: row.x, y: row.y, rect: { x: row.x, y: row.y, w: row.w, h: row.h },
    rowTopBefore: row.rowTop, atMs: Date.now(), at: new Date().toISOString(), frame, moves: 0,
    lastRingFrame: take.frames.length };
  take.parked = { id: park.meant, xy: [park.x, park.y], rect: park.rect,
    rowTopBefore: park.rowTopBefore, at: park.at, frame: take.frames.length };
  return park;
}

// A resting hand is not a frozen one: a couple of pixels of tremor, one way then back, always around
// the same point. The coordinates that get pressed are the coordinates that were measured.
async function tremorOnButton() {
  if (!park) return;
  const even = park.moves % 2 === 0;
  const x = park.x + (even ? 2 : -2);
  const y = park.y + (even ? -1 : 1);
  await ff.moveTo(x, y, 90);
  pointerNow = { x, y };
  const at = new Date().toISOString();
  lookNotes.push({ x, y, ms: Date.now(), at, frame, tremor: true });
  park.moves++;
  // Every 15th frame of the wait leaves a ring in the video: over a wait that runs minutes that is
  // enough to show the hand lying on this button the whole time, without a thousand drawbox filters.
  if (take.frames.length - (park.lastRingFrame || 0) >= 15) {
    park.lastRingFrame = take.frames.length;
    pointerPath.push({ kind: 'move', x, y, ms: Date.now(), frame: take.frames.length, at });
  }
}

// The press, and the reading of what it hit. Nothing here re-measures the meant row: the coordinates
// are the ones parked on, taken before the list moved. Which row the board acked, whether the meant row
// still offers its button, how far the row slid — every one of those is read off the page afterwards.
async function pressWhereIParked() {
  if (!park) return { ok: false, why: 'the pointer never parked on a row' };
  const sel = `[data-testid="incident-row"][data-id="${park.meant}"]`;
  const scriptedBefore = await ff.js('return window.__takeEvents.filter((ev) => ev.type === "click" && !ev.trusted).length;');
  // The hand is still where it was put: `park.x, park.y` were read off the board before this row
  // existed, and nothing here measures or aims at anything again. hover = the whole rest on the button.
  pointerPath.push({ kind: 'hover', x: park.x, y: park.y, ms: Date.now(), frame: take.frames.length, at: new Date().toISOString() });
  const pressedAtMs = Date.now();
  await ff.press(park.x, park.y, 70);
  await grab(`primary button down and up at ${park.x},${park.y} — the coordinates parked at ${park.at}`);
  pointerPath.push({ kind: 'press', x: park.x, y: park.y, ms: Date.now(), frame: take.frames.length, at: new Date().toISOString() });
  await sleep(150);
  const after = await ff.js(`const tag = (el) => { const c = el && el.closest ? el.closest('[data-testid]') : null;
      return c ? c.getAttribute('data-testid') : (el ? el.tagName : null); };
    const el = document.elementFromPoint(${park.x}, ${park.y});
    const under = el && el.closest ? el.closest('[data-testid="incident-row"]') : null;
    const meant = document.querySelector('${sel}');
    const clicks = window.__takeEvents.filter((ev) => ev.type === 'click' && ev.trusted && ev.x === ${park.x} && ev.y === ${park.y});
    return {
      underRow: under ? under.dataset.id : null,
      underWhat: tag(el),
      meantTop: meant ? Math.round(meant.getBoundingClientRect().top) : null,
      meantAcked: meant ? !!meant.querySelector('[data-testid="acked"]') : null,
      meantHasAck: meant ? !!meant.querySelector('[data-testid="ack"]') : null,
      click: clicks.length ? clicks[clicks.length - 1] : null,
      inserts: window.__takeInserts || [],
      hovers: window.__takeHovers,
      focus: document.activeElement && document.activeElement.getAttribute ? document.activeElement.getAttribute('data-testid') : null,
      scriptedAfter: window.__takeEvents.filter((ev) => ev.type === 'click' && !ev.trusted).length };`);
  const hit = after.click;
  if (!hit) return { ok: false, why: `no click reached the page at ${park.x},${park.y}` };
  // Only a row this take had never seen counts as the arrival that slid the list: the observer also
  // fires when the app re-renders a row it already had, and that is not a new incident.
  const arrivals = (after.inserts || []).filter((i) => i.id !== park.meant && (!initialIds || !initialIds.has(i.id)));
  const insert = arrivals[arrivals.length - 1] || null;
  const vp = await ff.viewport();
  const firstStep = pointerPath[0]; // the pointer's first recorded move on the way to this button
  const pressStep = pointerPath[pointerPath.length - 1];
  take.pointer = {
    how: `W3C pointer actions: the pointer was moved onto ${park.meant}'s Ack once, at ${park.at}, and stayed there — ${park.moves} tremors, never aimed at again. The press is pointerDown/pointerUp in one sequence at those same coordinates, not element.click().`,
    travelMs: park.atMs - firstStep.ms, // the hand arriving at the button: first step recorded, to parking

    hoverMs: pressedAtMs - park.atMs, // how long it rested there before the button went down
    moves: pointerPath.filter((s) => s.kind === 'move').length,
    tremors: park.moves,
    rect: { x: park.x, y: park.y, w: park.rect.w, h: park.rect.h },
    viewport: vp, path: pointerPath, hoverEvents: after.hovers, focusAfter: after.focus,
    // Motion read off the take's own clock: drift-moves while the board refreshed, how many before the
    // new row appeared, and how many in the last second before the button went down.
    lookMoves: lookNotes.length,
    lookMovesBeforeLand: landed ? lookNotes.filter((n) => n.ms <= landed.atMs).length : lookNotes.length,
    movesLastSecond: lookNotes.concat(pointerPath).filter((n) => n.ms > pressedAtMs - 1000 && n.ms <= pressedAtMs).length,
    parkedAt: park.at, parkedMs: park.atMs, parkedFrame: park.frame,
    at: new Date(pressedAtMs).toISOString(),
  };
  return {
    ok: true, at: hit.at, pressedAtMs, trusted: hit.trusted === true, x: hit.x, y: hit.y,
    hovers: after.hovers, focus: after.focus,
    scriptedClicks: (after.scriptedAfter || 0) - (scriptedBefore || 0),
    clickedId: after.underRow,
    race: {
      mode: opts.race || null, // the flag this take was run with, so a report can name it instead of guessing
      meant: park.meant, meantRect: park.rect, parkedAt: park.at, parkedFrame: park.frame,
      parkedXy: [park.x, park.y], tremors: park.moves,
      insertId: insert ? insert.id : null, insertAt: insert ? insert.at : null,
      insertMs: insert ? insert.ms : null,
      pressAfterInsertMs: insert ? pressedAtMs - insert.ms : null,
      underPointerRow: after.underRow, underPointerWhat: after.underWhat,
      meantRowTopBefore: park.rowTopBefore, meantRowTopAfter: after.meantTop,
      shiftPx: after.meantTop === null ? null : after.meantTop - park.rowTopBefore,
      meantAckedAfter: after.meantAcked, meantStillOffersAck: after.meantHasAck,
      clickTarget: hit.target,
      inserts: (after.inserts || []).slice(-8),
    },
  };
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
  const step = async (label, x, y, kind) => { await grab(label); stepNotes.push({ kind, label, x, y, ms: Date.now(), frame: take.frames.length }); };
  // The pointer is already drifting over the list when the row appears, so the reach is the tail of
  // that motion — it starts where the pointer stands, not at a spot picked for a screenshot. Each step
  // is eased and jittered, and the button goes down inside the row's first second on the board.
  const from = { ...pointerNow };
  await step(`pointer where it already stood, mid-motion, at ${from.x},${from.y}`, from.x, from.y, 'rest');
  const moves = Number(opts.reach || 4); // pointerMove steps on the way — eased, not teleported
  const restMs = Number(opts.hover || 120); // on the button before the button goes down
  for (let s = 1; s <= moves; s++) {
    const t = s / moves;
    const jitter = s === moves ? 0 : 9; // a hand misses its waypoints
    const x = Math.round(from.x + (at.x - from.x) * t + (s === moves ? 0 : (Math.random() * 2 - 1) * jitter));
    const y = Math.round(from.y + (at.y - from.y) * t - 20 * Math.sin(Math.PI * t)); // a slight arc, like a hand
    await ff.moveTo(x, y, 80);
    pointerNow = { x, y };
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
    // Motion measured against the landing on this machine's clock: how many drift-moves the pointer
    // made while the board was refreshing, how many of them before the row appeared, and how many in
    // the last second before the button went down. A recorder that waits for the page to settle: 0.
    lookMoves: lookNotes.length,
    lookMovesBeforeLand: landed ? lookNotes.filter((n) => n.ms <= landed.atMs).length : lookNotes.length,
    movesLastSecond: lookNotes.concat(stepNotes).filter((n) => n.ms > pressedAtMs - 1000 && n.ms <= pressedAtMs).length,
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
let park = null; // race mode: the row the hand rests on, its button rect, the coordinates it presses
let clickDeadline = Infinity; // the board has to answer the press within this long, or the take stops

let expected = null; // the incident this take means to ack: the one that landed
let got = null; // the incident the board actually shows acked, with a receipt it did not have before


try {
  await ff.start();
  await ff.url(url);
  await watchPointerEvents();
  // Which build the camera is looking at. <meta name="build"> is the very element scripts/verify.mjs
  // compares with the sha the deploy reports, so the take and the gate name the same build by
  // construction. A take that does not name its page cannot be repeated: nobody would know which build
  // the camera actually saw, and "it runs" would be a claim about nothing.
  take.build = await ff.js(`return {
    meta: (document.querySelector('meta[name="build"]') || {}).content || null,
    footer: (document.querySelector('[data-testid="build-sha"]') || {}).textContent
      ? document.querySelector('[data-testid="build-sha"]').textContent.trim() : null,
  };`).catch(() => null);

  for (let i = 0; i < maxFrames; i++) {
    if (!clicked && Date.now() > waitUntil) {
      note = `giving up: no incident landed within ${watchS}s of watching`;
      break;
    }
    const spent = Date.now();
    if (race && clicked && !changeFrame && Date.now() > clickDeadline) {
      note = `the press at ${clicked.clickXY.join(',')} got no receipt within 20s`;
      break;
    }
    await grab(note);
    if (firstAtMs === null) firstAtMs = take.frames[0].ms;

    const now = await ff.js(`return {
      rows: [...document.querySelectorAll('[data-testid="incident-row"]')].map(li => ({
        id: li.dataset.id,
        acked: !!li.querySelector('[data-testid="acked"]'),
        hasAck: !!li.querySelector('[data-testid="ack"]'),
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
          // Race mode: the hand goes to a row that is already here and stays there, so the board itself
          // has to be what changes what lies under the pointer.
          if (race && now.rows.length && !park) await parkOnRow();
          const watchedS = firstAtMs ? Math.round((take.frames[frame - 1].ms - firstAtMs) / 1000) : 0;
          note = race && park
            ? `${now.rows.length} incidents on the board; the pointer rests on ${park.meant}'s Ack and only trembles — ${watchedS}s of ${watchS}s waiting for the board to move a row under it`
            : now.rows.length
              ? `${now.rows.length} incidents on the board, none new yet — watching ${watchedS}s of ${watchS}s`
              : 'waiting for the board to answer';

        } else {
          // This row was not on screen when the camera opened: it landed on camera. Ack it now.
          landed = {
            id: fresh.id,
            openedAt: fresh.openedAt,
            frame,
            onCameraAt: take.frames[frame - 1].at,
            atMs: Date.now(),
            ageOnCameraS: Number(((Date.now() - Date.parse(fresh.openedAt)) / 1000).toFixed(1)),
          };
          take.landed = landed;
          const press = race ? await pressWhereIParked() : await pressAckLikeAPerson(fresh.id);
          if (press.ok) {
            // The honest age: from the incident opening to the button actually going down, which is a
            // few seconds after the row first showed — the pointer had to travel to it.
            const ageAtPress = Number(((Date.parse(press.at) - Date.parse(fresh.openedAt)) / 1000).toFixed(1));
            clicked = {
              id: race ? press.clickedId : fresh.id,
              at: press.at, ageAtClickS: ageAtPress, ageOnScreenS: landed.ageOnCameraS,
              via: 'pointer', trusted: press.trusted, hoverEvents: press.hovers,
              scriptedClicks: press.scriptedClicks, focusAfter: press.focus, clickXY: [press.x, press.y],
            };
            take.acked = clicked;
            if (race) take.race = press.race || null;
            clickDeadline = (press.pressedAtMs || Date.now()) + 20000;

            note = race
              ? `the Ack at ${park.x},${park.y} went down — those are ${park.meant}'s coordinates, measured before ${fresh.id} arrived, and the press is ${ageAtPress}s after it opened`
              : `${fresh.id} opened ${landed.ageOnCameraS}s ago and landed on camera — the pointer moved onto its Ack and pressed it ${ageAtPress}s after it opened`;

          } else {
            note = `${fresh.id} landed, but ${press.why} — this take stops here`;
            break;
          }
        }
      } else if (!changeFrame && !race) {
        // The race answers on its own terms: a click that left no receipt anywhere is the failure, not
        // a frame to wait through. Park the take and let the gate below report it.
        if (clicked && take.race) {
          note = `clicked at ${clicked.clickXY.join(',')} at ${clicked.at} and no row carries a new receipt`;
          break;
        }
      } else if (!changeFrame) {
        // The clean flow waits for the receipt on the row that was clicked. In the race the ack may
        // have landed anywhere, so the change is any row carrying a receipt the board did not have.
        const row = race ? newlyAcked[0] : now.rows.find((r) => r.id === clicked.id);
        if (row && row.acked && row.receipt && !receiptsBefore.has(row.receipt)) {
          changeFrame = frame;
          receipt = row.receipt;
          // The row this take MEANT: in the race it is the row the hand rested on, not the one that
          // arrived. Who actually GOT the ack is read off the board: every row carrying a receipt the
          // board did not have before the click.
          expected = race ? take.race.meant : clicked.id;
          got = newlyAcked.map((r) => r.id);
          take.expected = expected;
          take.got = got;
          note = got.length !== 1
            ? `new receipt on ${got.length ? got.join(', ') : 'no row'}; this take meant ${expected}`
            : got[0] !== expected
              ? `${got[0]} is acked, not ${expected} — the row meant had slid out from under the pointer, and the receipt sits on the row that took its place`
              : `${expected} shows acked — the new receipt is on that row and on no other`;

        } else {
          note = race
            ? `the Ack at ${clicked.clickXY.join(',')} went down and no row carries a new receipt yet`
            : `waiting for ${clicked.id} to come back acked`;
        }
      }
      // The row this take meant has to still be there, still offering its Ack: the ack went elsewhere
      // and nothing on the board says so.
      if (race && take.race && changeFrame) {
        const mr = now.rows.find((row) => row.id === take.race.meant);
        if (mr) take.race.meantStillOffersAck = !mr.acked && mr.hasAck === true;
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

    // Looking at the board while waiting: the pointer moves every frame, so nothing here reads as a
    // still cursor waiting for the page to hold still before it acts.
    if (race && !clicked && park) {
      await tremorOnButton();
    } else if (flow === 'ack-incident' && !clicked && now.rows.length) await lookAround();

    const cost = Date.now() - spent;
    const pace = flow === 'ack-incident' && !clicked ? slowFps : fps; // slow while waiting, fast once it lands
    const waitMs = Math.max(30, Math.round(1000 / pace) - cost);
    if (race && !clicked && park && now.rows.length) {
      // The hand rests on the button while the board refreshes on its own. The camera keeps its 1
      // frame/s pace, but the list is re-read every 120 ms, so the press follows the board's insert
      // closely instead of waiting for the next frame. Re-reading a page presses nothing: the board is
      // the only thing here that moves the list.
      const known = new Set(now.rows.map((row) => row.id));
      const until = Date.now() + waitMs;
      for (;;) {
        await sleep(Math.min(120, Math.max(20, until - Date.now())));
        if (Date.now() >= until) break;
        const ids = await ff.js(`return [...document.querySelectorAll('[data-testid="incident-row"]')].map((li) => li.dataset.id);`);
        if (ids.some((id) => !known.has(id))) break; // a row arrived: the next frame sees it, then presses
      }
      continue;
    }
    await sleep(waitMs);

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

// A take has to name the page it was recorded against, or nobody can repeat it. Both places the page
// prints its build are read off the page the camera watched; scripts/verify.mjs compares that meta with
// the sha the deploy reports. If they disagree, the page is lying about its build and the take says so.
take.sha = take.build && take.build.meta ? take.build.meta : null;
take.short = take.sha ? take.sha.slice(0, 12) : null;
if (take.build && take.build.meta && take.build.footer && take.build.footer !== take.build.meta) {
  console.log(`take: the page's footer build ${take.build.footer} contradicts its meta ${take.build.meta}`);
}
console.log(take.sha
  ? `take: the board under the camera is build ${take.short}`
  : 'take: the board under the camera names NO build — this take cannot be pinned to a commit');

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
  console.log(`take: pointer drift-moved ${take.pointer.lookMoves} times while waiting — ${take.pointer.lookMovesBeforeLand} before ${take.landed ? take.landed.id : 'the row'} landed, ${take.pointer.movesLastSecond} moves in the last second before the button went down`);
} else {
  console.log('take: no pointer press in this take');
}
const pressedLikeAPerson = !!take.pointer && !!take.acked && take.acked.via === 'pointer' && take.acked.trusted === true;
// What the course asked for and this lane can fail on its own, before anyone submits: the pointer was
// already moving while the board changed, and the button went down in that row's first second.
const movedWhileChanging = !!take.pointer && take.pointer.lookMovesBeforeLand >= 2 && take.pointer.movesLastSecond >= 2;
const ackedInTime = !!take.acked && take.acked.ageAtClickS >= 0 && take.acked.ageAtClickS <= 1.5;
// The clean flow passes when the receipt sits on the row that landed. The race passes on the opposite:
// the press went to the coordinates the hand was measured on, an Ack button took that click, a row had
// just been inserted above, the meant row slid out from under the pointer and still offers its button —
// and the new receipt is on the row that took its place, not on the row the hand rested on.
const oneReceipt = Array.isArray(take.got) && take.got.length === 1 && !!take.expected;
const rr = take.race;
const parkedSpotPressed = !!rr && Array.isArray(rr.parkedXy) && !!take.acked && Array.isArray(take.acked.clickXY)
  && rr.parkedXy[0] === take.acked.clickXY[0] && rr.parkedXy[1] === take.acked.clickXY[1]
  && rr.clickTarget === 'ack';
const rowSlidUnder = !!rr && Number.isFinite(rr.pressAfterInsertMs) && rr.pressAfterInsertMs >= 0 && rr.pressAfterInsertMs <= 1500
  && (rr.shiftPx === null || rr.shiftPx >= 20) && rr.meantStillOffersAck === true
  && rr.underPointerRow === (Array.isArray(take.got) ? take.got[0] : null);
const wrongRow = oneReceipt && take.got[0] !== take.expected;
const cleanProofed = !!take.at && !!take.landed && !!take.acked && take.landed.id === take.expected
  && oneRow && pressedLikeAPerson && movedWhileChanging && ackedInTime;
const raceProofed = race && !!take.at && !!take.landed && !!take.acked && wrongRow
  && pressedLikeAPerson && movedWhileChanging && parkedSpotPressed && rowSlidUnder;
const proofed = race ? raceProofed : cleanProofed;
if (race && take.race) {
  const r = take.race;
  console.log(`take: the hand rested on ${r.meant}'s Ack at ${r.parkedXy.join(',')} from ${r.parkedAt} — ${r.tremors} tremors, the coordinates never re-aimed`);
  console.log(`take: the board inserted ${r.insertId} at ${r.insertAt}; the button went down ${r.pressAfterInsertMs}ms later, at the same spot`);
  console.log(`take: ${r.meant} slid ${r.shiftPx}px down out from under the pointer and still offers Ack (${r.meantStillOffersAck}); the click's own target was ${r.clickTarget} of ${r.underPointerRow}, the row under it now`);
}
const reasons = [];
if (!take.at || !take.acked) reasons.push('no ack appeared on the board in this take');
if (!pressedLikeAPerson) reasons.push('the ack was not pressed by a real pointer click the page reports as trusted');
if (!movedWhileChanging) reasons.push('the pointer stood still while the board was changing');
if (!oneReceipt) reasons.push('the new receipt is not on exactly one row');
if (race) {
  if (!wrongRow) reasons.push('the ack landed on the row the hand rested on — this take holds no race');
  if (!parkedSpotPressed) reasons.push('the press did not go to the parked coordinates, or no Ack button took it');
  if (!rowSlidUnder) reasons.push('no row was inserted under the pointer just before the press, or the meant row slid nowhere / lost its button');
} else if (!ackedInTime) {
  reasons.push(`the button went down ${take.acked && take.acked.ageAtClickS}s after the row landed, not in its first second`);
}
console.log(proofed ? 'result: ok' : `result: FAIL — ${reasons.join('; ')}`);
process.exit(proofed ? 0 : 1);

