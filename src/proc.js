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
