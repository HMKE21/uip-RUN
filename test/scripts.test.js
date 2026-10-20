import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildScript, KINDS } from '../src/scripts.js';
import { parseListening } from '../src/proc.js';

// every generated script must at least be valid bash (bash -n parses without running)
for (const kind of KINDS) {
  for (const previewUrl of ['http://abc.localhost:8787', 'https://abc.preview.example.com']) {
    test(`${kind} script is valid bash (${previewUrl.split(':')[0]})`, () => {
      const s = buildScript({ kind, entry: "my app's main.py", previewUrl, previewDomain: new URL(previewUrl).host.split('.').slice(1).join('.') });
      execFileSync('bash', ['-n'], { input: s });
      assert.match(s, /exec bash -l/);
    });
  }
}
test('unknown kind is rejected', () => { assert.throws(() => buildScript({ kind: 'rm -rf', previewUrl: 'http://a', previewDomain: 'a' }), /unknown kind/); });

test('python: manage.py runs the Django dev server; odd entry names survive the nested shell quoting', () => {
  assert.match(buildScript({ kind: 'python', entry: 'manage.py', previewUrl: 'http://a.localhost', previewDomain: 'localhost' }), /runserver 0\.0\.0\.0:8000/);
  // run the generated script for real, with a fake python3 that prints its arguments
  const dir = mkdtempSync(join(tmpdir(), 'sbx-'));
  writeFileSync(join(dir, 'python3'), '#!/bin/sh\nprintf "ARGS:%s|%s\\n" "$1" "$2"\n', { mode: 0o755 });
  const script = buildScript({ kind: 'python', entry: "my app's main.py", previewUrl: 'http://a.localhost', previewDomain: 'localhost' })
    .replace('cd /home/dev/project\n', `cd ${dir}\n`).replace('exec bash -l\n', '');
  const out = execFileSync('bash', ['-c', script], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } }).toString();
  assert.match(out, /ARGS:-u\|my app's main\.py/);
});

test('https previews make Laravel cookies work inside the IDE frame; http previews do not', () => {
  assert.match(buildScript({ kind: 'laravel', previewUrl: 'https://a.preview.x.com', previewDomain: 'preview.x.com' }), /SESSION_SAME_SITE=none/);
  assert.doesNotMatch(buildScript({ kind: 'laravel', previewUrl: 'http://a.localhost:8787', previewDomain: 'localhost:8787' }), /SESSION_SAME_SITE/);
});
test('laravel serves with php -S (inherits the env) on 0.0.0.0:8000', () => {
  const s = buildScript({ kind: 'laravel', previewUrl: 'http://a.localhost', previewDomain: 'localhost' });
  assert.match(s, /php -S 0\.0\.0\.0:8000/);
  assert.match(s, /composer install/);
  assert.match(s, /artisan migrate/);
});

test('parseListening reads /proc/net/tcp and flags loopback-only listeners', () => {
  const sample = [
    '  sl  local_address rem_address   st tx_queue rx_queue',
    '   0: 00000000:1F40 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000 0 1 1 0 100 0 0 10 0', // 0.0.0.0:8000
    '   1: 0100007F:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000 0 2 1 0 100 0 0 10 0', // 127.0.0.1:5173
    '   2: 0F02000A:C0A8 0A02000A:01BB 01 00000000:00000000 00:00000000 00000000  1000 0 3 1 0 100 0 0 10 0', // established, ignored
    '   3: 00000000000000000000000001000000:0BB8 00000000000000000000000000000000:0000 0A 0 0 0 0 0 0 0 0 0 0 0 0 0', // [::1]:3000
  ].join('\n');
  assert.deepEqual(parseListening(sample), [{ port: 8000, loopbackOnly: false }, { port: 5173, loopbackOnly: true }, { port: 3000, loopbackOnly: true }]);
});

test('node: the 2nd run restores node_modules from the per-user cache instead of installing again', () => {
  const bin = mkdtempSync(join(tmpdir(), 'sbx-bin-'));
  const cache = mkdtempSync(join(tmpdir(), 'sbx-cache-'));
  const log = join(bin, 'calls.log');
  writeFileSync(join(bin, 'npm'), `#!/bin/sh\necho "npm $*" >> "${log}"\nif [ "$1" = install ]; then mkdir -p node_modules/pkg && echo hi > node_modules/pkg/index.js; fi\n`, { mode: 0o755 });
  const run = (ver) => {
    const dir = mkdtempSync(join(tmpdir(), 'sbx-proj-')); // a fresh upload every time: no node_modules
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' }, devDependencies: { vite: ver } }));
    const script = buildScript({ kind: 'node', previewUrl: 'http://a.localhost', previewDomain: 'localhost' })
      .replace('cd /home/dev/project\n', `cd ${dir}\n`).replace('exec bash -l\n', '');
    const out = execFileSync('bash', ['-c', script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, UIP_PCACHE: cache } }).toString();
    return { out, dir };
  };
  const first = run('1.0.0');
  assert.match(first.out, /saved to your cache/);
  const second = run('1.0.0');
  assert.match(second.out, /restored from your cache/);
  assert.equal(readFileSync(join(second.dir, 'node_modules/pkg/index.js'), 'utf8').trim(), 'hi');
  const installs = () => readFileSync(log, 'utf8').split('\n').filter((l) => l.startsWith('npm install')).length;
  assert.equal(installs(), 1, 'npm install must run only once for the same package.json');
  run('2.0.0'); // changed manifest -> different snapshot -> installs again
  assert.equal(installs(), 2);
});

test('without a cache volume the node script still installs normally', () => {
  const bin = mkdtempSync(join(tmpdir(), 'sbx-bin-'));
  const log = join(bin, 'calls.log');
  writeFileSync(join(bin, 'npm'), `#!/bin/sh\necho "npm $*" >> "${log}"\nif [ "$1" = install ]; then mkdir -p node_modules; fi\n`, { mode: 0o755 });
  const dir = mkdtempSync(join(tmpdir(), 'sbx-proj-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' }, devDependencies: { vite: '1.0.0' } }));
  const script = buildScript({ kind: 'node', previewUrl: 'http://a.localhost', previewDomain: 'localhost' })
    .replace('cd /home/dev/project\n', `cd ${dir}\n`).replace('exec bash -l\n', '');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` }; delete env.UIP_PCACHE;
  const out = execFileSync('bash', ['-c', script], { env }).toString();
  assert.match(out, /npm install/);
  assert.doesNotMatch(out, /cache/);
});
