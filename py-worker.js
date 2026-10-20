// Python runs here, in a dedicated Web Worker on the runner origin: no DOM, no access to the IDE page,
// and "Stop" simply terminates the worker (works even inside an infinite loop).
// The worker is kept alive between runs and pre-warmed ({type:'warm'}) so the first Run is fast.
import { runPython } from './lib/pyRun.js';
import { PYODIDE_BASE, PYODIDE_LOAD_TIMEOUT_MS } from './config.js';

const say = (type, text) => self.postMessage({ type, text });

const withTimeout = (p, ms, message) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(message)), ms);
  p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
});

let pyPromise = null;
const getPy = () => {
  if (!pyPromise) {
    const load = (async () => {
      say('status', 'Downloading Python engine…');
      say('log', 'Downloading the Python engine (about 10 MB, first run only)…\n');
      const { loadPyodide } = await import(`${PYODIDE_BASE}pyodide.mjs`);
      say('status', 'Starting Python engine…');
      const py = await loadPyodide({ indexURL: PYODIDE_BASE });
      say('log', 'Python engine ready.\n');
      return py;
    })();
    pyPromise = withTimeout(
      load,
      PYODIDE_LOAD_TIMEOUT_MS,
      `Could not load the Python engine from cdn.jsdelivr.net within ${PYODIDE_LOAD_TIMEOUT_MS / 1000}s. `
      + 'Check your internet connection, an ad-blocker/firewall, or the runner\'s Content-Security-Policy, then press Run again.',
    ).catch((e) => { pyPromise = null; throw e; });
  }
  return pyPromise;
};

// tell the runner page the worker script itself loaded (a blocked/never-starting worker is detected by its absence)
self.postMessage({ type: 'alive' });

self.onmessage = async (e) => {
  const m = e.data;
  if (!m) return;
  if (m.type === 'warm') { getPy().catch(() => { /* the real error is reported when the user presses Run */ }); return; }
  if (m.type !== 'run') return;
  try {
    const py = await getPy();
    const res = await runPython(py, {
      files: m.files, root: m.root, entry: m.entry, stdin: m.stdin, skip: m.skip,
      onOut: (text) => self.postMessage({ type: 'out', text }),
      onErr: (text) => self.postMessage({ type: 'err', text }),
      onStatus: (text) => self.postMessage({ type: 'status', text }),
    });
    self.postMessage(res.needInput ? { type: 'need-input', emitted: res.emitted } : { type: 'done', ok: res.ok });
  } catch (err) {
    self.postMessage({ type: 'fail', text: String(err?.message || err?.stack || err) });
  }
};
