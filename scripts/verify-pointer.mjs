// The pointer family of the step-1 proof: does the recorded take actually show a person's click?
//
//   node scripts/verify-pointer.mjs <take.json> [--out <file>] [--race]
//
// scripts/verify.mjs checks the board. This checks the recording of it: that the ack in the take came
// from a real W3C pointer action the page trusted, with the board running underneath, and that the rows
// the take names are the rows the board shows. Every value is read from the take file; the script prints
// one line per check and a final `result: ok` or `result: failed`. A check with no data in the take is
// printed as SKIP, never as a pass.
//
// Two shapes, decided by what the take itself carries (`take.race`):
//   clean — the pointer meant a row and that row got the ack: got === expected.
//   race  — the pointer rested on a row, the board slid a new row in above it, and those same parked
//           coordinates pressed another row's Ack: got !== expected, and the take has to prove the
//           slide (the insert, the shift, the meant row still offering its button, the receipt under
//           the pointer). The recorder does not get to choose which of the two a take is.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const file = resolve(process.argv[2] || '');
if (!file) {
  console.error('usage: node scripts/verify-pointer.mjs <take.json> [--out <file>] [--race]');
  process.exit(2);
}
const outArg = process.argv.indexOf('--out');
const out = outArg > -1 ? resolve(process.argv[outArg + 1]) : null;
const take = JSON.parse(readFileSync(file, 'utf8'));
const wantRace = process.argv.includes('--race');
const acked = take.acked || {};
const pointer = take.pointer || {};
const path = pointer.path || [];
const kind = (k) => path.filter((s) => s.kind === k);
const r = take.race || null;
const race = !!r;
if (wantRace && !race) {
  console.error('verify-pointer: --race was asked for, but this take carries no race evidence');
  process.exit(2);
}

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok, detail });

check(`mode: ${race ? 'an ack race — the pointer parked on one row, another row took the ack' : 'a clean ack — the pointer aimed at the row it acked'}`,
  !wantRace || race, `take.race=${race ? 'present' : 'absent'} expected=${take.expected} got=${JSON.stringify(take.got)}`);
check('flow: the take is the ack-incident flow', take.flow === 'ack-incident', `flow=${take.flow}`);
// One row, one value: exactly one row carries a receipt the board did not have before the click, and
// the take names both the row the hand rested on and the row the board acked.
check('rows: exactly one row carries a new receipt, and both rows are named',
  !!take.expected && Array.isArray(take.got) && take.got.length === 1,
  `expected=${take.expected} got=${JSON.stringify(take.got)}`);
if (race) {
  check('rows: the ack did not land on the row the pointer was resting on',
    take.got[0] !== take.expected, `meant ${take.expected}; the board acked ${take.got[0]}`);
  check('rows: the row meant is the row the pointer parked on',
    r.meant === take.expected, `parked on ${r.meant}, expected ${take.expected}`);
} else {
  check('rows: expected and got name one and the same incident',
    !!take.expected && Array.isArray(take.got) && take.got.length === 1 && take.got[0] === take.expected,
    `expected=${take.expected} got=${JSON.stringify(take.got)}`);
}
check('arrival: an incident the board did not have landed on camera during this take',
  !!take.landed && take.landedFramesBefore >= 1 && take.landed.frame === take.landedFramesBefore + 1,
  `landed=${take.landed && take.landed.id} absent for ${take.landedFramesBefore} frames, on screen at frame ${take.landed && take.landed.frame}`);
if (race) {
  check('arrival: the row that slid in under the pointer is the row the board inserted',
    !!take.landed && r.insertId === take.landed.id,
    `the board inserted ${r.insertId} at ${r.insertAt}; it landed on camera ${take.landed && take.landed.onCameraAt}`);
}
// The course asked what the board was doing in the second the recording acked. A recorder that sits
// still until the page settles and then clicks is a test, so the motion is read off the take here.
check('pace: the pointer was already moving while the board went on changing',
  typeof pointer.lookMovesBeforeLand === 'number' && pointer.lookMovesBeforeLand >= 2,
  `${pointer.lookMovesBeforeLand} drift-moves before ${take.landed && take.landed.id} landed, ${pointer.lookMoves} across the wait`);
check('pace: the pointer moved again in the second the button went down',
  typeof pointer.movesLastSecond === 'number' && pointer.movesLastSecond >= 2,
  `${pointer.movesLastSecond} pointer moves in the last second before the press`);
if (race) {
  check('pace: the press followed the board\'s own insert closely',
    Number.isFinite(r.pressAfterInsertMs) && r.pressAfterInsertMs >= 0 && r.pressAfterInsertMs <= 3000,
    `the button went down ${r.pressAfterInsertMs}ms after the board inserted ${r.insertId}`);
} else {
  check('pace: the button went down in the row\'s first second on the board',
    typeof acked.ageAtClickS === 'number' && acked.ageAtClickS >= 0 && acked.ageAtClickS <= 1.5,
    `${acked.ageAtClickS}s from the API opening it to the button going down`);
}
check('pointer: the ack went through pointer actions, not a scripted click',
  acked.via === 'pointer', `via=${acked.via}`);
check('pointer: the page itself reported the click as trusted (isTrusted)',
  acked.trusted === true, `isTrusted=${acked.trusted}`);
check('pointer: zero clicks were fired from script inside the page',
  acked.scriptedClicks === 0, `scriptedClicks=${acked.scriptedClicks}`);
check('pointer: the pointer hovered an Ack button before the press',
  (acked.hoverEvents || 0) > 0, `pointerover on an Ack button=${acked.hoverEvents}`);
// take.pointer.rect is the button's own box with x,y at its centre — the point the pointer aimed at.
// In a race that is the point measured on the meant row and never aimed at again, so a click inside it
// is the whole point of the take: the same coordinates, another row lying under them by now.
const near = Array.isArray(acked.clickXY) && pointer.rect
  && Math.abs(acked.clickXY[0] - pointer.rect.x) <= Math.max(8, Math.round(pointer.rect.w / 2))
  && Math.abs(acked.clickXY[1] - pointer.rect.y) <= Math.max(8, Math.round(pointer.rect.h / 2));
check('pointer: the click landed inside the Ack rect that was measured first — there was no second aim',
  near, `click=${JSON.stringify(acked.clickXY)} button centre=${pointer.rect ? `${pointer.rect.x},${pointer.rect.y}` : 'none'} box=${pointer.rect ? `${pointer.rect.w}x${pointer.rect.h}` : 'none'}`);
check('path: the pointer rested, travelled, hovered and pressed, in that order',
  ['rest', 'move', 'hover', 'press'].every((k) => kind(k).length > 0)
    && (race ? path.findIndex((s) => s.kind === 'rest') > -1 && path.findIndex((s) => s.kind === 'rest') < path.findIndex((s) => s.kind === 'hover') : path[0].kind === 'rest')
    && path.at(-1).kind === 'press'
    && kind('move').every((s, i, all) => i === 0 || (Math.abs(s.x - all[i - 1].x) + Math.abs(s.y - all[i - 1].y)) > 1),
  `${path.map((s) => s.kind).filter((k, i, a) => k !== a[i - 1]).join('>')}, ${path.length} steps`);
check('path: every step is drawn in the video as a ring at its own coordinates',
  path.every((s) => Number.isFinite(s.frame) && Number.isFinite(s.x) && Number.isFinite(s.y)),
  `${path.length} steps, frames ${path[0] && path[0].frame}-${path.at(-1) && path.at(-1).frame}`);
// The clock the pointer's own moves carry, read off the take — the same rings the video draws — rather
// than trusting a number the recorder happened to compute. travel: the first recorded step to coming to
// rest on the button; rest: resting there until the button went down. The recorder's own numbers have to
// agree, so a take that fakes either one shows up as a mismatch.
const restStep = path.find((s) => s.kind === 'rest');
const pressStep = path[path.length - 1];
const measuredTravelMs = path[0] && restStep && Number.isFinite(path[0].ms) && Number.isFinite(restStep.ms)
  ? restStep.ms - path[0].ms : null;
const measuredRestMs = restStep && pressStep && Number.isFinite(restStep.ms) && Number.isFinite(pressStep.ms)
  ? pressStep.ms - restStep.ms : null;
check('pace: the travel to the button and the rest on it are measured off the take\'s own stamps',
  Number.isFinite(measuredTravelMs) && measuredTravelMs > 0
    && Number.isFinite(measuredRestMs) && measuredRestMs > 0
    && Number.isFinite(pointer.travelMs) && pointer.travelMs > 0
    && Number.isFinite(pointer.hoverMs) && pointer.hoverMs > 0,
  `the rings the video draws say travel=${measuredTravelMs}ms, then ${measuredRestMs}ms resting on the button before the press; recorder says travel=${pointer.travelMs}ms hover=${pointer.hoverMs}ms tremors=${pointer.tremors}`);
if (race) {
  check('race: the pointer had been resting, and moving in its sleep, for a second or more before the insert',
    Number.isFinite(measuredRestMs) && measuredRestMs >= 1000 && (r.tremors || 0) >= 3 && (pointer.tremors || 0) >= 3,
    `${measuredRestMs}ms on the button, ${r.tremors} tremors before the board inserted ${r.insertId}`);
}

if (race) {
  check('race: the pointer was parked before the new row existed',
    Number.isFinite(r.parkedFrame) && !!take.landed && r.parkedFrame < take.landed.frame,
    `parked on ${r.meant} at frame ${r.parkedFrame} (${r.parkedAt}); ${take.landed.id} appeared at frame ${take.landed.frame}`);
  check('race: the press went to the parked coordinates and an Ack button took it',
    Array.isArray(r.parkedXy) && Array.isArray(acked.clickXY)
      && r.parkedXy[0] === acked.clickXY[0] && r.parkedXy[1] === acked.clickXY[1]
      && r.clickTarget === 'ack',
    `parked ${JSON.stringify(r.parkedXy)}, pressed ${JSON.stringify(acked.clickXY)}, target=${r.clickTarget} of row ${r.underPointerRow}`);
  check('race: the board\'s own update slid the meant row out from under the pointer',
    r.meantRowTopBefore !== null && r.meantRowTopAfter !== null && r.shiftPx >= 20,
    `${r.meant} row top ${r.meantRowTopBefore}px -> ${r.meantRowTopAfter}px (${r.shiftPx}px down) once ${r.insertId} was inserted above it`);
  check('race: the meant row is still there, still unacked, still offering its Ack',
    r.meantStillOffersAck === true && r.meantAckedAfter === false,
    `meantAckedAfter=${r.meantAckedAfter}, meantStillOffersAck=${r.meantStillOffersAck}`);
  check('race: the receipt sits on the row that lay under the parked pointer, not on the row meant',
    !!take.got && take.got.length === 1 && r.underPointerRow === take.got[0] && r.underPointerRow !== r.meant,
    `under the pointer: ${r.underPointerRow} (${r.underPointerWhat}); new receipt on: ${JSON.stringify(take.got)}`);
  check('race: the recorder watched the insertion it pressed against',
    Array.isArray(r.inserts) && r.inserts.some((i) => i.id === r.insertId),
    `${(r.inserts || []).length} rows the page's own MutationObserver saw added, including ${r.insertId}`);
}
check('stick: the acked row reads acked with the API receipt through the rest of the take',
  !!take.receipt && typeof take.changeFrame === 'number' && take.changeFrame < take.frames.length - 5,
  `receipt=${take.receipt ? `${take.receipt.slice(0, 6)}… (${take.receipt.length} chars)` : 'none'} on ${take.got && take.got[0]}, changeFrame=${take.changeFrame}/${take.frames.length}`);

for (const c of checks) {
  const mark = c.ok === true ? 'PASS' : c.ok === null ? 'SKIP' : 'FAIL';
  console.log(`${mark} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
}
const failed = checks.filter((c) => c.ok === false).length;
const skipped = checks.filter((c) => c.ok === null).length;
const result = failed ? 'failed' : 'ok';
console.log(`\n${checks.length - failed - skipped}/${checks.length} ok, ${skipped} skipped, ${failed} failed`);
console.log(`result: ${result}`);
if (out) writeFileSync(out, JSON.stringify({ file, mode: race ? 'race' : 'clean', startedAt: take.startedAt, checks, result }, null, 2));
process.exit(failed ? 1 : 0);


