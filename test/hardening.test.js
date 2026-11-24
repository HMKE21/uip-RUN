import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, chmodSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectZip } from '../src/zipcheck.js';
import { cleanEnv, parseDockerSize, hostOnlyCookies } from '../src/proc.js';
import { parseHardenResult, _DEV_CHECK } from '../src/docker.js';

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

const HARDEN = new URL('../image/harden.sh', import.meta.url).pathname;

test('image/harden.sh: valid sh, wired into the Dockerfile and applied to every new container', () => {
  const sh = readFileSync(HARDEN, 'utf8');
  execFileSync('sh', ['-n', HARDEN]); // syntax only
  assert.match(sh, /perm \/6000/);               // setuid / setgid stripped
  assert.match(sh, /perm -0002/);                // world-writable toolchain dirs closed
  assert.match(sh, /nologin/);                   // service accounts
  assert.match(sh, /PRIV_TOOLS=.*\bsu\b.*\bsudo\b/); // su / sudo root-only
  assert.doesNotMatch(sh, /\brm -rf?\b/);        // never deletes anything a student relies on
  const df = readFileSync(new URL('../image/Dockerfile', import.meta.url), 'utf8');
  assert.match(df, /COPY harden\.sh/);
  assert.match(df, /harden\.sh build/);          // the image build itself fails when something is still open
  assert.match(readFileSync(new URL('../src/docker.js', import.meta.url), 'utf8'), /await hardenContainer\(sid\)/);
});

test('hardenContainer is FAIL-CLOSED: only HARDEN-OK passes', () => {
  assert.equal(parseHardenResult('HARDEN-OK\n').ok, true);
  assert.equal(parseHardenResult('HARDEN-FAIL setuid:/usr/bin/x\nHARDEN-OK').ok, true); // a final OK is what counts (harden.sh re-verifies after apply)
  assert.equal(parseHardenResult('').ok, false);
  assert.equal(parseHardenResult(undefined).ok, false);
  const r = parseHardenResult('HARDEN-FAIL world-writable:/usr/local/cargo/bin\n');
  assert.equal(r.ok, false); assert.deepEqual(r.fails, ['world-writable:/usr/local/cargo/bin']);
  assert.equal(parseHardenResult('sh: 1: find: not found\n').ok, false);
  const src = readFileSync(new URL('../src/docker.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /hardenContainer[\s\S]{0,400}catch \{ return; \}/); // no swallowed errors
  assert.match(_DEV_CHECK, /DEV-OK/);
});

// builds a fake root file tree that looks like the screenshots: world-writable toolchains, setuid su, bash for postgres, open db files
function fakeRoot() {
  const T = mkdtempSync(join(tmpdir(), 'hr-'));
  for (const d of ['etc/mysql', 'etc/postgresql/15/main', 'usr/bin', 'usr/local/cargo/bin', 'usr/local/rustup/tmp', 'usr/local/rustup/toolchains/x/bin', 'var/www/html', 'tmp', 'bin']) mkdirSync(join(T, d), { recursive: true });
  writeFileSync(join(T, 'etc/passwd'), 'root:x:0:0:root:/root:/bin/bash\npostgres:x:102:105::/var/lib/postgresql:/bin/bash\nmysql:x:100:101::/nonexistent:/bin/false\ndev:x:1000:1000::/home/dev:/bin/bash\n');
  writeFileSync(join(T, 'etc/shadow'), 'root:$6$abc:19000:0:99999:7:::\ndev:!:19000:0:99999:7:::\npostgres:$6$x:1::::::\n');
  writeFileSync(join(T, 'etc/mysql/debian.cnf'), 'secret'); chmodSync(join(T, 'etc/mysql/debian.cnf'), 0o644);
  writeFileSync(join(T, 'etc/postgresql/15/main/pg_hba.conf'), 'h');
  for (const t of ['su', 'sudo', 'passwd', 'mount']) { writeFileSync(join(T, 'usr/bin', t), 'x'); chmodSync(join(T, 'usr/bin', t), 0o4755); }
  writeFileSync(join(T, 'usr/bin/ls'), 'y'); chmodSync(join(T, 'usr/bin/ls'), 0o755);
  for (const d of ['usr/local/cargo/bin', 'usr/local/rustup/tmp', 'usr/local/rustup/toolchains/x/bin', 'var/www/html']) chmodSync(join(T, d), 0o777);
  chmodSync(join(T, 'tmp'), 0o1777);
  return T;
}
const harden = (T, mode) => spawnSync('sh', [HARDEN, mode], { env: { ...process.env, HARDEN_ROOT: T }, encoding: 'utf8' });
const mode = (T, f) => statSync(join(T, f)).mode & 0o7777;

test('harden.sh closes every hole seen in the "My PC" terminal and keeps the tools students use', () => {
  const T = fakeRoot();
  const before = harden(T, 'verify');
  assert.notEqual(before.status, 0);
  for (const what of ['privilege-tool:', 'unlocked-account:', 'service-account-shell:postgres', 'db-credentials:', 'setuid:', 'world-writable:']) assert.match(before.stdout, new RegExp(what), what);

  const r = harden(T, 'auto');
  assert.equal(r.status, 0, r.stdout); assert.match(r.stdout.trim().split('\n').at(-1), /^HARDEN-OK$/);
  assert.equal(harden(T, 'verify').status, 0);

  assert.equal(mode(T, 'usr/bin/su'), 0o700);                     // root-only, no setuid
  assert.equal(mode(T, 'usr/bin/ls'), 0o755);                    // ordinary tools untouched
  assert.equal(mode(T, 'usr/local/cargo/bin') & 0o002, 0);       // closed
  assert.equal(mode(T, 'var/www/html') & 0o002, 0);
  assert.equal(mode(T, 'tmp'), 0o1777);                          // sticky /tmp stays shared
  assert.equal(mode(T, 'etc/mysql/debian.cnf') & 0o007, 0);
  assert.match(readFileSync(join(T, 'etc/passwd'), 'utf8'), /postgres:.*:\/usr\/sbin\/nologin/);
  assert.match(readFileSync(join(T, 'etc/passwd'), 'utf8'), /dev:.*:\/bin\/bash/); // the student keeps bash
  assert.doesNotMatch(readFileSync(join(T, 'etc/shadow'), 'utf8'), /\$6\$/);        // no password hash left to crack
});

test('harden.sh: build writes the marker, auto is fast, and a re-opened hole is repaired', () => {
  const T = fakeRoot();
  assert.equal(harden(T, 'build').status, 0);
  assert.equal(readFileSync(join(T, 'etc/uip-hardened'), 'utf8').trim(), '2');
  assert.equal(harden(T, 'auto').status, 0);
  chmodSync(join(T, 'usr/bin/su'), 0o755);                       // somebody re-opens it
  const r = harden(T, 'auto');
  assert.equal(r.status, 0, r.stdout); assert.equal(mode(T, 'usr/bin/su') & 0o077, 0);
});

test('harden.sh: reports failure (exit 1, no HARDEN-OK) when a hole cannot be closed', () => {
  const T = fakeRoot();
  writeFileSync(join(T, 'etc/shadow'), 'root::19000:0:99999:7:::\n'); chmodSync(join(T, 'etc/shadow'), 0o444); // read-only copy: lock can not be written
  const probe = spawnSync('sh', ['-c', `[ -w ${join(T, 'etc/shadow')} ]`]);
  if (probe.status === 0) return; // running as root: read-only bits do not stop the write, nothing to prove here
  const r = harden(T, 'auto');
  assert.equal(r.status, 1); assert.doesNotMatch(r.stdout, /HARDEN-OK/); assert.match(r.stdout, /unlocked-account:root/);
});
