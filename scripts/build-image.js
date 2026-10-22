#!/usr/bin/env node
// Builds uip-sandbox:latest from the PINNED supply chain (image/pins.env). Creates / verifies the pins first.
// A build that is missing any pin, or whose pins do not match the downloads, is refused (PINS_STRICT=1).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PINS = join(root, 'image', 'pins.env');
const die = (m) => { console.error(`\n✗ ${m}\n`); process.exit(1); };

console.log(existsSync(PINS) ? 'Verifying image/pins.env against the downloads…' : 'No image/pins.env yet — pinning the image supply chain first (one time)…');
const p = spawnSync(process.execPath, [join(root, 'scripts', 'pin-image.js')], { stdio: 'inherit' });
if (p.status !== 0) die('Pinning / verification failed. Nothing was built (an unpinned build is refused).');

const pins = {};
for (const l of readFileSync(PINS, 'utf8').split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.+)$/.exec(l); if (m) pins[m[1]] = m[2]; }
const REQUIRED = ['BASE_IMAGE', 'NODE_IMAGE', 'IPE_IMAGE', 'GRADLE_SHA256', 'KOTLIN_SHA256', 'GROOVY_SHA256', 'SCALA_SHA256', 'ZIG_SHA256_X86_64', 'ZIG_SHA256_AARCH64', 'PWSH_SHA256_X86_64', 'PWSH_SHA256_AARCH64'];
const missing = REQUIRED.filter((k) => !pins[k]);
if (missing.length) die(`image/pins.env is incomplete (${missing.join(', ')}). Run: npm run pin-image -- --refresh`);

const args = ['build', '--build-arg', 'PINS_STRICT=1', '-t', 'uip-sandbox:latest'];
for (const [k, x] of Object.entries(pins)) args.push('--build-arg', `${k}=${x}`);
args.push(join(root, 'image'));
const b = spawnSync('docker', args, { stdio: 'inherit' });
process.exit(b.status ?? 1);
