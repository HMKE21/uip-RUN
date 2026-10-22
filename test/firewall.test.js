// The egress-firewall self-test: (1) the probe script itself, (2) the gateway refuses to start when sandboxes are not isolated.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _PROBE } from '../src/docker.js';

const hasPython = spawnSync('python3', ['-V']).status === 0;

test('probe: reports OPEN for a reachable target, nothing for a dead one, and proves it can detect success (CONTROL-OK)', { skip: !hasPython, timeout: 30_000 }, async () => {
  const srv = net.createServer((c) => c.destroy());
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const out = await new Promise((res) => { const p = spawn('bash', ['-c', _PROBE, '_', `127.0.0.1:${port}`, '127.0.0.1:1']); let b = ''; p.stdout.on('data', (d) => { b += d; }); p.on('close', () => res(b)); });
  srv.close();
  const lines = out.split('\n').map((l) => l.trim());
  assert.ok(lines.includes('CONTROL-OK'));
  assert.ok(lines.includes('DONE'));
  assert.deepEqual(lines.filter((l) => l.startsWith('OPEN ')), [`OPEN 127.0.0.1:${port}`]);
});

// ---- the gateway with a FAKE `docker` on PATH: what the probe container "prints" decides whether it may start
const FAKE = `#!/bin/sh
case "$1" in
  version) echo 27.0;;
  image) case "$*" in *Labels*) echo 6;; esac;;
  network) case "$*" in *Gateway*) echo 172.30.0.1;; *enable_icc*) echo false;; esac;;
  run) case "$*" in
         *"--entrypoint bash"*) [ -z "$FAKE_NO_CONTROL" ] && echo CONTROL-OK; [ -n "$FAKE_LEAK" ] && echo "OPEN $FAKE_LEAK"; echo NET-OK; echo DONE;;
         *) echo cid;; esac;;
  inspect) echo 172.17.0.9;;
esac
exit 0
`;
const startGateway = (extraEnv) => new Promise((resolve) => {
  const bin = mkdtempSync(join(tmpdir(), 'fakedocker-'));
  writeFileSync(join(bin, 'docker'), FAKE); chmodSync(join(bin, 'docker'), 0o755);
  const gw = spawn('node', ['src/server.js'], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PORT: String(20000 + Math.floor(Math.random() * 20000)), SANDBOX_JWT_SECRET: 'x'.repeat(40), SANDBOX_PROVIDER: 'docker', STATE_DIR: mkdtempSync(join(tmpdir(), 'st-')), ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  const done = (state) => { gw.kill('SIGKILL'); resolve({ state, out }); };
  gw.stdout.on('data', (d) => { out += d; if (String(out).includes('listening')) done('started'); });
  gw.stderr.on('data', (d) => { out += d; });
  gw.on('exit', (code) => resolve({ state: 'exited', code, out }));
  setTimeout(() => done('timeout'), 15_000);
});

test('gateway starts when the probe finds no way out', { timeout: 30_000 }, async () => {
  const r = await startGateway({});
  assert.equal(r.state, 'started', r.out);
  assert.match(r.out, /egress firewall verified/);
});
test('gateway REFUSES to start when a sandbox could reach the host', { timeout: 30_000 }, async () => {
  const r = await startGateway({ FAKE_LEAK: '192.168.1.10:4000' });
  assert.equal(r.state, 'exited', r.out); assert.equal(r.code, 1);
  assert.match(r.out, /Refusing to start/); assert.match(r.out, /192\.168\.1\.10:4000/);
});
test('gateway REFUSES to start when the probe itself could not prove anything (no CONTROL-OK)', { timeout: 30_000 }, async () => {
  const r = await startGateway({ FAKE_NO_CONTROL: '1' });
  assert.equal(r.state, 'exited', r.out); assert.equal(r.code, 1);
  assert.match(r.out, /probe container did not run correctly/);
});
test('ALLOW_NO_FIREWALL=1 starts anyway, with a loud warning', { timeout: 30_000 }, async () => {
  const r = await startGateway({ FAKE_LEAK: '192.168.1.10:4000', ALLOW_NO_FIREWALL: '1' });
  assert.equal(r.state, 'started', r.out); assert.match(r.out, /ALLOW_NO_FIREWALL=1/);
});
