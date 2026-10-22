// image/fetch-verified.sh + image/install-extras.sh: exit codes decide "skip this language" vs "stop the build".
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FV = new URL('../image/fetch-verified.sh', import.meta.url).pathname;
const EX = new URL('../image/install-extras.sh', import.meta.url).pathname;
const d = mkdtempSync(join(tmpdir(), 'supply-'));
writeFileSync(join(d, 'f.txt'), 'hello\n');
const sha = createHash('sha256').update('hello\n').digest('hex');
const fv = (want, env = {}) => spawnSync('sh', [FV, `file://${join(d, 'f.txt')}`, join(d, 'out'), want], { env: { ...process.env, ...env }, encoding: 'utf8' });

test('fetch-verified: matching checksum -> 0', () => { assert.equal(fv(sha).status, 0); assert.ok(existsSync(join(d, 'out'))); });
test('fetch-verified: wrong checksum -> 3 and the file is deleted', () => { const r = fv('0'.repeat(64)); assert.equal(r.status, 3); assert.match(r.stderr, /MISMATCH/); assert.ok(!existsSync(join(d, 'out'))); });
test('fetch-verified: no pin + PINS_STRICT=1 -> 3', () => { assert.equal(fv('', { PINS_STRICT: '1' }).status, 3); });
test('fetch-verified: no pin, not strict -> 0 with a warning', () => { const r = fv(''); assert.equal(r.status, 0); assert.match(r.stderr, /UNVERIFIED/); });
test('fetch-verified: download failure -> 1 (the language may be skipped)', () => {
  assert.equal(spawnSync('sh', [FV, `file://${join(d, 'nope')}`, join(d, 'o2'), sha], { encoding: 'utf8' }).status, 1);
});

const extras = (rc) => {
  const bin = mkdtempSync(join(tmpdir(), 'stub-'));
  writeFileSync(join(bin, 'fetch-verified'), `#!/bin/sh\nexit ${rc}\n`); chmodSync(join(bin, 'fetch-verified'), 0o755);
  return spawnSync('bash', [EX], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ZIG_VERSION: '1', SCALA_VERSION: '1', GROOVY_VERSION: '1', PWSH_VERSION: '1' }, encoding: 'utf8' });
};
test('install-extras: a failed download only skips the language (exit 0)', () => { const r = extras(1); assert.equal(r.status, 0); assert.match(r.stdout, /Zig not installed/); });
test('install-extras: a checksum problem aborts the build (exit 1)', () => { const r = extras(3); assert.equal(r.status, 1); assert.match(r.stderr, /checksum problem/); });
