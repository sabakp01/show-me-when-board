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
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = resolve(opts.out || '..', '.tmp', `take-${flow}-${stamp}`);
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

function ffmpegRun(args, label) {
  const r = spawnSync(ffmpegPath(), args, { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) {
    const tail = (r.stderr || '').split('\n').filter(Boolean).slice(-6).join(' | ');
    throw new Error(`ffmpeg ${label} failed (${r.status}): ${tail}`);
  }
  return r;
}

const take = { flow, url, fps, startedAt: new Date().toISOString(), frames: [], outDir };
