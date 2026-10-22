// The used-token table survives a gateway restart (a stolen token cannot be replayed by waiting for one).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyToken, initJtiStore, pruneJtiStore, _resetJtiStore } from '../src/auth.js';
import { tok } from './helpers.js';

const SECRET = 'x'.repeat(40);
const NOW = Math.floor(Date.now() / 1000);
const claims = (jti, exp = NOW + 120) => ({ aud: 'uip-sandbox', sub: '7', pid: 'p', exp, jti });
const dir = () => join(mkdtempSync(join(tmpdir(), 'jti-')), 'state');

test('a token used before a restart is refused after it', () => {
  const file = join(dir(), 'jti.log');
  initJtiStore(file, NOW);
  const t = tok(claims('before-restart-01'));
  verifyToken(t, SECRET, NOW);
  assert.throws(() => verifyToken(t, SECRET, NOW), /already used/);
  _resetJtiStore();                              // "restart": memory is gone …
  assert.equal(initJtiStore(file, NOW + 5), 1);  // … the file brings the entry back
  assert.throws(() => verifyToken(t, SECRET, NOW + 5), /already used/);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  _resetJtiStore();
});

test('entries expire (not replayable only while the token itself could still be valid) and the file is compacted', () => {
  const file = join(dir(), 'jti.log');
  initJtiStore(file, NOW);
  verifyToken(tok(claims('short-lived-0001', NOW + 30)), SECRET, NOW);
  verifyToken(tok(claims('long-lived-00001', NOW + 120)), SECRET, NOW);
  _resetJtiStore();
  assert.equal(initJtiStore(file, NOW + 60), 1); // the 30 s one has expired
  assert.deepEqual(readFileSync(file, 'utf8').trim().split('\n').map((l) => l.split(' ')[0]), ['long-lived-00001']);
  pruneJtiStore(NOW + 500);
  assert.equal(readFileSync(file, 'utf8'), '');
  _resetJtiStore();
});

test('garbage / torn lines in the file are ignored, valid ones kept', () => {
  const d = dir(); mkdirSync(d, { recursive: true });
  const file = join(d, 'jti.log');
  writeFileSync(file, `good-jti-000001 ${NOW + 100}\nnot a valid line at all\n\x00\x00bad\nhalf-written-jti-0000`);
  assert.equal(initJtiStore(file, NOW), 1);
  assert.throws(() => verifyToken(tok(claims('good-jti-000001')), SECRET, NOW), /already used/);
  _resetJtiStore();
});

test('if the entry cannot be stored the login fails closed', () => {
  const d = dir();
  const file = join(d, 'jti.log');
  initJtiStore(file, NOW);
  rmSync(file); mkdirSync(file);                 // the path now is a directory: appending fails
  assert.throws(() => verifyToken(tok(claims('cannot-store-0001')), SECRET, NOW), /token store unavailable/);
  _resetJtiStore();
});

test('start-up fails if the state directory is unusable', () => {
  const d = dir(); mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'blocker'), 'x');
  assert.throws(() => initJtiStore(join(d, 'blocker', 'jti.log'), NOW));
  _resetJtiStore();
});
