// Docker provider: one locked-down container per session. Talks to the local Docker daemon through the CLI
// (arguments are always passed as an array — never through a shell).
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { cfg, PREVIEW_PORTS, PROJECT_DIR } from './config.js';
import { parseListening } from './proc.js';

const run = promisify(execFile);
const docker = (args, opts = {}) => run('docker', args, { maxBuffer: 8 * 1024 * 1024, timeout: 120_000, ...opts });

export const name = 'docker';
export const containerName = (sid) => `uip-sbx-${sid}`;

const cacheVolume = (userId) => `uip-cache-${createHash('sha1').update(String(userId)).digest('hex').slice(0, 12)}`;
const CACHE_DIR = '/home/dev/.pcache';

/** one Docker volume per user (never shared between users); created on first use and handed to the unprivileged `dev` user */
async function ensureCache(userId) {
  const v = cacheVolume(userId);
  try { await docker(['volume', 'inspect', v], { timeout: 15_000 }); return v; } catch { /* not there yet */ }
  await docker(['volume', 'create', '--label', 'uip.cache=1', v], { timeout: 15_000 });
  await docker(['run', '--rm', '-u', '0', '--cap-drop', 'ALL', '--cap-add', 'CHOWN', '--network', 'none', '-v', `${v}:/c`, '--entrypoint', 'chown', cfg.image, '1000:1000', '/c'], { timeout: 60_000 });
  return v;
}

export async function createContainer(sid, userId) {
  let cache = null;
  if (cfg.userCache && userId != null) { try { cache = await ensureCache(userId); } catch (e) { console.error('cache volume unavailable:', String(e.message).split('\n')[0]); } }
  await docker([
    'run', '-d', '--init', '--name', containerName(sid),
    '--label', 'uip.sandbox=1',
    '--cpus', cfg.cpus, '--memory', cfg.memory, '--memory-swap', cfg.memory, '--pids-limit', String(cfg.pids),
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--ulimit', 'nofile=4096:4096', '--ulimit', 'core=0',
    '--network', cfg.network,
    ...(cfg.runtime ? ['--runtime', cfg.runtime] : []),
    ...(cache ? ['-v', `${cache}:${CACHE_DIR}`, '-e', `UIP_PCACHE=${CACHE_DIR}`, '-e', `UIP_CACHE_MAX_MB=${cfg.cacheMaxMb}`] : []),
    ...PREVIEW_PORTS.flatMap((p) => ['-p', `127.0.0.1::${p}`]),
    cfg.image, 'sleep', 'infinity',
  ]);
}

/** host port that Docker mapped to each previewable container port: { 8000: 49153, … } */
export async function portMap(sid) {
  const { stdout } = await docker(['port', containerName(sid)]);
  const map = {};
  for (const line of stdout.split('\n')) {
    const m = /^(\d+)\/tcp -> [\d.]+:(\d+)$/.exec(line.trim());
    if (m) map[Number(m[1])] = Number(m[2]);
  }
  return map;
}

/** put the project zip into the container and unpack it into the project folder */
export async function uploadZip(sid, zipPath) {
  const c = containerName(sid);
  await docker(['cp', zipPath, `${c}:/tmp/project.zip`]);
  await docker(['exec', '-u', 'dev', c, 'sh', '-c',
    // `docker cp` leaves the zip owned by root inside the sticky /tmp, so the unprivileged `dev` user can read it but NOT delete it:
    // a plain `rm -f` then fails with "Operation not permitted" and the whole command is reported as failed even though the
    // unzip worked. So: ignore the cleanup result, and accept unzip's exit code 1 (= finished with warnings, files extracted).
    `mkdir -p ${PROJECT_DIR} && { unzip -q -o /tmp/project.zip -d ${PROJECT_DIR}; rc=$?; rm -f /tmp/project.zip 2>/dev/null; [ "$rc" -le 1 ]; }`]);
}

/** write /tmp/run.sh inside the container (content goes through stdin) */
export function writeScript(sid, content) {
  return new Promise((resolve, reject) => {
    const p = spawn('docker', ['exec', '-i', '-u', 'dev', containerName(sid), 'sh', '-c', 'cat > /tmp/run.sh']);
    p.on('error', reject);
    p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`write failed (${c})`))));
    p.stdin.end(content);
  });
}

/** ports currently LISTENing inside the container */
export async function listening(sid) {
  try {
    const { stdout } = await docker(['exec', containerName(sid), 'sh', '-c', 'cat /proc/net/tcp /proc/net/tcp6'], { timeout: 8000 });
    return parseListening(stdout);
  } catch { return []; }
}

/** the terminal: an interactive bash running the generated script, attached to a PTY */
export function spawnTerminal(pty, sid, { cols, rows }) {
  return pty.spawn('docker', ['exec', '-it', '-u', 'dev', '-w', PROJECT_DIR, '-e', 'TERM=xterm-256color', containerName(sid), 'bash', '/tmp/run.sh'], {
    name: 'xterm-256color', cols: cols || 100, rows: rows || 28, env: { ...process.env },
  });
}

/** killing the `docker exec` client does not stop what it started inside the container */
export async function killProcesses(sid) {
  try { await docker(['exec', '-u', 'dev', containerName(sid), 'sh', '-c', 'kill -9 -1 || true'], { timeout: 15_000 }); } catch { /* ignore */ }
}

export async function removeContainer(sid) {
  try { await docker(['rm', '-f', containerName(sid)], { timeout: 30_000 }); } catch { /* already gone */ }
}

/** delete containers left behind by a previous gateway process */
export async function cleanupLeftovers() {
  try {
    const { stdout } = await docker(['ps', '-aq', '--filter', 'label=uip.sandbox=1']);
    const ids = stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    if (ids.length) await docker(['rm', '-f', ...ids]);
    return ids.length;
  } catch (e) { console.error('cleanup failed:', e.message); return 0; }
}

export async function ensureReady() {
  await docker(['version', '--format', '{{.Server.Version}}'], { timeout: 10_000 });
  try { await docker(['image', 'inspect', cfg.image]); } catch { throw new Error(`Image ${cfg.image} not found — build it: docker build -t ${cfg.image} image/`); }
  try { await docker(['network', 'inspect', cfg.network]); } catch { await docker(['network', 'create', cfg.network]); }
}
