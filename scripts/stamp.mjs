// Fill app/config.js (API + session) and name the build in app/index.html — plan.md R6.
//
//   node scripts/stamp.mjs                 # sha from `git rev-parse HEAD`
//   node scripts/stamp.mjs --sha $GITHUB_SHA
//   node scripts/stamp.mjs --check         # only report, exit 1 when the build is not named
//
// The session is read from show-me-when/session.txt (never typed into a command line) and
// written into app/config.js, which is what the board sends to the API as ?t=.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://hq.mega.dev/challenges/show-me-when/api';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? null : args[i + 1];
};

const shaOf = () => {
  const fromFlag = flag('sha') || process.env.BUILD_SHA;
  if (fromFlag) return fromFlag.trim();
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
};

const sessionFile = resolve(ROOT, flag('session') || join('..', 'session.txt'));
const sha = shaOf();
if (!/^[0-9a-f]{7,40}$/.test(sha)) {
  console.error(`stamp: not a git sha: ${sha}`);
  process.exit(2);
}

const htmlPath = join(ROOT, 'app', 'index.html');
const configPath = join(ROOT, 'app', 'config.js');

const check = args.includes('--check');
const problems = [];

if (check) {
  const html = readFileSync(htmlPath, 'utf8');
  const config = readFileSync(configPath, 'utf8');
  const meta = html.match(/<meta name="build" content="([^"]*)"/)?.[1];
  const foot = html.match(/<span data-testid="build-sha">([^<]*)</)?.[1];
  if (meta !== sha) problems.push(`meta build "${meta}" != ${sha}`);
  if (foot !== sha) problems.push(`build-sha footer "${foot}" != ${sha}`);
  if (!config.includes(`export const API = '${API}'`)) problems.push('config.js API is not the course api');
  if (!/export const SESSION = 'v1\.[A-Za-z0-9._-]+'/.test(config)) problems.push('config.js SESSION is not filled');
  for (const p of problems) console.log(`FAIL ${p}`);
  console.log(problems.length ? `result: not ok` : `result: ok · build ${sha}`);
  process.exit(problems.length ? 1 : 0);
}

const writeConfig = (session, from) => {
  if (!session.startsWith('v1.')) {
    console.error(`stamp: the session read from ${from} is not a session token`);
    process.exit(2);
  }
  writeFileSync(
    configPath,
    `// Where the board reads from. Filled by scripts/stamp.mjs — do not edit by hand.\n` +
      `// The board sends SESSION to the API as ?t= (see app/api.js).\n` +
      `export const API = '${API}';\n` +
      `export const SESSION = '${session}';\n`,
  );
  console.log(`stamp: session read from ${from}`);
};

// A build runner has no session file: it gets the session as the BOARD_SESSION secret, and the
// file it writes is gitignored — the token never travels in git history, only in the built page.
const envSession = (process.env.BOARD_SESSION || '').trim();
if (envSession) {
  writeConfig(envSession, 'the BOARD_SESSION secret');
} else if (existsSync(sessionFile)) {
  writeConfig(readFileSync(sessionFile, 'utf8').trim(), sessionFile);
} else {
  // Nothing new to read: a filled app/config.js already on disk is what ships.
  const config = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
  if (!/export const SESSION = 'v1\./.test(config)) {
    console.error(`stamp: no BOARD_SESSION, no session file at ${sessionFile}, and app/config.js holds no session`);
    process.exit(2);
  }
  console.log('stamp: keeping the session already in app/config.js');
}

let html = readFileSync(htmlPath, 'utf8');
html = html.replace(/<meta name="build" content="[^"]*"/, `<meta name="build" content="${sha}"`);
html = html.replace(
  /<span data-testid="build-sha">[^<]*</,
  `<span data-testid="build-sha">${sha}<`,
);
writeFileSync(htmlPath, html);

console.log(`stamp: build ${sha} · session from ${sessionFile}`);
console.log(`stamp: app/config.js filled, app/index.html names the build`);
