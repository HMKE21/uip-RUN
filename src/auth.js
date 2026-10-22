// Verifies the short-lived HS256 token issued by Full-API (SandboxApiController). Hand-rolled on purpose: one algorithm,
// no `alg` negotiation, constant-time signature check, single use (jti).
// Hardening: jti mandatory, lifetime capped, sub/pid short strings, bounded used-jti table.
import { createHmac, timingSafeEqual } from 'node:crypto';

const AUDIENCE = 'uip-sandbox';
const ISSUER = 'uip-api';
const MAX_TTL_S = 900;
const MAX_USED = 50_000;
const used = new Map(); // jti -> exp (seconds)

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
  if (typeof claims.jti !== 'string' || claims.jti.length < 8 || claims.jti.length > 128) throw new Error('missing jti');
  for (const [k, exp] of used) if (exp <= now) used.delete(k);
  if (used.has(claims.jti)) throw new Error('token already used');
  if (used.size >= MAX_USED) throw new Error('too many tokens');
  used.set(claims.jti, claims.exp);
  return claims;
}
