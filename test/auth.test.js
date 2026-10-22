import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifyToken } from '../src/auth.js';

const SECRET = 'x'.repeat(40);
const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
// same construction as Full-API's SandboxApiController::signHs256 (base64url without padding)
const sig = (h, p, secret) => createHmac('sha256', secret).update(`${h}.${p}`).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const tok = (claims, secret = SECRET) => { const h = b64({ alg: 'HS256', typ: 'JWT' }); const p = b64(claims); return `${h}.${p}.${sig(h, p, secret)}`; };
const NOW = 1_800_000_000;
const ok = { aud: 'uip-sandbox', sub: '7', pid: 'abc', exp: NOW + 60 };

test('accepts a valid token', () => { assert.equal(verifyToken(tok({ ...ok, jti: 'a1-valid-jti' }), SECRET, NOW).sub, '7'); });
test('rejects a wrong secret, expired, wrong audience, alg none, garbage', () => {
  assert.throws(() => verifyToken(tok(ok, 'y'.repeat(40)), SECRET, NOW), /signature/);
  assert.throws(() => verifyToken(tok({ ...ok, exp: NOW - 1 }), SECRET, NOW), /expired/);
  assert.throws(() => verifyToken(tok({ ...ok, aud: 'other' }), SECRET, NOW), /audience/);
  assert.throws(() => verifyToken(`${b64({ alg: 'none' })}.${b64(ok)}.`, SECRET, NOW), /algorithm|malformed/);
  assert.throws(() => verifyToken('nope', SECRET, NOW), /malformed/);
  assert.throws(() => verifyToken(tok(ok), '', NOW), /not configured/);
});
test('a token can be used only once (jti)', () => {
  const t = tok({ ...ok, jti: 'once-0123456789' });
  verifyToken(t, SECRET, NOW);
  assert.throws(() => verifyToken(t, SECRET, NOW), /already used/);
});

test('jti is mandatory', () => {
  assert.throws(() => verifyToken(tok(ok), SECRET, NOW), /jti/);
  assert.throws(() => verifyToken(tok({ ...ok, jti: 'short' }), SECRET, NOW), /jti/);
});
test('long lifetime or wrong issuer refused', () => {
  assert.throws(() => verifyToken(tok({ ...ok, exp: NOW + 86_400, jti: 'long-lived-1' }), SECRET, NOW), /too long/);
  assert.throws(() => verifyToken(tok({ ...ok, iss: 'evil', jti: 'wrong-issuer-1' }), SECRET, NOW), /issuer/);
  assert.equal(verifyToken(tok({ ...ok, iss: 'uip-api', jti: 'right-issuer-1' }), SECRET, NOW).iss, 'uip-api');
});
test('sub / pid must be short non-empty strings', () => {
  assert.throws(() => verifyToken(tok({ ...ok, sub: 7, jti: 'numeric-sub-1' }), SECRET, NOW), /claims/);
  assert.throws(() => verifyToken(tok({ ...ok, pid: '', jti: 'empty-pid-001' }), SECRET, NOW), /claims/);
});
