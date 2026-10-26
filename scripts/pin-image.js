#!/usr/bin/env node
// Pins the sandbox image's supply chain. Writes image/pins.env with
//   * the content digest of every external base image (FROM / COPY --from)   ->  NODE_IMAGE=node@sha256:…
//   * the sha256 of every downloaded toolchain (Gradle, Kotlin, Zig, Scala, Groovy, PowerShell; both CPU architectures where they differ)
// `npm run build-image` then builds with PINS_STRICT=1: a tampered / changed download or a re-pointed tag fails the build.
//
//   npm run pin-image               first time: record. If pins.env exists, downloads are only VERIFIED against it.
//   npm run pin-image -- --refresh  re-record everything (after bumping a version or tag in image/Dockerfile)
//
// Trust: wherever the publisher provides a checksum (Gradle, Kotlin, Groovy, PowerShell, Zig) the downloaded file is compared with it,
// and the pin is only written when both agree. Scala publishes none: that pin is "trust on first use" (printed as such).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DF = join(root, 'image', 'Dockerfile');
const PINS = join(root, 'image', 'pins.env');
const refresh = process.argv.includes('--refresh');
const df = readFileSync(DF, 'utf8');
const argDefault = (name) => new RegExp(`^ARG ${name}=(.*)$`, 'm').exec(df)?.[1]?.trim();
const v = (n) => argDefault(n);

const old = {};
if (existsSync(PINS) && !refresh) for (const l of readFileSync(PINS, 'utf8').split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l); if (m) old[m[1]] = m[2]; }
const out = {};
let problems = 0;
const tofu = [];
const fail = (msg) => { console.error(msg); problems++; };

// ---- images -------------------------------------------------------------------------------------------------------
const IMAGES = ['BASE_IMAGE', 'NODE_IMAGE', 'COMPOSER_IMAGE', 'DENO_IMAGE', 'UV_IMAGE', 'GO_IMAGE', 'RUST_IMAGE', 'DOTNET_IMAGE', 'JULIA_IMAGE', 'DART_IMAGE', 'IPE_IMAGE'];
for (const k of IMAGES) {
  const tag = argDefault(k);
  if (!tag) { fail(`✗ ${k} not found in image/Dockerfile`); continue; }
  if (old[k]) { out[k] = old[k]; console.log(`• ${k} kept  ${old[k]}`); continue; }
  const pull = spawnSync('docker', ['pull', '-q', tag], { encoding: 'utf8' });
  if (pull.status !== 0) { fail(`✗ docker pull ${tag} failed: ${(pull.stderr || '').trim().split('\n').pop()}`); continue; }
  const d = spawnSync('docker', ['image', 'inspect', '--format', '{{index .RepoDigests 0}}', tag], { encoding: 'utf8' });
  const digest = d.stdout.trim();
  if (d.status !== 0 || !/@sha256:[0-9a-f]{64}$/.test(digest)) { fail(`✗ no digest for ${tag}`); continue; }
  out[k] = digest; console.log(`+ ${k} = ${digest}   (${tag})`);
}

// ---- downloads (same URLs as image/install-extras.sh and the Dockerfile) --------------------------------------------------
const sha256Of = async (url) => {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const h = createHash('sha256');
  for await (const chunk of res.body) h.update(chunk);
  return h.digest('hex');
};
const text = async (url) => { const r = await fetch(url, { redirect: 'follow' }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); };
const firstHash = (t) => /\b([0-9a-f]{64})\b/i.exec(t)?.[1]?.toLowerCase();

// publisher checksum for a file: returns a sha256 string, or null when the publisher offers none
const GRADLE = `https://services.gradle.org/distributions/gradle-${v('GRADLE_VERSION')}-bin.zip`;
const KOTLIN = `https://github.com/JetBrains/kotlin/releases/download/v${v('KOTLIN_VERSION')}/kotlin-compiler-${v('KOTLIN_VERSION')}.zip`;
const GROOVY = `https://archive.apache.org/dist/groovy/${v('GROOVY_VERSION')}/distribution/apache-groovy-binary-${v('GROOVY_VERSION')}.zip`;
const SCALA = `https://github.com/scala/scala3/releases/download/${v('SCALA_VERSION')}/scala3-${v('SCALA_VERSION')}.tar.gz`;
const zigUrl = (a) => `https://ziglang.org/download/${v('ZIG_VERSION')}/zig-linux-${a}-${v('ZIG_VERSION')}.tar.xz`;
const pwshUrl = (pa) => `https://github.com/PowerShell/PowerShell/releases/download/v${v('PWSH_VERSION')}/powershell-${v('PWSH_VERSION')}-linux-${pa}.tar.gz`;
const sidecar = async (url) => firstHash(await text(`${url}.sha256`));

const DOWNLOADS = [
  { key: 'GRADLE_SHA256', url: GRADLE, publisher: () => sidecar(GRADLE) },
  { key: 'KOTLIN_SHA256', url: KOTLIN, publisher: () => sidecar(KOTLIN) },
  { key: 'GROOVY_SHA256', url: GROOVY, publisher: () => sidecar(GROOVY) },
  { key: 'SCALA_SHA256', url: SCALA, publisher: null }, // Scala 3 publishes no checksum file
  { key: 'V_SHA256', url: `https://github.com/vlang/v/releases/download/${v('V_VERSION')}/v_linux.zip`, publisher: null }, // V publishes no checksum file
  ...['x86_64', 'aarch64'].map((a) => ({ key: `ZIG_SHA256_${a.toUpperCase()}`, url: zigUrl(a), publisher: async () => {
    const idx = JSON.parse(await text('https://ziglang.org/download/index.json'));
    return idx[v('ZIG_VERSION')]?.[`${a}-linux`]?.shasum?.toLowerCase() ?? null;
  } })),
  ...[['x86_64', 'x64'], ['aarch64', 'arm64']].map(([a, pa]) => ({ key: `PWSH_SHA256_${a.toUpperCase()}`, url: pwshUrl(pa), publisher: async () => {
    const sums = await text(`https://github.com/PowerShell/PowerShell/releases/download/v${v('PWSH_VERSION')}/hashes.sha256`);
    const line = sums.split(/\r?\n/).find((l) => l.includes(`powershell-${v('PWSH_VERSION')}-linux-${pa}.tar.gz`) && !l.includes('.deb') && !l.includes('.rpm'));
    return line ? firstHash(line) : null;
  } })),
];

for (const { key, url, publisher } of DOWNLOADS) {
  try {
    const got = await sha256Of(url);
    if (old[key] && old[key] !== got) { fail(`✗ ${key}: MISMATCH for ${url}\n    pinned ${old[key]}\n    now    ${got}`); out[key] = old[key]; continue; }
    let how = old[key] ? 'matches the existing pin' : 'TRUST ON FIRST USE (no publisher checksum)';
    if (publisher) {
      let pub = null;
      try { pub = await publisher(); } catch { /* publisher page unreachable: fall back to first use */ }
      if (pub && pub !== got) { fail(`✗ ${key}: the download does NOT match the publisher's checksum for ${url}\n    publisher ${pub}\n    download  ${got}`); continue; }
      if (pub) how = "matches the PUBLISHER's checksum";
      else if (!old[key]) how = "TRUST ON FIRST USE (publisher's checksum could not be fetched)";
    }
    if (how.startsWith('TRUST')) tofu.push(key);
    out[key] = got; console.log(`${old[key] ? '✔' : '+'} ${key} = ${got}\n    ${url}\n    ${how}`);
  } catch (e) { fail(`✗ ${key}: could not download ${url} (${e.message})`); if (old[key]) out[key] = old[key]; }
}

writeFileSync(PINS, `# written by npm run pin-image — commit this file\n${Object.entries(out).map(([k, x]) => `${k}=${x}`).join('\n')}\n`);
if (tofu.length) console.log(`\n⚠ pinned on first use only (nothing to compare against): ${tofu.join(', ')} — compare them once with the project's release page.`);
console.log(problems ? `\n✗ ${problems} problem(s) — fix them and run again. ${PINS} was written with what succeeded; build-image will refuse it.` : `\n✔ ${PINS} written (${Object.keys(out).length} pins).`);
process.exit(problems ? 1 : 0);
