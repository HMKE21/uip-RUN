// UIP project runner shell. Lives on its OWN origin so student code can never touch the UIP app's session.
// Protocol (postMessage, parent <-> this page):
//   parent -> runner : {uip:'hello'} | {uip:'run', id, kind:'web'|'python', files, root, entry, stdin} | {uip:'stop'}
//   runner -> parent : {uip:true, type:'ready'|'status'|'log'|'done', id, ...}
import { ALLOWED_PARENTS, ESBUILD_WASM_URL, ESBUILD_WASM_SRI, PYTHON_TIMEOUT_MS, PYTHON_BOOT_TIMEOUT_MS, RUN_HARD_CAP_MS } from './config.js';
import { buildWeb } from './lib/buildWeb.js';

const stage = document.getElementById('stage');
const idle = document.getElementById('idle');
let parentOrigin = null;
let current = null; // { id, worker?, iframe?, timer? }
let esbuildReady = null;

const post = (msg) => { if (parentOrigin) window.parent.postMessage({ uip: true, ...msg }, parentOrigin); };
const log = (id, level, text) => post({ type: 'log', id, level, text });
const status = (id, state, text) => post({ type: 'status', id, state, text });

// One long-lived Python worker, started early (pre-warmed) so Pyodide is already loaded when the student presses Run.
let pyWorker = null;
function killPyWorker() { if (pyWorker) { pyWorker.w.terminate(); pyWorker = null; } }
function getPyWorker() {
  if (pyWorker) return pyWorker;
  const w = new Worker(new URL('./py-worker.js', import.meta.url), { type: 'module' });
  const handle = { w, alive: false };
  pyWorker = handle;
  w.onmessage = (e) => {
    const m = e.data || {};
    if (m.type === 'alive') { handle.alive = true; if (current) clearTimeout(current.boot); return; }
    const c = current;
    if (!c || !c.py || pyWorker !== handle) return; // warm-up chatter or a stale worker
    const id = c.id;
    if (m.type === 'log') log(id, 'system', m.text.replace(/\n$/, ''));
    else if (m.type === 'out') log(id, 'stdout', m.text);
    else if (m.type === 'err') log(id, 'stderr', m.text);
    else if (m.type === 'status') {
      status(id, 'building', m.text);
      if (m.text === 'Running…' && !c.timer) c.timer = setTimeout(() => stop(`Stopped: the program ran longer than ${PYTHON_TIMEOUT_MS / 1000}s (infinite loop?).`), PYTHON_TIMEOUT_MS);
    } else if (m.type === 'need-input') { finishPy(c); post({ type: 'need-input', id, emitted: m.emitted }); status(id, 'input', 'Waiting for input'); }
    else if (m.type === 'done') { finishPy(c); status(id, m.ok ? 'done' : 'error', m.ok ? 'Finished' : 'Finished with errors'); }
    else if (m.type === 'fail') { finishPy(c); log(id, 'stderr', `${m.text}\n`); status(id, 'error', 'Failed'); }
  };
  w.onerror = (e) => {
    const c = current;
    if (pyWorker === handle) pyWorker = null;
    if (c?.py) {
      clearTimers(c);
      log(c.id, 'stderr', `Python worker failed to start${e?.message ? `: ${e.message}` : ' (the worker script was blocked or could not be loaded)'}\n`);
      status(c.id, 'error', 'Failed');
      current = null; idle.hidden = false;
    }
  };
  w.postMessage({ type: 'warm' });
  return handle;
}

function clearTimers(c) { clearTimeout(c.timer); clearTimeout(c.boot); clearTimeout(c.hard); }
function finishPy(c) { clearTimers(c); if (current === c) current = null; idle.hidden = false; }

function stop(reason) {
  if (!current) return;
  const c = current; current = null;
  clearTimers(c);
  if (c.py) { killPyWorker(); setTimeout(getPyWorker, 0); } // a fresh warm worker is ready for the next Run
  if (c.iframe) c.iframe.remove();
  idle.hidden = false;
  if (reason) { log(c.id, 'system', reason); status(c.id, 'stopped'); }
}

function ensureEsbuild() {
  if (!esbuildReady) {
    esbuildReady = (async () => {
      if (!window.esbuild) throw new Error('esbuild-wasm failed to load (blocked network?).');
      const wasmModule = await WebAssembly.compileStreaming(fetch(ESBUILD_WASM_URL, { integrity: ESBUILD_WASM_SRI, credentials: 'omit' }));
      await window.esbuild.initialize({ wasmModule, worker: true });
      return window.esbuild;
    })().catch((e) => { esbuildReady = null; throw e; });
  }
  return esbuildReady;
}

async function runWeb(msg) {
  const { id } = msg;
  status(id, 'building', 'Building…');
  const esbuild = await ensureEsbuild();
  if (current?.id !== id) return; // stopped meanwhile
  const t0 = performance.now();
  const { html, warnings, imports } = await buildWeb({ esbuild, files: msg.files, root: msg.root || '', answers: msg.answers, skip: msg.skip });
  if (current?.id !== id) return;
  warnings.forEach((w) => log(id, 'warn', w));
  const pkgs = Object.keys(imports).filter((k) => !k.endsWith('/'));
  log(id, 'system', `Built in ${Math.round(performance.now() - t0)} ms${pkgs.length ? ` · packages from esm.sh: ${pkgs.join(', ')}` : ''}`);

  const iframe = document.createElement('iframe');
  // NO `allow-modals`: native alert/confirm/prompt must never open (they freeze the tab and look like a message from the platform).
  // The preview gets safe replacements instead (see PREVIEW_SHIM in lib/buildWeb.js).
  iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-downloads');
  iframe.title = 'Project preview';
  current.iframe = iframe;
  iframe.addEventListener('load', () => { if (current?.id === id) status(id, 'running', 'Preview ready'); });
  iframe.srcdoc = html;
  idle.hidden = true;
  stage.appendChild(iframe);
}

function runPy(msg) {
  const { id } = msg;
  status(id, 'building', 'Starting Python…');
  if (!msg.skip) log(id, 'system', 'Starting Python…');
  const c = current; c.py = true;
  const handle = getPyWorker();
  // the worker must come alive quickly; if it never does, something (CSP / network / cache) blocked it
  if (!handle.alive) {
    c.boot = setTimeout(() => {
      if (current !== c) return;
      log(id, 'stderr', 'The Python worker did not start. The runner site may be blocking its own scripts (check the runner\'s Content-Security-Policy / headers) or the network is blocked.\n');
      status(id, 'error', 'Failed');
      killPyWorker(); clearTimers(c); current = null; idle.hidden = false;
    }, PYTHON_BOOT_TIMEOUT_MS);
  }
  c.hard = setTimeout(() => stop(`Stopped: the run took longer than ${RUN_HARD_CAP_MS / 1000}s in total.`), RUN_HARD_CAP_MS);
  handle.w.postMessage({ type: 'run', files: msg.files, root: msg.root || '', entry: msg.entry, stdin: msg.stdin || '', skip: msg.skip || 0 });
}

async function run(msg) {
  stop();
  current = { id: msg.id };
  try {
    if (msg.kind === 'web') await runWeb(msg);
    else if (msg.kind === 'python') runPy(msg);
    else throw new Error(`Unsupported project type: ${msg.kind}`);
  } catch (err) {
    log(msg.id, 'stderr', `${String(err?.message || err)}\n`);
    status(msg.id, 'error', 'Build failed');
    if (current?.id === msg.id) { clearTimers(current); current = null; idle.hidden = false; }
  }
}

window.addEventListener('message', (e) => {
  // 1) console output coming from the preview iframe (same origin as this page)
  if (current?.iframe && e.source === current.iframe.contentWindow && e.data?.uipPreview) {
    if (e.data.type === 'need-input') {
      // the program called prompt()/confirm() while starting: show the question in the IDE's own console, then re-run with the answer
      const c = current; const id = c.id;
      const kind = e.data.kind === 'confirm' ? 'confirm' : 'prompt';
      const question = String(e.data.text ?? '').slice(0, 500);
      c.iframe.remove(); current = null; clearTimers(c); idle.hidden = false;
      log(id, 'stdout', `${question}${kind === 'confirm' ? ' (y/n)' : ''} `);
      post({ type: 'need-input', id, kind, emitted: Number(e.data.emitted) || 0 });
      status(id, 'input', 'Waiting for input');
      return;
    }
    log(current.id, e.data.level === 'warn' ? 'warn' : e.data.level === 'error' ? 'error' : 'log', String(e.data.text).slice(0, 4000));
    return;
  }
  // 2) commands: only from the embedding IDE, only from an allowed origin
  if (e.source !== window.parent || !ALLOWED_PARENTS.includes(e.origin)) return;
  const m = e.data;
  if (!m || typeof m !== 'object') return;
  parentOrigin = e.origin;
  if (m.uip === 'hello') { post({ type: 'ready' }); getPyWorker(); }
  else if (m.uip === 'stop') stop('Stopped.');
  else if (m.uip === 'run') run(m);
});
