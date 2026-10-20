#!/usr/bin/env node
// One-command local run (demo on your own computer):  npm run local
//  - needs Docker (Docker Desktop on Windows/macOS) and Node >= 20
//  - builds the sandbox image on the first run (a few minutes, ~1.5 GB)
//  - creates .env.local with a random SANDBOX_JWT_SECRET (printed so you can copy it to Full-API)
//  - starts the gateway on http://localhost:8787 (previews at http://<id>.localhost:8787)
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = join(root, '.env.local');
const IMAGE = 'uip-sandbox:latest';
const die = (m) => { console.error(`\n✗ ${m}\n`); process.exit(1); };
const docker = (args, opts = {}) => spawnSync('docker', args, { encoding: 'utf8', ...opts });

const v = docker(['version', '--format', '{{.Server.Version}}']);
if (v.error || v.status !== 0) die('Docker is not running. Start Docker Desktop (or the docker service) and try again.');

// settings file
let env = {};
if (existsSync(ENV_FILE)) {
  for (const line of readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) { const m = /^([A-Z_]+)=(.*)$/.exec(line.trim()); if (m) env[m[1]] = m[2]; }
}
if (!env.SANDBOX_JWT_SECRET || env.SANDBOX_JWT_SECRET.length < 32) {
  env.SANDBOX_JWT_SECRET = randomBytes(32).toString('hex');
  writeFileSync(ENV_FILE, [
    `SANDBOX_JWT_SECRET=${env.SANDBOX_JWT_SECRET}`,
    'ALLOWED_ORIGINS=https://uip-nub.vercel.app,http://localhost:5173',
    'PREVIEW_DOMAIN=localhost:8787',
    'PREVIEW_SCHEME=http',
    'MAX_SESSIONS=2',
    '',
  ].join('\n'));
  console.log(`Created ${ENV_FILE}`);
  env = Object.fromEntries(readFileSync(ENV_FILE, 'utf8').split(/\r?\n/).map((l) => /^([A-Z_]+)=(.*)$/.exec(l.trim())).filter(Boolean).map((m) => [m[1], m[2]]));
}

// Keep the allowed origins current even when .env.local already exists (it was created by an older run):
// the deployed site must always be in the list or the gateway refuses its WebSocket.
{
  const REQUIRED = ['https://uip-nub.vercel.app', 'http://localhost:5173', 'http://localhost:4173'];
  const have = String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter((s) => s && s !== 'https://uip-v1.vercel.app');
  const next = [...new Set([...REQUIRED, ...have])].join(',');
  if (next !== env.ALLOWED_ORIGINS) {
    env.ALLOWED_ORIGINS = next;
    const lines = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8').split(/\r?\n/) : [];
    const i = lines.findIndex((l) => l.startsWith('ALLOWED_ORIGINS='));
    if (i >= 0) lines[i] = `ALLOWED_ORIGINS=${next}`; else lines.splice(Math.max(0, lines.length - 1), 0, `ALLOWED_ORIGINS=${next}`);
    writeFileSync(ENV_FILE, lines.join('\n'));
    console.log('Updated ALLOWED_ORIGINS in .env.local');
  }
}

// image
const IMAGE_REV = '2'; // bump when image/Dockerfile changes (rev 2 = PHP 8.4): an older local image is rebuilt automatically
const have = docker(['image', 'inspect', '--format', '{{ index .Config.Labels "uip.sandbox.rev" }}', IMAGE]);
if (have.status === 0 && have.stdout.trim() !== IMAGE_REV) console.log('The sandbox image is out of date (new PHP version) — rebuilding it…');
if (have.status !== 0 || have.stdout.trim() !== IMAGE_REV) {
  console.log('Building the sandbox image (first run only — this takes a few minutes)…');
  const b = spawnSync('docker', ['build', '-t', IMAGE, join(root, 'image')], { stdio: 'inherit' });
  if (b.status !== 0) die('Image build failed.');
}

console.log(`
──────────────────────────────────────────────────────────────
 Put these two variables on Railway (Full-API) and redeploy:

   SANDBOX_URL=http://localhost:8787
   SANDBOX_JWT_SECRET=${env.SANDBOX_JWT_SECRET}

 Keep this window open while you demo. Ctrl+C stops everything.
──────────────────────────────────────────────────────────────
`);
const child = spawn(process.execPath, [join(root, 'src', 'server.js')], { stdio: 'inherit', env: { ...process.env, ...env, PORT: '8787' } });
const stop = () => child.kill('SIGINT');
process.on('SIGINT', stop); process.on('SIGTERM', stop);
child.on('exit', (c) => process.exit(c ?? 0));
