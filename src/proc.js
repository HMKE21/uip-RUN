// Parses /proc/net/tcp + /proc/net/tcp6 text into the TCP ports that are in LISTEN state.
// Returns [{ port, loopbackOnly }] — loopbackOnly means the app bound 127.0.0.1 / ::1 only, which the gateway can't reach.
export function parseListening(text) {
  const byPort = new Map();
  for (const line of String(text).split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4 || cols[3] !== '0A') continue; // 0A = TCP_LISTEN
    const [addr, hexPort] = cols[1].split(':');
    if (!addr || !hexPort) continue;
    const port = parseInt(hexPort, 16);
    const loop = addr === '00000000000000000000000001000000' || (addr.length === 8 && addr.endsWith('7F'));
    byPort.set(port, { port, loopbackOnly: (byPort.get(port)?.loopbackOnly ?? true) && loop });
  }
  return [...byPort.values()];
}

/** Environment for child processes acting for a student: never the gateway's own env (it holds SANDBOX_JWT_SECRET). */
export function cleanEnv(extra = {}) {
  const keep = ['PATH', 'LANG', 'LC_ALL', 'DOCKER_HOST', 'DOCKER_CONFIG', 'DOCKER_CONTEXT', 'XDG_RUNTIME_DIR', 'USER', 'LOGNAME', 'SHELL'];
  const out = {};
  for (const k of keep) if (process.env[k] !== undefined) out[k] = process.env[k];
  return { ...out, ...extra };
}

/** "12.3MB (virtual 1.2GB)" (docker ps --size) -> bytes of the writable layer */
export function parseDockerSize(text) {
  const m = /^\s*([\d.]+)\s*([kKMGT]?B)/.exec(String(text));
  if (!m) return 0;
  const mult = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 }[m[2].toUpperCase()] || 1;
  return Math.round(parseFloat(m[1]) * mult);
}

/** A student app must not plant cookies for the whole preview domain: `Domain=` is removed (cookie becomes host-only). */
export const hostOnlyCookies = (v) => [].concat(v).map((c) => String(c).replace(/;\s*domain\s*=\s*[^;]*/gi, ''));
