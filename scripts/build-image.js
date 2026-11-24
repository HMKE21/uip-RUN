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

// ---- disk space preflight ----------------------------------------------------------------------------------------------
// A full disk does not stop `docker build` cleanly: tar/unzip steps inside the image fail, the optional tools (cloudflared,
// code-server, Zig…) are silently skipped and a broken image is produced. So check first, clean the safe caches, then decide.
const MIN_FREE_GB = Number(process.env.MIN_FREE_GB || 8);
function freeGb() {
  try {
    const root = spawnSync('docker', ['info', '--format', '{{.DockerRootDir}}'], { encoding: 'utf8' }).stdout.trim() || '/var/lib/docker';
    const out = spawnSync('df', ['-Pk', root], { encoding: 'utf8' }).stdout.trim().split('\n').pop().split(/\s+/);
    const kb = Number(out[3]);
    return Number.isFinite(kb) ? kb / 1024 / 1024 : null;
  } catch { return null; }   // no `df` (Docker Desktop on Windows) → skip the check
}
if (!process.env.SKIP_SPACE_CHECK) {
  let free = freeGb();
  if (free !== null && free < MIN_FREE_GB) {
    console.log(`⚠ only ${free.toFixed(1)} GB free (need ~${MIN_FREE_GB} GB) — removing the Docker build cache and dangling images (running containers and tagged images are untouched)…`);
    spawnSync('docker', ['builder', 'prune', '-af'], { stdio: 'inherit' });
    spawnSync('docker', ['image', 'prune', '-f'], { stdio: 'inherit' });
    free = freeGb();
  }
  if (free !== null && free < MIN_FREE_GB) {
    die(`Not enough disk space to build the image: ${free.toFixed(1)} GB free, ~${MIN_FREE_GB} GB needed.\n`
      + '  Nothing was built (a build on a full disk produces an image without cloudflared / code-server).\n'
      + '  Fix: run  bash scripts/free-space.sh  to see what uses the disk, or enlarge the disk (AWS: EBS volume → 40 GB+, then growpart + xfs_growfs).\n'
      + '  To build anyway:  SKIP_SPACE_CHECK=1 npm run build-image');
  }
}

const args = ['build', '--build-arg', 'PINS_STRICT=1', '-t', 'uip-sandbox:latest'];
for (const [k, x] of Object.entries(pins)) args.push('--build-arg', `${k}=${x}`);
args.push(join(root, 'image'));
const b = spawnSync('docker', args, { stdio: 'inherit' });
if (b.status !== 0) process.exit(b.status ?? 1);

// ---- verify what actually ended up in the image ------------------------------------------------------------------------
// (the public-link button needs cloudflared; the VS Code kind needs code-server; the rest are optional languages)
const TOOLS = { cloudflared: true, 'code-server': true, zig: false, scala: false, groovy: false, pwsh: false, v: false };
const probe = Object.keys(TOOLS).map((t) => `command -v ${t} >/dev/null 2>&1 && echo "OK ${t}" || echo "MISSING ${t}"`).join('; ');
const v = spawnSync('docker', ['run', '--rm', '--pull', 'never', '--network', 'none', '--entrypoint', 'sh', 'uip-sandbox:latest', '-c', probe], { encoding: 'utf8' });
const lines = (v.stdout || '').split('\n').filter(Boolean);
if (!lines.length) console.log('⚠ could not inspect the new image (docker run failed) — check it by hand:  docker run --rm --entrypoint sh uip-sandbox:latest -c "cloudflared --version"');
const absent = lines.filter((l) => l.startsWith('MISSING ')).map((l) => l.slice(8));
console.log(`\nImage check: ${lines.filter((l) => l.startsWith('OK ')).map((l) => l.slice(3)).join(', ') || 'nothing found'}${absent.length ? `  |  missing: ${absent.join(', ')}` : ''}`);
const missingRequired = absent.filter((t) => TOOLS[t]);
if (missingRequired.length) die(`The image was built but is missing required tool(s): ${missingRequired.join(', ')}. Public links / VS Code will not work. Re-run after freeing disk space.`);
if (absent.length) console.log('⚠ optional tools missing (their languages will not run) — usually a full disk or a blocked download during the build.');
process.exit(0);
