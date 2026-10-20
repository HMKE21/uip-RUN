// LOCAL provider — runs the project directly on THIS machine with NO isolation at all.
// Only for development and tests of the gateway itself (SANDBOX_PROVIDER=local). Never use it with real users.
import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PREVIEW_PORTS, PROJECT_DIR } from './config.js';
import { parseListening } from './proc.js';

export const name = 'local';
const root = (sid) => join(tmpdir(), `uip-local-${sid}`);
const proj = (sid) => join(root(sid), 'project');
const procs = new Map(); // sid -> pty

export async function createContainer(sid, _userId) { await mkdir(proj(sid), { recursive: true }); }
export async function portMap() { return Object.fromEntries(PREVIEW_PORTS.map((p) => [p, p])); }
export async function uploadZip(sid, zipPath) {
  await new Promise((res, rej) => execFile('unzip', ['-q', '-o', zipPath, '-d', proj(sid)], (e) => (e && e.code !== 1 ? rej(e) : res())));
}
export async function writeScript(sid, content) { await writeFile(join(root(sid), 'run.sh'), content.replaceAll(PROJECT_DIR, proj(sid))); }
export async function listening() {
  try { return parseListening(`${await readFile('/proc/net/tcp', 'utf8')}\n${await readFile('/proc/net/tcp6', 'utf8').catch(() => '')}`); } catch { return []; }
}
export function spawnTerminal(pty, sid, { cols, rows }) {
  const t = pty.spawn('bash', [join(root(sid), 'run.sh')], { name: 'xterm-256color', cols: cols || 100, rows: rows || 28, cwd: proj(sid), env: { ...process.env, TERM: 'xterm-256color', HOME: root(sid) } });
  procs.set(sid, t);
  return t;
}
export async function killProcesses(sid) { try { procs.get(sid)?.kill(); } catch { /* ignore */ } }
export async function removeContainer(sid) { await killProcesses(sid); procs.delete(sid); await rm(root(sid), { recursive: true, force: true }); }
export async function cleanupLeftovers() { return 0; }
export async function ensureReady() { console.warn('⚠ SANDBOX_PROVIDER=local: projects run on this machine WITHOUT isolation. Development only.'); }
