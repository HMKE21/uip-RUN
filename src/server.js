// uip-sandbox gateway.
//   wss://<gateway>/ws   terminal + control channel (used by the IDE); first frame = {t:"auth", token:<jwt from Full-API>}
//   http(s)://<sessionId>.<PREVIEW_DOMAIN>/…       reverse proxy to the app running in that session's container
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { writeFile, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';
import pty from '@lydell/node-pty';
import { cfg, PREVIEW_PORTS } from './config.js';
import { verifyToken } from './auth.js';
import { buildScript, KINDS } from './scripts.js';

const dk = await import(cfg.provider === 'local' ? './local.js' : './docker.js');

const sessions = new Map(); // sid -> session
const OUT_BUFFER = 64 * 1024;
const PORT_ORDER = PREVIEW_PORTS;
// These kinds run apps that validate the Host header (Vite, Django, Rails…), so the proxy presents the request as
// http://localhost:<port> and translates redirects back. Laravel keeps the real host so the URLs it generates are right.
const REWRITE_HOST = new Set(['node', 'python', 'rails']);

const send = (ws, msg) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); };
// relative path of the file to run: letters of any script (Arabic names are fine), digits and a few separators; never absolute, never `..`, never an option (leading -)
const safeEntry = (s) => typeof s === 'string' && s.length <= 200 && /^[\p{L}\p{N}\p{M}_@%+=:,./ ()[\]-]*$/u.test(s) && !s.startsWith('/') && !s.startsWith('-') && !s.split('/').includes('..');
const clampCols = (n) => Math.min(500, Math.max(20, Number(n) || 100));
const clampRows = (n) => Math.min(200, Math.max(5, Number(n) || 28));

// ---------------------------------------------------------------- sessions
const previewUrlFor = (sid) => `${cfg.previewScheme}://${sid}.${cfg.previewDomain}`;

async function destroy(s, reason) {
  if (!sessions.delete(s.sid)) return;
  clearInterval(s.poll);
  try { s.term?.kill(); } catch { /* ignore */ }
  send(s.ws, { t: 'closed', reason });
  try { s.ws?.close(); } catch { /* ignore */ }
  await dk.removeContainer(s.sid);
}

async function restartTerminal(s, cols, rows) {
  try { s.term?.kill(); } catch { /* ignore */ }
  s.term = null;
  await dk.killProcesses(s.sid);
  startTerminal(s, cols, rows);
}

function startTerminal(s, cols, rows) {
  s.previewPort = null; s.seen = new Set(); s.out = '';
  let t;
  try { t = dk.spawnTerminal(pty, s.sid, { cols: clampCols(cols), rows: clampRows(rows) }); } catch (e) {
    return send(s.ws, { t: 'error', text: `Could not open the terminal: ${e.message}` });
  }
  s.term = t;
  t.onData((d) => {
    s.out = (s.out + d).slice(-OUT_BUFFER);
    send(s.ws, { t: 'out', d });
  });
  t.onExit(({ exitCode }) => { if (s.term === t) { s.term = null; send(s.ws, { t: 'exit', code: exitCode }); } });
}

function watchPorts(s) {
  s.poll = setInterval(async () => {
    if (!sessions.has(s.sid) || !s.term) return;
    const up = (await dk.listening(s.sid)).filter((u) => PREVIEW_PORTS.includes(u.port));
    for (const u of up) {
      if (u.loopbackOnly && !s.seen.has(u.port)) {
        s.seen.add(u.port);
        send(s.ws, { t: 'hint', text: `Port ${u.port} only listens on 127.0.0.1, so it can't be previewed. Start the server on 0.0.0.0 (e.g. --host 0.0.0.0).` });
      }
    }
    const open = up.filter((u) => !u.loopbackOnly).map((u) => u.port).sort((a, b) => PORT_ORDER.indexOf(a) - PORT_ORDER.indexOf(b));
    const stillUp = s.previewPort && open.includes(s.previewPort);
    if (!stillUp && open.length) {
      s.previewPort = open[0];
      send(s.ws, { t: 'preview', url: previewUrlFor(s.sid), port: s.previewPort });
    } else if (!stillUp && s.previewPort) { s.previewPort = null; send(s.ws, { t: 'preview', url: null }); }
  }, 2000);
}

async function startSession(ws, claims, init, zip) {
  if (sessions.size >= cfg.maxSessions) { send(ws, { t: 'error', text: 'The sandbox is busy right now (all environments are in use). Try again in a few minutes.' }); return null; }
  for (const old of [...sessions.values()]) if (old.userId === claims.sub) await destroy(old, 'replaced by a new run');
  const sid = randomBytes(8).toString('hex');
  const s = { sid, userId: claims.sub, projectId: claims.pid, ws, term: null, out: '', createdAt: Date.now(), lastActive: Date.now(), detachedAt: 0, previewPort: null, seen: new Set(), ports: {}, poll: null, kind: init.kind };
  sessions.set(sid, s);
  try {
    send(ws, { t: 'status', text: 'Creating the environment…' });
    await dk.createContainer(sid, claims.sub);
    s.ports = await dk.portMap(sid);
    send(ws, { t: 'status', text: 'Uploading the project…' });
    const tmp = path.join(os.tmpdir(), `uip-${sid}.zip`);
    await writeFile(tmp, zip, { mode: 0o644 });
    try { await dk.uploadZip(sid, tmp); } finally { unlink(tmp).catch(() => {}); }
    await dk.writeScript(sid, buildScript({ kind: init.kind, entry: init.entry, previewUrl: previewUrlFor(sid), previewDomain: cfg.previewDomain }));
    send(ws, { t: 'status', text: 'Running' });
    send(ws, { t: 'session', id: sid, kind: init.kind, expiresInMs: cfg.maxLifeMs });
    startTerminal(s, init.cols, init.rows);
    watchPorts(s);
    return s;
  } catch (e) {
    send(ws, { t: 'error', text: `Could not start the environment: ${String(e.stderr || '').trim().split('\n').filter(Boolean).pop() || String(e.message).split('\n')[0]}` });
    await destroy(s, 'failed to start');
    return null;
  }
}

setInterval(() => {
  const now = Date.now();
  for (const s of sessions.values()) {
    if (now - s.createdAt > cfg.maxLifeMs) destroy(s, 'time limit reached');
    else if (!s.ws && now - s.detachedAt > cfg.detachedMs) destroy(s, 'disconnected');
    else if (now - s.lastActive > cfg.idleMs) destroy(s, 'idle for too long');
  }
}, 10_000).unref();

// ---------------------------------------------------------------- preview reverse proxy
function previewSid(hostHeader) {
  const host = String(hostHeader || '').toLowerCase();
  const suffix = `.${cfg.previewDomain}`;
  if (!host.endsWith(suffix)) return null;
  const label = host.slice(0, -suffix.length);
  return /^[a-f0-9]{16}$/.test(label) ? label : null;
}

function upstreamOf(sid) {
  const s = sessions.get(sid);
  if (!s) return {};
  s.lastActive = Date.now();
  return { s, port: s.previewPort ? s.ports[s.previewPort] : undefined };
}

/** header rewriting for kinds whose dev servers insist on a localhost Host header */
function mapRequestHeader(s, key, value) {
  if (!REWRITE_HOST.has(s.kind)) return value;
  const k = key.toLowerCase();
  const local = `http://localhost:${s.previewPort}`;
  if (k === 'host') return `localhost:${s.previewPort}`;
  if (k === 'origin' || k === 'referer') return String(value).replace(previewUrlFor(s.sid), local);
  return value;
}
function mapLocation(s, value) {
  if (!REWRITE_HOST.has(s.kind)) return value;
  return String(value).replace(new RegExp(`^http://(localhost|127\\.0\\.0\\.1):${s.previewPort}`), previewUrlFor(s.sid));
}

const frameAncestors = () => `frame-ancestors ${cfg.allowedOrigins.join(' ')}`;

function proxyHttp(sid, req, res) {
  const { s, port } = upstreamOf(sid);
  if (!s) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('This sandbox has ended.'); }
  if (!port) {
    res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'retry-after': '2', 'cache-control': 'no-store', 'content-security-policy': frameAncestors() });
    return res.end('<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="2"><body style="font:14px system-ui;color:#555;display:grid;place-items:center;height:100vh;margin:0">Starting the app… (installing dependencies can take a few minutes — watch the terminal)</body>');
  }
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v : mapRequestHeader(s, k, v);
  headers['x-forwarded-host'] = req.headers.host; headers['x-forwarded-proto'] = cfg.previewScheme;
  const up = http.request({ host: '127.0.0.1', port, method: req.method, path: req.url, headers }, (ur) => {
    const h = { ...ur.headers };
    delete h['x-frame-options']; // the preview is meant to be framed by the IDE…
    h['content-security-policy'] = [].concat(h['content-security-policy'] || [], frameAncestors()); // …and only by it
    if (cfg.previewScheme === 'https') h['content-security-policy'].push('upgrade-insecure-requests');
    if (h.location) h.location = mapLocation(s, h.location);
    res.writeHead(ur.statusCode || 502, h);
    ur.pipe(res);
  });
  up.on('error', () => {
    // Nothing is listening (yet / any more): the app is still booting or crashed. Answer with a self-refreshing page, not a bare 502.
    if (!res.headersSent) res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'retry-after': '2', 'cache-control': 'no-store', 'content-security-policy': frameAncestors() });
    res.end('<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="2"><body style="font:14px system-ui;color:#555;display:grid;place-items:center;height:100vh;margin:0">The app is not responding yet — it may still be starting or it stopped. Check the terminal for errors. Retrying…</body>');
  });
  req.pipe(up);
}

function proxyUpgrade(sid, req, socket, head) {
  const { s, port } = upstreamOf(sid);
  if (!s || !port) return socket.destroy();
  const up = net.connect(port, '127.0.0.1', () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${mapRequestHeader(s, req.rawHeaders[i], req.rawHeaders[i + 1])}`);
    up.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head?.length) up.write(head);
    socket.pipe(up).pipe(socket);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
}

// ---------------------------------------------------------------- HTTP + WebSocket entry points
const server = http.createServer((req, res) => {
  const sid = previewSid(req.headers.host);
  if (sid) return proxyHttp(sid, req, res);
  if (req.url === '/healthz') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true, sessions: sessions.size, max: cfg.maxSessions })); }
  res.writeHead(404, { 'content-type': 'text/plain' }); res.end('uip-sandbox');
});

const wss = new WebSocketServer({ noServer: true, maxPayload: cfg.maxZipBytes + 4096 });

server.on('upgrade', (req, socket, head) => {
  const sid = previewSid(req.headers.host);
  if (sid) return proxyUpgrade(sid, req, socket, head);
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/ws') return socket.destroy();
  if (!cfg.allowedOrigins.includes(req.headers.origin || '')) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); return socket.destroy(); }
  if (url.search) { socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'); return socket.destroy(); } // credentials in the URL are refused
  // The token is NOT read from the URL (it would leak into access logs); the client sends {t:'auth', token} as its first frame.
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, null));
});

wss.on('connection', (ws, req, claims) => {
  let session = null; let pending = null; let busy = false;
  ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; });
  const authTimer = setTimeout(() => { if (!claims) ws.close(4401, 'unauthorized'); }, 5000);
  ws.on('close', () => clearTimeout(authTimer));

  ws.on('message', async (data, isBinary) => {
    if (!claims) { // first frame must be a small JSON {t:'auth', token}
      try {
        if (isBinary || data.length > 4096) throw new Error('bad first frame');
        const a = JSON.parse(String(data));
        if (a.t !== 'auth') throw new Error('auth required');
        claims = verifyToken(a.token, cfg.jwtSecret);
        clearTimeout(authTimer);
      } catch { ws.close(4401, 'unauthorized'); }
      return;
    }
    try {
      if (isBinary) {
        if (!pending || busy || session) return;
        if (data.length > cfg.maxZipBytes) return send(ws, { t: 'error', text: 'The project is too large for the sandbox.' });
        busy = true; const init = pending; pending = null;
        try { session = await startSession(ws, claims, init, data); } finally { busy = false; }
        return;
      }
      const m = JSON.parse(String(data));
      if (m.t === 'init') {
        const kind = String(m.kind || '');
        if (!KINDS.includes(kind) || !safeEntry(m.entry ?? '')) return send(ws, { t: 'error', text: 'Invalid request.' });
        const cols = clampCols(m.cols); const rows = clampRows(m.rows);
        if (m.resume) { // reconnect to the sandbox that is still running for this user + project
          const old = [...sessions.values()].find((x) => x.userId === claims.sub && x.projectId === claims.pid);
          if (!old) return send(ws, { t: 'nosession' });
          if (old.ws && old.ws !== ws) { send(old.ws, { t: 'closed', reason: 'opened in another tab' }); try { old.ws.close(); } catch { /* ignore */ } }
          old.ws = ws; old.detachedAt = 0; session = old;
          send(ws, { t: 'session', id: old.sid, kind: old.kind, resumed: true, expiresInMs: Math.max(0, cfg.maxLifeMs - (Date.now() - old.createdAt)) });
          if (old.out) send(ws, { t: 'out', d: old.out });
          if (old.previewPort) send(ws, { t: 'preview', url: previewUrlFor(old.sid), port: old.previewPort });
          try { old.term?.resize(cols, rows); } catch { /* ignore */ }
          return;
        }
        pending = { kind, entry: m.entry || '', cols, rows };
        return send(ws, { t: 'send-files' });
      }
      if (!session) return;
      session.lastActive = Date.now();
      if (m.t === 'input' && typeof m.d === 'string' && m.d.length <= 16384) session.term?.write(m.d);
      else if (m.t === 'resize') { try { session.term?.resize(clampCols(m.cols), clampRows(m.rows)); } catch { /* ignore */ } }
      else if (m.t === 'restart' && !busy) {
        busy = true;
        try {
          send(ws, { t: 'out', d: '\r\n\x1b[90m— restarting —\x1b[0m\r\n' });
          await restartTerminal(session, m.cols, m.rows);
        } finally { busy = false; }
      } else if (m.t === 'stop') await destroy(session, 'stopped');
    } catch (e) { busy = false; send(ws, { t: 'error', text: `Bad request: ${e.message}` }); }
  });

  ws.on('close', () => { if (session && session.ws === ws) { session.ws = null; session.detachedAt = Date.now(); } });
  ws.on('error', () => {});
});

setInterval(() => { for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; try { ws.ping(); } catch { /* ignore */ } } }, 20_000).unref();

// ---------------------------------------------------------------- boot / shutdown
async function main() {
  if (cfg.jwtSecret.length < 32) { console.error('SANDBOX_JWT_SECRET must be set (≥ 32 characters, same value as in Full-API).'); process.exit(1); }
  await dk.ensureReady();
  const removed = await dk.cleanupLeftovers();
  server.listen(cfg.port, () => console.log(`uip-sandbox listening on :${cfg.port} (provider: ${dk.name}, preview: ${cfg.previewScheme}://<id>.${cfg.previewDomain}, removed ${removed} stale containers)`));
}
const shutdown = async () => { await Promise.all([...sessions.values()].map((s) => destroy(s, 'gateway restarting'))); process.exit(0); };
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
main().catch((e) => { console.error(e.message); process.exit(1); });
