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
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
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

const seen = new Set(); // incidents that were on screen last frame
let firstAtMs = null;
let clicked = null; // the incident this take acks
let receipt = null;
let changeFrame = null; // the frame where the flow's state change is on screen
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

try {
  await ff.start();
  await ff.url(url);

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
          const clickedId = await ff.js(`const li = document.querySelector('[data-testid="incident-row"][data-id="${fresh.id}"]');
            const b = li && li.querySelector('[data-testid="ack"]');
            if (!b) return null; b.click(); return li.dataset.id;`);
          if (clickedId) {
            clicked = { id: clickedId, at: new Date().toISOString(), ageAtClickS: landed.ageOnCameraS };
            take.acked = clicked;
            note = `${fresh.id} landed on camera ${landed.ageOnCameraS}s after it opened — Ack pressed on it`;
          } else {
            note = `${fresh.id} landed but its row offered no Ack button`;
          }
        }
      } else if (!changeFrame) {
        const row = now.rows.find((r) => r.id === clicked.id);
        if (row && row.acked) {
          changeFrame = frame;
          receipt = row.receipt;
          note = `${clicked.id} shows acked - receipt on screen`;
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
// The browser's viewport can land on an odd height (Firefox full-page capture did: 1280x815), and
// yuv420p needs even edges — so the frames are rounded down to even before anything is drawn on them.
const filters = ['scale=trunc(iw/2)*2:trunc(ih/2)*2', ...draw];
if (filters.length) args.push('-vf', filters.join(','));
args.push('-r', '30', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', 'take.mp4');
ffmpegRun(args, 'cut', outDir); // frames, list and font all stay relative to the take folder

writeFileSync(resolve(outDir, 'take.json'), `${JSON.stringify(take, null, 2)}\n`);

const secs = take.frames.length ? take.frames[take.frames.length - 1].elapsedS : 0;
console.log(`take: ${take.frames.length} frames over ${secs}s from Firefox at ${url}`);
console.log(`take: video ${video}`);
console.log(`take: detail ${resolve(outDir, 'take.json')}`);
if (take.landed) {
  console.log(`take: ${take.landed.id} opened ${take.landed.openedAt}; not on screen for the first ${take.landedFramesBefore} frames; first on camera at ${take.atLanded}, ${take.landed.ageOnCameraS}s after it opened`);
  console.log(`take: Ack pressed on it at ${take.atClicked}, ${take.acked.ageAtClickS}s after it opened`);
}
console.log(take.at ? `take: state change on screen at ${take.at} (${take.frames[changeFrame - 1].at})` : 'take: no state change seen');
// For this flow the proof is the pair: an incident that arrived while the camera was running, and the
// ack on that row. One without the other is what got the first take refused.
const proofed = take.at && take.landed && take.acked && take.landed.id === take.acked.id;
console.log(proofed ? `result: ok` : `result: FAIL — ${take.landed ? 'acked row is not the row that landed' : 'no incident landed on camera in this take'}`);
process.exit(proofed ? 0 : 1);
