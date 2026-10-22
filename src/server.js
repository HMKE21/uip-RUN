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
import { verifyToken, initJtiStore, pruneJtiStore } from './auth.js';
import { buildScript, KINDS } from './scripts.js';
import { inspectZip } from './zipcheck.js';
import { hostOnlyCookies } from './proc.js';

const dk = await import(cfg.provider === 'local' ? './local.js' : './docker.js');

const sessions = new Map(); // sid -> session
const OUT_BUFFER = 64 * 1024;
const MAX_BUFFERED = 2 * 1024 * 1024; // bytes queued for one browser before the terminal is paused
const MAX_TEXT_FRAME = 64 * 1024;     // control messages are tiny; only the single project zip is binary
const PORT_ORDER = PREVIEW_PORTS;
// These kinds run apps that validate the Host header (Vite, Django, Rails…), so the proxy presents the request as
// http://localhost:<port> and translates redirects back. Laravel keeps the real host so the URLs it generates are right.
const REWRITE_HOST = new Set(['node', 'python', 'rails']);

const send = (ws, msg) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); };
// relative path of the file to run: letters of any script (Arabic names are fine), digits and a few separators; never absolute, never `..`, never an option (leading -)
const safeEntry = (s) => typeof s === 'string' && s.length <= 200 && /^[\p{L}\p{N}\p{M}_@%+=:,./ ()[\]-]*$/u.test(s) && !s.startsWith('/') && !s.startsWith('-') && !s.split('/').includes('..');
const clampCols = (n) => Math.min(500, Math.max(20, Number(n) || 100));
const clampRows = (n) => Math.min(200, Math.max(5, Number(n) || 28));

const log = (event, data = {}) => console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...data }));

// ---------------------------------------------------------------- abuse limits (per client IP)
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
/** the real client address: behind Caddy every peer is loopback, so (only then) the rightmost X-Forwarded-For entry is used */
function clientIp(req) {
  const peer = req.socket.remoteAddress || '';
  if (cfg.trustProxy && LOOPBACK.has(peer)) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
    if (xff.length) return xff[xff.length - 1].slice(0, 64);
  }
  return peer;
}
const connsByIp = new Map(); // ip -> open control sockets
const authFails = new Map(); // ip -> { n, reset }
const lastStart = new Map(); // userId -> time of the last environment start
let preAuth = 0;             // sockets that connected but have not authenticated yet
const previewMisses = new Map(); // ip -> { n, reset }: requests for preview hostnames that do not exist (someone guessing ids)
const previewBlocked = (ip) => { const f = previewMisses.get(ip); return !!f && Date.now() < f.reset && f.n >= cfg.maxPreviewMissesPerIp; };
const notePreviewMiss = (ip) => {
  const f = previewMisses.get(ip);
  if (!f || Date.now() >= f.reset) previewMisses.set(ip, { n: 1, reset: Date.now() + 60_000 }); else f.n++;
};
// Network protection state (docker provider): false = the egress firewall is missing / broken, so NO new environment may start.
const netGuard = { ok: true, why: '', inconclusive: 0 };
const ipBlocked = (ip) => { const f = authFails.get(ip); return !!f && Date.now() < f.reset && f.n >= cfg.authFailLimit; };
const noteAuthFail = (ip) => {
  const f = authFails.get(ip);
  if (!f || Date.now() >= f.reset) authFails.set(ip, { n: 1, reset: Date.now() + cfg.authFailWindowMs });
  else f.n++;
};

// ---------------------------------------------------------------- sessions
const previewUrlFor = (sid) => `${cfg.previewScheme}://${sid}.${cfg.previewDomain}`;

async function destroy(s, reason) {
  if (!sessions.delete(s.sid)) return;
  log('session_end', { sid: s.sid, user: s.userId, reason, seconds: Math.round((Date.now() - s.createdAt) / 1000) });
  clearInterval(s.poll); clearInterval(s.resumeTimer);
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
    return send(s.ws, { t: 'error', text: `Could not open the terminal.` });
  }
  s.term = t;
  t.onData((d) => {
    s.out = (s.out + d).slice(-OUT_BUFFER);
    send(s.ws, { t: 'out', d });
    // back-pressure: a program that prints without end (`yes`) must not make the gateway buffer gigabytes for a slow browser
    if (s.ws && s.ws.bufferedAmount > MAX_BUFFERED && !s.paused) {
      s.paused = true;
      try { t.pause(); } catch { /* ignore */ }
      s.resumeTimer = setInterval(() => {
        if (!s.ws || s.ws.readyState !== 1 || s.ws.bufferedAmount < MAX_BUFFERED / 4) {
          clearInterval(s.resumeTimer); s.paused = false;
          try { t.resume(); } catch { /* ignore */ }
        }
      }, 100);
    }
  });
  t.onExit(({ exitCode }) => { if (s.term === t) { s.term = null; send(s.ws, { t: 'exit', code: exitCode }); } });
}

function watchPorts(s) {
  s.poll = setInterval(async () => {
    if (!sessions.has(s.sid) || !s.term || s.polling) return; // never let slow `docker exec` calls pile up
    s.polling = true;
    try { await pollPorts(s); } finally { s.polling = false; }
  }, 2000);
}
async function pollPorts(s) {
  {
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
  }
}

async function startSession(ws, claims, init, zip) {
  if (!netGuard.ok) { log('session_refused', { user: claims.sub, reason: netGuard.why }); send(ws, { t: 'error', text: 'The sandbox is temporarily unavailable. Please try again later and tell the administrator if it continues.' }); return null; }
  const t0 = Date.now();
  if (t0 - (lastStart.get(claims.sub) || 0) < cfg.sessionCooldownMs) { send(ws, { t: 'error', text: 'Please wait a moment before starting again.' }); return null; }
  lastStart.set(claims.sub, t0);
  for (const old of [...sessions.values()]) if (old.userId === claims.sub) await destroy(old, 'replaced by a new run');
  // capacity is checked AFTER the old session is gone and in the same tick as sessions.set(): two parallel starts cannot both slip past the limit
  if (sessions.size >= cfg.maxSessions) { send(ws, { t: 'error', text: 'The sandbox is busy right now (all environments are in use). Try again in a few minutes.' }); return null; }
  const sid = randomBytes(16).toString('hex');
  const s = { sid, userId: claims.sub, projectId: claims.pid, ws, term: null, out: '', createdAt: Date.now(), lastActive: Date.now(), detachedAt: 0, previewPort: null, seen: new Set(), ports: {}, poll: null, kind: init.kind };
  sessions.set(sid, s);
  log('session_start', { sid, user: claims.sub, project: claims.pid, kind: init.kind });
  try {
    send(ws, { t: 'status', text: 'Creating the environment…' });
    await dk.createContainer(sid, claims.sub);
    s.ports = await dk.portMap(sid);
    send(ws, { t: 'status', text: 'Uploading the project…' });
    const tmp = path.join(os.tmpdir(), `uip-${sid}.zip`);
    await writeFile(tmp, zip, { mode: 0o600 });
    try { await dk.uploadZip(sid, tmp); } finally { unlink(tmp).catch(() => {}); }
    await dk.writeScript(sid, buildScript({ kind: init.kind, entry: init.entry, previewUrl: previewUrlFor(sid), previewDomain: cfg.previewDomain }));
    send(ws, { t: 'status', text: 'Running' });
    send(ws, { t: 'session', id: sid, kind: init.kind, expiresInMs: cfg.maxLifeMs });
    startTerminal(s, init.cols, init.rows);
    watchPorts(s);
    return s;
  } catch (e) {
    // docker's stderr (paths, daemon messages) stays in the server log; the browser gets a generic message
    log('session_failed', { sid, user: claims.sub, error: String(e.stderr || e.message || e).trim().split('\n').filter(Boolean).slice(-3).join(' | ') });
    send(ws, { t: 'error', text: 'Could not start the environment. Please try again in a moment; if it keeps failing, tell the administrator.' });
    await destroy(s, 'failed to start');
    return null;
  }
}

setInterval(() => {
  const now = Date.now();
  for (const s of sessions.values()) {
    if (now - s.createdAt > cfg.maxLifeMs) destroy(s, 'time limit reached').catch(() => {});
    else if (!s.ws && now - s.detachedAt > cfg.detachedMs) destroy(s, 'disconnected').catch(() => {});
    else if (now - s.lastActive > cfg.idleMs) destroy(s, 'idle for too long').catch(() => {});
  }
  for (const [ip, f] of authFails) if (now >= f.reset) authFails.delete(ip);
  for (const [ip, f] of previewMisses) if (now >= f.reset) previewMisses.delete(ip);
  for (const [u, t] of lastStart) if (now - t > 60_000) lastStart.delete(u);
}, 10_000).unref();

// Disk watchdog: `dd if=/dev/zero of=big` would otherwise fill the HOST disk and take every other session down.
let diskBusy = false;
setInterval(async () => {
  if (diskBusy || !sessions.size) return;
  diskBusy = true;
  try {
    const usage = await dk.diskUsage();
    for (const s of [...sessions.values()]) {
      const used = usage[dk.containerName?.(s.sid)] || 0;
      if (used > cfg.maxDiskMb * 1e6) {
        send(s.ws, { t: 'out', d: `\r\n\x1b[31m✗ Disk limit reached (${cfg.maxDiskMb} MB) — the environment was stopped.\x1b[0m\r\n` });
        log('disk_limit', { sid: s.sid, user: s.userId, mb: Math.round(used / 1e6) });
        await destroy(s, 'disk limit exceeded');
        continue;
      }
      const cacheMb = await dk.cacheUsageMb(s.sid);
      if (cacheMb > cfg.cacheMaxMb * 1.25) {
        log('cache_limit', { sid: s.sid, user: s.userId, mb: cacheMb });
        send(s.ws, { t: 'out', d: '\r\n\x1b[33m⚠ Your dependency cache grew past its limit and was cleared.\x1b[0m\r\n' });
        await dk.purgeCache(s.sid);
      }
    }
  } catch (e) { console.error('disk watchdog:', e.message); } finally { diskBusy = false; }
}, cfg.diskWatchMs).unref();

// ---------------------------------------------------------------- preview reverse proxy
function previewSid(hostHeader) {
  const host = String(hostHeader || '').toLowerCase();
  const suffix = `.${cfg.previewDomain}`;
  if (!host.endsWith(suffix)) return null;
  const label = host.slice(0, -suffix.length);
  return /^[a-f0-9]{32}$/.test(label) ? label : null;
}

/** Who opens the preview link: the first few distinct client IPs per session are logged, so a link that was shared shows up in the log. */
function noteViewer(s, ip) {
  s.viewers ??= new Set();
  if (s.viewers.has(ip) || s.viewers.size >= 20) return;
  s.viewers.add(ip);
  log('preview_viewer', { sid: s.sid, user: s.userId, ip, distinct: s.viewers.size });
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

const NOINDEX = 'noindex, nofollow, noarchive'; // a preview link must never end up in a search engine

function proxyHttp(sid, req, res) {
  const ip = clientIp(req);
  if (previewBlocked(ip)) { res.writeHead(429, { 'content-type': 'text/plain', 'retry-after': '60' }); return res.end('Too many requests.'); }
  const { s, port } = upstreamOf(sid);
  if (!s) { notePreviewMiss(ip); res.writeHead(404, { 'content-type': 'text/plain', 'x-robots-tag': NOINDEX }); return res.end('This sandbox has ended.'); }
  noteViewer(s, ip);
  if (!port) {
    res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'retry-after': '2', 'cache-control': 'no-store', 'x-robots-tag': NOINDEX, 'content-security-policy': frameAncestors() });
    return res.end('<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="2"><body style="font:14px system-ui;color:#555;display:grid;place-items:center;height:100vh;margin:0">Starting the app… (installing dependencies can take a few minutes — watch the terminal)</body>');
  }
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v : mapRequestHeader(s, k, v);
  headers['x-forwarded-host'] = req.headers.host; headers['x-forwarded-proto'] = cfg.previewScheme;
  const up = http.request({ host: '127.0.0.1', port, method: req.method, path: req.url, headers }, (ur) => {
    const h = { ...ur.headers };
    delete h['x-frame-options']; // the preview is meant to be framed by the IDE…
    h['content-security-policy'] = [].concat(h['content-security-policy'] || [], frameAncestors()); // …and only by it
    h['x-robots-tag'] = NOINDEX;
    if (cfg.previewScheme === 'https') h['content-security-policy'].push('upgrade-insecure-requests');
    if (h.location) h.location = mapLocation(s, h.location);
    if (h['set-cookie']) h['set-cookie'] = hostOnlyCookies(h['set-cookie']);
    if (!h['referrer-policy']) h['referrer-policy'] = 'same-origin'; // the preview URL (contains the session id) must not leak to third parties
    res.writeHead(ur.statusCode || 502, h);
    ur.pipe(res);
  });
  up.setTimeout(300_000, () => up.destroy()); // an upstream that never answers must not hold a socket forever
  res.on('close', () => up.destroy());
  up.on('error', () => {
    // Nothing is listening (yet / any more): the app is still booting or crashed. Answer with a self-refreshing page, not a bare 502.
    if (!res.headersSent) res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'retry-after': '2', 'cache-control': 'no-store', 'x-robots-tag': NOINDEX, 'content-security-policy': frameAncestors() });
    res.end('<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="2"><body style="font:14px system-ui;color:#555;display:grid;place-items:center;height:100vh;margin:0">The app is not responding yet — it may still be starting or it stopped. Check the terminal for errors. Retrying…</body>');
  });
  req.pipe(up);
}

function proxyUpgrade(sid, req, socket, head) {
  if (String(req.headers.upgrade || '').toLowerCase() !== 'websocket') return socket.destroy();
  const ip = clientIp(req);
  if (previewBlocked(ip)) return socket.destroy();
  const { s, port } = upstreamOf(sid);
  if (!s) notePreviewMiss(ip);
  if (!s || !port) return socket.destroy();
  noteViewer(s, ip);
  if ((s.upgrades || 0) >= 100) return socket.destroy(); // at most 100 simultaneous WebSockets into one app
  s.upgrades = (s.upgrades || 0) + 1;
  const up = net.connect(port, '127.0.0.1', () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${mapRequestHeader(s, req.rawHeaders[i], req.rawHeaders[i + 1])}`);
    up.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head?.length) up.write(head);
    socket.pipe(up).pipe(socket);
  });
  let closed = false;
  const done = () => { if (closed) return; closed = true; s.upgrades = Math.max(0, (s.upgrades || 1) - 1); up.destroy(); socket.destroy(); };
  up.on('error', done); up.on('close', done);
  socket.on('error', done); socket.on('close', done);
}

// ---------------------------------------------------------------- HTTP + WebSocket entry points
const server = http.createServer((req, res) => {
  try {
    const sid = previewSid(req.headers.host);
    if (sid) return proxyHttp(sid, req, res);
    // no session counts here: this endpoint is reachable from the Internet through the reverse proxy
    if (req.url === '/healthz') { res.writeHead(netGuard.ok ? 200 : 503, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: netGuard.ok })); }
    res.writeHead(404, { 'content-type': 'text/plain' }); res.end('uip-sandbox');
  } catch { try { res.destroy(); } catch { /* ignore */ } }
});
server.headersTimeout = 20_000;      // slow-loris: the whole header block must arrive within 20 s
server.maxHeadersCount = 100;
server.on('clientError', (_e, socket) => { try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch { /* ignore */ } });

const wss = new WebSocketServer({ noServer: true, maxPayload: cfg.maxZipBytes + 4096 });

server.on('upgrade', (req, socket, head) => {
  const sid = previewSid(req.headers.host);
  if (sid) { try { return proxyUpgrade(sid, req, socket, head); } catch { return socket.destroy(); } }
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { return socket.destroy(); }
  if (url.pathname !== '/ws') return socket.destroy();
  if (!cfg.allowedOrigins.includes(req.headers.origin || '')) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); return socket.destroy(); }
  if (url.search) { socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'); return socket.destroy(); } // credentials in the URL are refused
  const ip = clientIp(req);
  if (ipBlocked(ip) || (connsByIp.get(ip) || 0) >= cfg.maxConnsPerIp || preAuth >= cfg.maxPreAuthConns) { socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n'); return socket.destroy(); }
  // The token is NOT read from the URL (it would leak into access logs); the client sends {t:'auth', token} as its first frame.
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, null));
});

wss.on('connection', (ws, req, claims) => {
  let session = null; let pending = null; let busy = false;
  const ip = clientIp(req);
  connsByIp.set(ip, (connsByIp.get(ip) || 0) + 1);
  let counted = true; // still counted as "not authenticated yet"
  preAuth++;
  const authed = () => { if (counted) { counted = false; preAuth--; } };
  // Before authentication a socket may send only a few bytes: the server-wide maxPayload (needed for the project zip) is lowered for
  // this connection until the token has been verified, so nobody can push 60 MB at the gateway anonymously.
  try { ws._receiver._maxPayload = 4096; } catch { /* the 4096-byte check on the first frame still applies */ }
  ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; });
  const authTimer = setTimeout(() => { if (!claims) { noteAuthFail(ip); ws.close(4401, 'unauthorized'); } }, 5000);
  ws.on('close', () => {
    clearTimeout(authTimer); authed();
    const n = (connsByIp.get(ip) || 1) - 1; if (n <= 0) connsByIp.delete(ip); else connsByIp.set(ip, n);
  });

  ws.on('message', async (data, isBinary) => {
    if (!claims) { // first frame must be a small JSON {t:'auth', token}
      try {
        if (isBinary || data.length > 4096) throw new Error('bad first frame');
        const a = JSON.parse(String(data));
        if (a.t !== 'auth') throw new Error('auth required');
        claims = verifyToken(a.token, cfg.jwtSecret);
        clearTimeout(authTimer); authed();
        try { ws._receiver._maxPayload = cfg.maxZipBytes + 4096; } catch { /* ignore */ }
      } catch (e) { noteAuthFail(ip); log('auth_failed', { ip, reason: String(e.message).slice(0, 60) }); ws.close(4401, 'unauthorized'); }
      return;
    }
    if (!isBinary && data.length > MAX_TEXT_FRAME) return send(ws, { t: 'error', text: 'Invalid request.' });
    try {
      if (isBinary) {
        if (!pending || busy || session) return;
        if (data.length > cfg.maxZipBytes) return send(ws, { t: 'error', text: 'The project is too large for the sandbox.' });
        try { inspectZip(data, { maxFiles: cfg.maxZipFiles, maxBytes: cfg.maxUnzipBytes }); } catch (e) {
          pending = null; log('zip_rejected', { user: claims.sub, reason: e.message });
          return send(ws, { t: 'error', text: `The project was rejected: ${e.message}.` });
        }
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
    } catch { busy = false; send(ws, { t: 'error', text: 'Bad request.' }); }
  });

  ws.on('close', () => { if (session && session.ws === ws) { session.ws = null; session.detachedAt = Date.now(); } });
  ws.on('error', () => {});
});

setInterval(() => { for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; try { ws.ping(); } catch { /* ignore */ } } }, 20_000).unref();

// ---------------------------------------------------------------- network protection (egress firewall) self-test
const reportNet = (r) => `${r.leaks.length ? `a sandbox could connect to: ${r.leaks.join(', ')}` : ''}${r.errors.length ? `${r.leaks.length ? ' · ' : ''}check could not run: ${r.errors.join(' | ')}` : ''}`;

/** Start-up: refuse to run (exit 1) unless sandboxes provably cannot reach the host / other networks. Afterwards: re-check every 10 minutes. */
async function guardNetwork() {
  if (!dk.selfTestFirewall) return; // local provider: no containers, development only
  if (cfg.allowNoFirewall) {
    console.warn('⚠ ALLOW_NO_FIREWALL=1: the egress firewall is NOT checked. Student code can reach this machine and its local network. Use it only for your own projects.');
    return;
  }
  const r = await dk.selfTestFirewall();
  for (const n of r.notes) console.warn(`⚠ ${n}`);
  if (!r.ok) {
    console.error(`\n✗ Refusing to start: the sandbox network is NOT isolated (${reportNet(r)}).\n  Linux server: run  sudo ./deploy/egress-firewall.sh  and start again (the systemd unit does this before every start).\n  Docker Desktop (Windows / macOS) has no such firewall — for your own projects only, set ALLOW_NO_FIREWALL=1.\n`);
    process.exit(1);
  }
  console.log('✔ egress firewall verified: sandboxes cannot reach the host or other containers');
  const timer = setInterval(async () => {
    const x = await dk.selfTestFirewall();
    if (x.ok) { if (!netGuard.ok) log('firewall_restored', {}); netGuard.ok = true; netGuard.inconclusive = 0; return; }
    if (x.leaks.length) { // definitive: the protection is gone. Block new sessions and stop the exposed ones.
      netGuard.ok = false; netGuard.why = reportNet(x); log('firewall_broken', { detail: netGuard.why });
      for (const s of [...sessions.values()]) await destroy(s, 'sandbox network protection unavailable');
    } else if (++netGuard.inconclusive >= 2) { // the check itself kept failing (docker busy?): no new sessions until it passes
      netGuard.ok = false; netGuard.why = reportNet(x); log('firewall_unverified', { detail: netGuard.why });
    }
  }, 10 * 60_000);
  timer.unref();
}

// ---------------------------------------------------------------- boot / shutdown
async function main() {
  if (cfg.jwtSecret.length < 32) { console.error('SANDBOX_JWT_SECRET must be set (≥ 32 characters, same value as in Full-API).'); process.exit(1); }
  // used-token table on disk: a restart must not make a stolen token usable again
  const kept = initJtiStore(path.join(cfg.stateDir, 'jti.log'));
  setInterval(() => { try { pruneJtiStore(); } catch (e) { console.error('jti prune:', e.message); } }, 10 * 60_000).unref();
  await dk.ensureReady();
  await guardNetwork();
  const removed = await dk.cleanupLeftovers();
  server.listen(cfg.port, cfg.host, () => console.log(`uip-sandbox listening on ${cfg.host}:${cfg.port} (provider: ${dk.name}, preview: ${cfg.previewScheme}://<id>.${cfg.previewDomain}, removed ${removed} stale containers, ${kept} used tokens restored)`));
}
const shutdown = async () => { await Promise.all([...sessions.values()].map((s) => destroy(s, 'gateway restarting'))); process.exit(0); };
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
// One malformed request must not take every student's session down (a restart removes all containers): log and carry on.
process.on('uncaughtException', (e) => console.error('uncaught exception:', e));
process.on('unhandledRejection', (e) => console.error('unhandled rejection:', e));
main().catch((e) => { console.error(e.message); process.exit(1); });
