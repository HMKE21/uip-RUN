// End-to-end test of the gateway with the LOCAL provider (no Docker): token -> WebSocket -> upload zip -> terminal -> preview proxy.
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
const SECRET = 'x'.repeat(40);
const ORIGIN = 'http://localhost:5173';
let gw;

const claims = (extra = {}) => ({ aud: 'uip-sandbox', sub: String(Math.random()), pid: 'p1', exp: Math.floor(Date.now() / 1000) + 60, jti: Math.random().toString(16).slice(2), ...extra });
const makeZip = (files) => {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-'));
  for (const [n, c] of Object.entries(files)) writeFileSync(join(dir, n), c);
  execFileSync('zip', ['-q', '-r', join(dir, 'p.zip'), '.', '-x', 'p.zip'], { cwd: dir });
  return execFileSync('cat', [join(dir, 'p.zip')]);
};
const get = (host, path = '/') => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port: PORT, path, headers: { host } }, (r) => { let b = ''; r.on('data', (d) => { b += d; }); r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, body: b })); }).on('error', reject);
});
const connect = (token, origin = ORIGIN) => new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { origin } });
  ws.msgs = [];
  ws.on('message', (d, bin) => { if (!bin) ws.msgs.push(JSON.parse(String(d))); });
  // token travels in the first frame; a bad token makes the gateway close with 4401 right after
  ws.on('open', () => { ws.send(JSON.stringify({ t: 'auth', token })); setTimeout(() => (ws.readyState === 1 ? resolve(ws) : reject(new Error('401'))), 300); });
  ws.on('close', (code) => { if (code === 4401) reject(new Error('401')); });
  ws.on('error', reject);
});
const waitFor = async (ws, pred, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const m = ws.msgs.find(pred); if (m) return m; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error(`timeout; got: ${JSON.stringify(ws.msgs.map((m) => m.t))}`);
};

before(async () => {
  gw = spawn('node', ['src/server.js'], { env: { ...process.env, PORT: String(PORT), SANDBOX_JWT_SECRET: SECRET, SANDBOX_PROVIDER: 'local', STATE_DIR: mkdtempSync(join(tmpdir(), 'e2e-state-')), PREVIEW_DOMAIN: `localhost:${PORT}`, ALLOWED_ORIGINS: ORIGIN }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => { gw.stdout.on('data', (d) => { if (String(d).includes('listening')) resolve(); }); gw.on('exit', () => reject(new Error('gateway exited'))); setTimeout(() => reject(new Error('gateway did not start')), 10000); });
});
after(() => { gw?.kill('SIGKILL'); });

test('rejects a wrong origin and a bad token', async () => {
  await assert.rejects(connect(tok(claims()), 'https://evil.example'), /403/);
  await assert.rejects(connect('garbage'), /401/);
  await assert.rejects(new Promise((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=x`, { headers: { origin: ORIGIN } }); w.on('open', res); w.on('error', rej); }), /400/); // token in URL refused
  await assert.rejects(connect(tok(claims(), 'z'.repeat(40))), /401/);
});

test('runs a static project and proxies the preview (host-based routing, frame-ancestors, 404 after stop)', async () => {
  const ws = await connect(tok(claims()));
  ws.send(JSON.stringify({ t: 'init', kind: 'static', entry: '', cols: 80, rows: 24 }));
  await waitFor(ws, (m) => m.t === 'send-files');
  ws.send(makeZip({ 'index.html': '<h1>hello sandbox</h1>' }));
  const sess = await waitFor(ws, (m) => m.t === 'session');
  const prev = await waitFor(ws, (m) => m.t === 'preview' && m.url);
  assert.equal(prev.url, `http://${sess.id}.localhost:${PORT}`);
  assert.ok(ws.msgs.some((m) => m.t === 'out' && /Static site/.test(m.d)));

  const r = await get(`${sess.id}.localhost:${PORT}`);
  assert.equal(r.status, 200);
  assert.match(r.body, /hello sandbox/);
  assert.match(String(r.headers['content-security-policy']), new RegExp(`frame-ancestors ${ORIGIN}`));
  assert.equal((await get(`ffffffffffffffff.localhost:${PORT}`)).status, 404);

  ws.send(JSON.stringify({ t: 'stop' }));
  await waitFor(ws, (m) => m.t === 'closed');
  assert.equal((await get(`${sess.id}.localhost:${PORT}`)).status, 404);
});

test('shell sessions take input and can be resumed after a reconnect', async () => {
  const c = claims({ sub: 'resume-user' });
  const ws = await connect(tok(c));
  ws.send(JSON.stringify({ t: 'init', kind: 'shell', entry: '' }));
  await waitFor(ws, (m) => m.t === 'send-files');
  ws.send(makeZip({ 'a.txt': 'x' }));
  await waitFor(ws, (m) => m.t === 'session');
  ws.send(JSON.stringify({ t: 'input', d: 'echo MARK$((20+22))\n' }));
  await waitFor(ws, (m) => m.t === 'out' && /MARK42/.test(m.d));
  ws.close();
  await new Promise((r) => setTimeout(r, 200));

  const ws2 = await connect(tok({ ...c, jti: 'again-0123456789' }));
  ws2.send(JSON.stringify({ t: 'init', kind: 'shell', entry: '', resume: true }));
  await waitFor(ws2, (m) => m.t === 'session' && m.resumed);
  await waitFor(ws2, (m) => m.t === 'out' && /MARK42/.test(m.d)); // scrollback replayed
  ws2.send(JSON.stringify({ t: 'stop' }));
  await waitFor(ws2, (m) => m.t === 'closed');
});

test('invalid requests are refused', async () => {
  const ws = await connect(tok(claims()));
  ws.send(JSON.stringify({ t: 'init', kind: 'rm -rf /', entry: '' }));
  await waitFor(ws, (m) => m.t === 'error');
  ws.send(JSON.stringify({ t: 'init', kind: 'python', entry: '../../etc/passwd' }));
  await waitFor(ws, (m) => m.t === 'error' && m.text === 'Invalid request.');
  ws.close();
});

test('lang: a browser-style JavaScript file with an Arabic file name runs in the terminal and takes typed input', async () => {
  const ws = await connect(tok(claims()));
  ws.send(JSON.stringify({ t: 'init', kind: 'lang', entry: 'تمرين 1.js', cols: 100, rows: 24 }));
  await waitFor(ws, (m) => m.t === 'send-files');
  ws.send(makeZip({ 'تمرين 1.js': 'const n = prompt("Name:"); const a = Number(prompt("A:")); const b = Number(prompt("B:"));\nconsole.log("Hello, " + n + "! Sum = " + (a + b));\nalert("done " + (a + b));' }));
  await waitFor(ws, (m) => m.t === 'session');
  await waitFor(ws, (m) => m.t === 'out' && /Name:/.test(m.d));
  ws.send(JSON.stringify({ t: 'input', d: 'Sara\n' }));
  await waitFor(ws, (m) => m.t === 'out' && /A:/.test(m.d));
  ws.send(JSON.stringify({ t: 'input', d: '3\n' }));
  ws.send(JSON.stringify({ t: 'input', d: '4\n' }));
  await waitFor(ws, (m) => m.t === 'out' && /Hello, Sara! Sum = 7/.test(m.d));
  await waitFor(ws, (m) => m.t === 'out' && /process finished/.test(m.d));
  ws.send(JSON.stringify({ t: 'stop' }));
  await waitFor(ws, (m) => m.t === 'closed');
});

test('entries that could be used as options or escape the project are refused', async () => {
  const ws = await connect(tok(claims()));
  for (const entry of ['-e.js', '/etc/passwd', 'a/../../b.js', 'x;rm -rf.js']) {
    ws.msgs.length = 0;
    ws.send(JSON.stringify({ t: 'init', kind: 'lang', entry }));
    await waitFor(ws, (m) => m.t === 'error' && m.text === 'Invalid request.');
  }
  ws.close();
});

test('an unauthenticated socket cannot push a large frame', async () => {
  const code = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { origin: ORIGIN } });
    ws.on('open', () => ws.send(Buffer.alloc(2 * 1024 * 1024, 1)));
    ws.on('close', (c) => resolve(c));
    ws.on('error', () => {});
    setTimeout(() => reject(new Error('socket stayed open')), 5000);
  });
  assert.equal(code, 1009);
});

test('the student shell never sees the gateway secret', async () => {
  const ws = await connect(tok(claims()));
  ws.send(JSON.stringify({ t: 'init', kind: 'shell', entry: '' }));
  await waitFor(ws, (m) => m.t === 'send-files');
  ws.send(makeZip({ 'a.txt': 'x' }));
  await waitFor(ws, (m) => m.t === 'session');
  ws.send(JSON.stringify({ t: 'input', d: 'echo LEAK=[${SANDBOX_JWT_SECRET:-none}]\n' }));
  await waitFor(ws, (m) => m.t === 'out' && /LEAK=\[none\]/.test(m.d));
  ws.send(JSON.stringify({ t: 'stop' }));
  await waitFor(ws, (m) => m.t === 'closed');
});

test('a zip with a path-traversal entry is rejected before the container', async () => {
  const ws = await connect(tok(claims()));
  ws.send(JSON.stringify({ t: 'init', kind: 'shell', entry: '' }));
  await waitFor(ws, (m) => m.t === 'send-files');
  const dir = mkdtempSync(join(tmpdir(), 'slip-'));
  execFileSync('python3', ['-c', `import zipfile; z=zipfile.ZipFile('${join(dir, 's.zip')}','w'); z.writestr('../evil.txt','x'); z.close()`]);
  ws.send(execFileSync('cat', [join(dir, 's.zip')]));
  const err = await waitFor(ws, (m) => m.t === 'error');
  assert.match(err.text, /rejected/);
  assert.ok(!ws.msgs.some((m) => m.t === 'session'));
});
