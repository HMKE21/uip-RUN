import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectZip } from '../src/zipcheck.js';
import { cleanEnv, parseDockerSize, hostOnlyCookies } from '../src/proc.js';

const zipOf = (files) => {
  const dir = mkdtempSync(join(tmpdir(), 'zc-'));
  for (const [n, c] of Object.entries(files)) writeFileSync(join(dir, n), c);
  execFileSync('sh', ['-c', `cd ${dir} && zip -q p.zip ${Object.keys(files).map((f) => `'${f}'`).join(' ')}`]);
  return readFileSync(join(dir, 'p.zip'));
};
const rawZip = (name, usize = 5) => {
  const nb = Buffer.from(name);
  const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(nb.length, 26);
  const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt32LE(usize, 24); cd.writeUInt16LE(nb.length, 28);
  const body = Buffer.concat([lh, nb]); const cdir = Buffer.concat([cd, nb]);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(cdir.length, 12); end.writeUInt32LE(body.length, 16);
  return Buffer.concat([body, cdir, end]);
};

test('zipcheck: normal project passes', () => {
  const r = inspectZip(zipOf({ 'a.txt': 'hello', 'b.txt': 'world!' }));
  assert.equal(r.files, 2); assert.equal(r.bytes, 11);
});
test('zipcheck: zip-slip / absolute / backslash / control names refused', () => {
  for (const n of ['../evil.txt', 'a/../../evil', '/etc/passwd', 'a\\b.txt', 'C:/x', 'a\u0001b']) assert.throws(() => inspectZip(rawZip(n)), /unsafe file name/, n);
  assert.doesNotThrow(() => inspectZip(rawZip('src/ok.txt')));
});
test('zipcheck: bombs and non-zips refused', () => {
  assert.throws(() => inspectZip(rawZip('big.bin', 4_000_000_000), { maxBytes: 1e6 }), /too large/);
  assert.throws(() => inspectZip(zipOf({ a: '1', b: '2', c: '3' }), { maxFiles: 2 }), /too many files/);
  assert.throws(() => inspectZip(Buffer.from('this is not a zip file at all, really not')), /not a zip/);
});
test('cleanEnv never passes gateway secrets', () => {
  process.env.SANDBOX_JWT_SECRET = 'top-secret';
  const e = cleanEnv({ TERM: 'xterm' });
  assert.equal(e.SANDBOX_JWT_SECRET, undefined); assert.equal(e.TERM, 'xterm');
});
test('parseDockerSize', () => {
  assert.equal(parseDockerSize('12.3MB (virtual 1.2GB)'), 12_300_000);
  assert.equal(parseDockerSize('garbage'), 0);
});
test('cookies lose Domain', () => {
  assert.deepEqual(hostOnlyCookies('a=1; Domain=.sbx.example.com; Path=/; HttpOnly'), ['a=1; Path=/; HttpOnly']);
});
