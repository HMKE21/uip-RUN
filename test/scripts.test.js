import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
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
