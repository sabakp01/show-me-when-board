// The pointer family of the step-1 proof: does the recorded take actually show a person's click?
//
//   node scripts/verify-pointer.mjs <take.json> [--out <file>]
//
// scripts/verify.mjs checks the board. This checks the recording of it: that the ack in the take came
// from a real W3C pointer action the page trusted, on the row the take meant to ack, with the board
// running underneath. Every value is read from the take file; the script prints one line per check and
// a final `result: ok` or `result: failed`. A check with no data in the take is printed as SKIP, never
// as a pass.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const file = resolve(process.argv[2] || '');
if (!file) {
  console.error('usage: node scripts/verify-pointer.mjs <take.json> [--out <file>]');
  process.exit(2);
}
const outArg = process.argv.indexOf('--out');
const out = outArg > -1 ? resolve(process.argv[outArg + 1]) : null;
const take = JSON.parse(readFileSync(file, 'utf8'));

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok, detail });

const acked = take.acked || {};
const pointer = take.pointer || {};
const path = pointer.path || [];
const kind = (k) => path.filter((s) => s.kind === k);

check('flow: the take is the ack-incident flow', take.flow === 'ack-incident', `flow=${take.flow}`);
check('rows: expected and got name one and the same incident',
  !!take.expected && Array.isArray(take.got) && take.got.length === 1 && take.got[0] === take.expected,
  `expected=${take.expected} got=${JSON.stringify(take.got)}`);
check('arrival: the incident was absent from the board for the first frames, then landed on camera',
  !!take.landed && take.landed.id === take.expected
    && take.landedFramesBefore >= 1 && take.landed.frame === take.landedFramesBefore + 1,
  `landed=${take.landed && take.landed.id} absent for ${take.landedFramesBefore} frames, on screen at frame ${take.landed && take.landed.frame}`);

check('pointer: the ack went through pointer actions, not a scripted click',
  acked.via === 'pointer', `via=${acked.via}`);
check('pointer: the page itself reported the click as trusted (isTrusted)',
  acked.trusted === true, `isTrusted=${acked.trusted}`);
check('pointer: zero clicks were fired from script inside the page',
  acked.scriptedClicks === 0, `scriptedClicks=${acked.scriptedClicks}`);
check('pointer: the pointer hovered the button before pressing it',
  (acked.hoverEvents || 0) > 0, `pointerover on that button=${acked.hoverEvents}`);
// take.pointer.rect is the button's own box with x,y at its centre — the point the pointer aimed at,
// the same window the recorder's own gate accepts a click in (half the button's width and height).
const near = Array.isArray(acked.clickXY) && pointer.rect
  && Math.abs(acked.clickXY[0] - pointer.rect.x) <= Math.max(8, Math.round(pointer.rect.w / 2))
  && Math.abs(acked.clickXY[1] - pointer.rect.y) <= Math.max(8, Math.round(pointer.rect.h / 2));
check('pointer: the page reported the click inside the Ack button of the expected row',
  near, `click=${JSON.stringify(acked.clickXY)} button centre=${pointer.rect ? `${pointer.rect.x},${pointer.rect.y}` : 'none'} box=${pointer.rect ? `${pointer.rect.w}x${pointer.rect.h}` : 'none'}`);

check('path: the pointer rested, travelled, hovered and pressed, in that order',
  ['rest', 'move', 'hover', 'press'].every((k) => kind(k).length > 0)
    && path[0].kind === 'rest' && path.at(-1).kind === 'press'
    && kind('move').every((s, i, all) => i === 0 || (Math.abs(s.x - all[i - 1].x) + Math.abs(s.y - all[i - 1].y)) > 1),
  `${path.map((s) => s.kind).join('>')}`);
check('path: every step is drawn in the video as a ring at its own coordinates',
  path.every((s) => Number.isFinite(s.frame) && Number.isFinite(s.x) && Number.isFinite(s.y)),
  `${path.length} steps, frames ${path[0] && path[0].frame}-${path.at(-1) && path.at(-1).frame}`);
check('pace: the travel and the rest are measured from the take\'s own frames, not from the code',
  Number.isFinite(pointer.travelMs) && Number.isFinite(pointer.hoverMs) && pointer.travelMs > 0 && pointer.hoverMs > 0,
  `travel=${pointer.travelMs}ms hover=${pointer.hoverMs}ms moves=${pointer.moves}`);
check('stick: the row reads acked with the API receipt through the rest of the take',
  !!take.receipt && typeof take.changeFrame === 'number'
    && take.changeFrame < take.frames.length - 5,
  `receipt=${take.receipt ? `${take.receipt.slice(0, 6)}… (${take.receipt.length} chars)` : 'none'} changeFrame=${take.changeFrame}/${take.frames.length}`);

for (const c of checks) {
  const mark = c.ok === true ? 'PASS' : c.ok === null ? 'SKIP' : 'FAIL';
  console.log(`${mark} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
}
const failed = checks.filter((c) => c.ok === false).length;
const skipped = checks.filter((c) => c.ok === null).length;
const result = failed ? 'failed' : 'ok';
console.log(`\n${checks.length - failed - skipped}/${checks.length} ok, ${skipped} skipped, ${failed} failed`);
console.log(`result: ${result}`);
if (out) writeFileSync(out, JSON.stringify({ file, startedAt: take.startedAt, checks, result }, null, 2));
process.exit(failed ? 1 : 0);
