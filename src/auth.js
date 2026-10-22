// Verifies the short-lived HS256 token issued by Full-API (SandboxApiController). Hand-rolled on purpose: one algorithm,
// no `alg` negotiation, constant-time signature check, single use (jti).
// Hardening: jti mandatory, lifetime capped, sub/pid short strings, bounded used-jti table.
// The used-jti table survives a gateway restart (initJtiStore): a stolen token cannot be replayed by waiting for a restart.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const AUDIENCE = 'uip-sandbox';
const ISSUER = 'uip-api';
const MAX_TTL_S = 900;
const MAX_USED = 50_000;
const used = new Map(); // jti -> exp (seconds)
let storeFile = null;   // null = memory only (tests, SANDBOX_PROVIDER=local); set by initJtiStore()

const JTI_RE = /^[A-Za-z0-9_.~:@+=-]{8,128}$/;
const serialize = () => [...used].map(([k, e]) => `${k} ${e}`).join('\n') + (used.size ? '\n' : '');

/** Rewrite the file with only the still-valid entries (atomic: temp file + rename, mode 0600). */
function compact() {
  if (!storeFile) return;
  const tmp = `${storeFile}.tmp`;
  writeFileSync(tmp, serialize(), { mode: 0o600 });
  const fd = openSync(tmp, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, storeFile);
}

/**
 * Load the used-jti table from `file` (created if missing) and keep appending to it. Throws if the file cannot be read or written:
 * the gateway must not start with a replay table it cannot trust. Call once at start-up, before accepting connections.
 */
export function initJtiStore(file, now = Math.floor(Date.now() / 1000)) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  used.clear();
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const [k, e] = line.trim().split(' ');
      const exp = Number(e);
      if (k && JTI_RE.test(k) && Number.isFinite(exp) && exp > now) used.set(k, exp); // torn / garbage lines are skipped
    }
  }
  storeFile = file;
  compact(); // also proves the directory is writable
  return used.size;
}
/** drop expired entries from memory and disk (called periodically by the gateway) */
export function pruneJtiStore(now = Math.floor(Date.now() / 1000)) {
  for (const [k, exp] of used) if (exp <= now) used.delete(k);
  compact();
}
export const _resetJtiStore = () => { used.clear(); storeFile = null; }; // tests only

function remember(jti, exp) {
  if (storeFile) {
    // written (and fsynced) BEFORE the token is accepted: if the entry cannot be stored the login fails closed
    try {
      const fd = openSync(storeFile, 'a', 0o600);
      try { writeSync(fd, `${jti} ${exp}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    } catch { throw new Error('token store unavailable'); }
  }
  used.set(jti, exp);
}

const b64urlToBuf = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const parseJson = (s) => { try { return JSON.parse(b64urlToBuf(s).toString('utf8')); } catch { throw new Error('malformed token'); } };
const idLike = (v) => typeof v === 'string' && v.length > 0 && v.length <= 128;

export function verifyToken(token, secret, now = Math.floor(Date.now() / 1000)) {
  if (!secret) throw new Error('secret not configured');
  if (typeof token !== 'string' || token.length > 4096) throw new Error('malformed token');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const [h, p, s] = parts;
  const header = parseJson(h);
  if (!header || header.alg !== 'HS256') throw new Error('unsupported algorithm');
  const want = createHmac('sha256', secret).update(`${h}.${p}`).digest();
  const got = b64urlToBuf(s);
  if (got.length !== want.length || !timingSafeEqual(got, want)) throw new Error('bad signature');
  const claims = parseJson(p);
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) throw new Error('malformed token');
  if (claims.aud !== AUDIENCE) throw new Error('wrong audience');
  if (claims.iss !== undefined && claims.iss !== ISSUER) throw new Error('wrong issuer');
  if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) || claims.exp <= now) throw new Error('token expired');
  if (claims.exp > now + MAX_TTL_S) throw new Error('token lifetime too long');
  if (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || claims.nbf > now + 30)) throw new Error('token not valid yet');
  if (!idLike(claims.sub) || !idLike(claims.pid)) throw new Error('missing claims');
  if (typeof claims.jti !== 'string' || !JTI_RE.test(claims.jti)) throw new Error('missing jti');
  for (const [k, exp] of used) if (exp <= now) used.delete(k);
  if (used.has(claims.jti)) throw new Error('token already used');
  if (used.size >= MAX_USED) throw new Error('too many tokens');
  remember(claims.jti, claims.exp);
  return claims;
}
