// All settings come from environment variables (see .env.example).
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const env = process.env;
const int = (k, d) => { const n = Number(env[k]); return Number.isFinite(n) && n > 0 ? n : d; };
const list = (k, d) => String(env[k] ?? d).split(',').map((s) => s.trim()).filter(Boolean);

export const cfg = {
  port: int('PORT', 8787),
  // Loopback by default: the reverse proxy (Caddy) is the only public entry point.
  host: String(env.HOST || '127.0.0.1'),
  // behind Caddy every peer is 127.0.0.1; only then is X-Forwarded-For believed (rate limits are per real client IP)
  trustProxy: env.TRUST_PROXY !== '0',
  jwtSecret: String(env.SANDBOX_JWT_SECRET || ''),
  // Origins that may open the control WebSocket (the UIP front-end).
  allowedOrigins: list('ALLOWED_ORIGINS', 'https://uip-nub.vercel.app,http://localhost:5173,http://localhost:4173'),
  // Every session is served at <sessionId>.<PREVIEW_DOMAIN>. Needs a wildcard DNS record (+ TLS) in production.
  previewDomain: String(env.PREVIEW_DOMAIN || 'localhost:8787').toLowerCase(),
  previewScheme: env.PREVIEW_SCHEME === 'https' ? 'https' : 'http',

  provider: env.SANDBOX_PROVIDER === 'local' ? 'local' : 'docker', // 'local' = NO isolation, development/tests only
  image: String(env.SANDBOX_IMAGE || 'uip-sandbox:latest'),
  network: String(env.SANDBOX_NETWORK || 'uip-sandbox'),
  runtime: String(env.SANDBOX_RUNTIME || ''), // e.g. "runsc" (gVisor) for stronger isolation
  cpus: String(env.SANDBOX_CPUS || '2'), // a cap, not a reservation: a compile can use 2 cores while other sessions are idle
  memory: String(env.SANDBOX_MEMORY || '2g'),
  pids: int('SANDBOX_PIDS', 512),
  // public resolvers: the firewall blocks private ranges, so a sandbox must not depend on the host's DNS
  dns: list('SANDBOX_DNS', '1.1.1.1,8.8.8.8'),

  // where the used-token (jti) table is kept so it survives a restart. systemd's StateDirectory= sets STATE_DIRECTORY.
  stateDir: String(env.STATE_DIR || env.STATE_DIRECTORY || join(dirname(fileURLToPath(import.meta.url)), '..', '.state')),
  // The gateway checks at start-up (and every 10 min) that sandboxes really cannot reach the host / private networks, and refuses
  // to run otherwise. Only set ALLOW_NO_FIREWALL=1 for your own machine (Docker Desktop has no egress firewall) — never for students.
  allowNoFirewall: env.ALLOW_NO_FIREWALL === '1',
  maxPreviewMissesPerIp: int('MAX_PREVIEW_MISSES', 30), // unknown preview hostnames per minute per IP before 429 (id guessing)

  maxSessions: int('MAX_SESSIONS', 6),
  maxLifeMs: int('MAX_LIFE_MIN', 60) * 60_000,   // hard limit for one session
  idleMs: int('IDLE_MIN', 20) * 60_000,          // no input / preview traffic
  detachedMs: int('DETACHED_MIN', 10) * 60_000,   // browser closed or reloaded: how long the sandbox waits for a reconnect
  // per-user persistent cache volume (npm / composer / pip caches + node_modules / vendor snapshots): repeated runs skip the install
  userCache: env.USER_CACHE !== '0',
  cacheMaxMb: int('USER_CACHE_MAX_MB', 4096),
  maxZipBytes: int('MAX_ZIP_MB', 60) * 1024 * 1024,
  maxUnzipBytes: int('MAX_UNZIP_MB', 600) * 1024 * 1024, // declared size after extraction (zip-bomb guard)
  maxZipFiles: int('MAX_ZIP_FILES', 30000),
  maxDiskMb: int('SANDBOX_MAX_DISK_MB', 6144), // watchdog kills a session whose writable layer exceeds this
  disk: String(env.SANDBOX_DISK || ''),        // optional hard quota ("5g"; overlay2 on xfs with pquota)
  maxConnsPerIp: int('MAX_CONNS_PER_IP', 12),
  maxPreAuthConns: int('MAX_PREAUTH_CONNS', 100),
  authFailLimit: int('AUTH_FAIL_LIMIT', 8),
  authFailWindowMs: int('AUTH_FAIL_WINDOW_SEC', 60) * 1000,
  sessionCooldownMs: int('SESSION_COOLDOWN_SEC', 2) * 1000,
};
// SANDBOX_PROVIDER=local runs student code on THIS machine with no isolation. Never let it start on a real server.
if (cfg.provider === 'local' && (env.NODE_ENV === 'production' || cfg.previewScheme === 'https') && env.ALLOW_INSECURE_LOCAL !== '1') {
  console.error('Refusing to start: SANDBOX_PROVIDER=local has NO isolation and must not be used in production / with https previews.');
  process.exit(1);
}

// Container ports the gateway can preview (published on 127.0.0.1 with a random host port each).
// Order = preference when several ports listen at once. 8000 PHP/Django/FastAPI · 5173/4173 Vite · 3000 Node/Next/Rails · 8080 Spring/Go/static
// 5000 Flask/ASP.NET · 4200 Angular · 9292 Rack · 4000 Phoenix/Jekyll · 8081/3001/9000/8888/5001/8001 common alternatives
export const PREVIEW_PORTS = [8000, 5173, 3000, 4173, 8080, 5000, 4200, 9292, 4000, 8081, 3001, 9000, 8888, 5001, 8001];
export const PROJECT_DIR = '/home/dev/project';
