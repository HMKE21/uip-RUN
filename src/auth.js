// Verifies the short-lived HS256 token issued by Full-API (SandboxApiController). Hand-rolled on purpose: one algorithm,
// no `alg` negotiation, constant-time signature check, single use (jti).
import { createHmac, timingSafeEqual } from 'node:crypto';

const AUDIENCE = 'uip-sandbox';
const used = new Map(); // jti -> exp (seconds)

const b64urlToBuf = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const parseJson = (s) => { try { return JSON.parse(b64urlToBuf(s).toString('utf8')); } catch { throw new Error('malformed token'); } };

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
  if (!claims || typeof claims !== 'object') throw new Error('malformed token');
  if (claims.aud !== AUDIENCE) throw new Error('wrong audience');
  if (typeof claims.exp !== 'number' || claims.exp <= now) throw new Error('token expired');
  if (!claims.sub || !claims.pid) throw new Error('missing claims');
  if (claims.jti) {
    for (const [k, exp] of used) if (exp <= now) used.delete(k);
    if (used.has(claims.jti)) throw new Error('token already used');
    used.set(claims.jti, claims.exp);
  }
  return claims;
}
