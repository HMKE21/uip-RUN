// All settings come from environment variables (see .env.example).
const env = process.env;
const int = (k, d) => { const n = Number(env[k]); return Number.isFinite(n) && n > 0 ? n : d; };
const list = (k, d) => String(env[k] ?? d).split(',').map((s) => s.trim()).filter(Boolean);

export const cfg = {
  port: int('PORT', 8787),
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
  cpus: String(env.SANDBOX_CPUS || '1'),
  memory: String(env.SANDBOX_MEMORY || '2g'),
  pids: int('SANDBOX_PIDS', 512),

  maxSessions: int('MAX_SESSIONS', 6),
  maxLifeMs: int('MAX_LIFE_MIN', 60) * 60_000,   // hard limit for one session
  idleMs: int('IDLE_MIN', 20) * 60_000,          // no input / preview traffic
  detachedMs: int('DETACHED_MIN', 10) * 60_000,   // browser closed or reloaded: how long the sandbox waits for a reconnect
  // per-user persistent cache volume (npm / composer / pip caches + node_modules / vendor snapshots): repeated runs skip the install
  userCache: env.USER_CACHE !== '0',
  cacheMaxMb: int('USER_CACHE_MAX_MB', 4096),
  maxZipBytes: int('MAX_ZIP_MB', 60) * 1024 * 1024,
};

// Container ports the gateway can preview (published on 127.0.0.1 with a random host port each).
// Order = preference when several ports listen at once. 8000 PHP/Django/FastAPI · 5173/4173 Vite · 3000 Node/Next/Rails · 8080 Spring/Go/static
// 5000 Flask/ASP.NET · 4200 Angular · 9292 Rack · 4000 Phoenix/Jekyll · 8081/3001/9000/8888/5001/8001 common alternatives
export const PREVIEW_PORTS = [8000, 5173, 3000, 4173, 8080, 5000, 4200, 9292, 4000, 8081, 3001, 9000, 8888, 5001, 8001];
export const PROJECT_DIR = '/home/dev/project';
