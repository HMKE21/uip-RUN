// Preview links are capability URLs (128-bit id, no login): they must not be indexable, and guessing ids must get an IP blocked.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { tok } from './helpers.js';

const PORT = 20000 + Math.floor(Math.random() * 20000);
const ORIGIN = 'http://localhost:5173';
let gw; let logs = '';
const get = (host) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port: PORT, path: '/', headers: { host } }, (r) => { let b = ''; r.on('data', (d) => { b += d; }); r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, body: b })); }).on('error', reject);
});
before(async () => {
  gw = spawn('node', ['src/server.js'], { env: { ...process.env, PORT: String(PORT), SANDBOX_JWT_SECRET: 'x'.repeat(40), SANDBOX_PROVIDER: 'local', PREVIEW_DOMAIN: `localhost:${PORT}`, ALLOWED_ORIGINS: ORIGIN, MAX_PREVIEW_MISSES: '5', STATE_DIR: mkdtempSync(join(tmpdir(), 'ph-state-')) }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => { gw.stdout.on('data', (d) => { logs += d; if (String(d).includes('listening')) resolve(); }); gw.on('exit', () => reject(new Error('gateway exited'))); setTimeout(() => reject(new Error('no start')), 10000); });
});
after(() => { gw?.kill('SIGKILL'); });

test('a live preview is marked noindex, its first viewer is logged; then guessing unknown ids gets the IP blocked (429)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ph-')); writeFileSync(join(dir, 'index.html'), '<h1>hi</h1>');
  execFileSync('zip', ['-q', '-r', join(dir, 'p.zip'), '.', '-x', 'p.zip'], { cwd: dir });
  const zip = execFileSync('cat', [join(dir, 'p.zip')]);
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { origin: ORIGIN } });
  const msgs = []; ws.on('message', (d, bin) => { if (!bin) msgs.push(JSON.parse(String(d))); });
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ t: 'auth', token: tok({ aud: 'uip-sandbox', sub: 'u1', pid: 'p1', exp: Math.floor(Date.now() / 1000) + 60, jti: 'preview-hard-0001' }) }));
  await new Promise((r) => setTimeout(r, 300));
  ws.send(JSON.stringify({ t: 'init', kind: 'static', entry: '', cols: 80, rows: 24 }));
  const until = async (pred) => { for (let i = 0; i < 300; i++) { const m = msgs.find(pred); if (m) return m; await new Promise((r) => setTimeout(r, 50)); } throw new Error('timeout'); };
  await until((m) => m.t === 'send-files'); ws.send(zip);
  const sid = (await until((m) => m.t === 'session')).id;
  await until((m) => m.t === 'preview' && m.url);
  const ok = await get(`${sid}.localhost:${PORT}`);
  assert.equal(ok.status, 200); assert.match(ok.headers['x-robots-tag'], /noindex/);
  assert.match(logs, /"event":"preview_viewer"/);
  for (let i = 0; i < 5; i++) { const r = await get(`${'0'.repeat(31)}${i}.localhost:${PORT}`); assert.equal(r.status, 404); assert.match(r.headers['x-robots-tag'], /noindex/); }
  assert.equal((await get(`${'0'.repeat(31)}9.localhost:${PORT}`)).status, 429);
  ws.close();
});
