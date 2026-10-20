/**
 * runPython — runs a project's entry script inside an already-loaded Pyodide instance.
 * Used by py-worker.js (browser Web Worker) and by the Node tests, so both exercise the same code.
 */

const SKIP_WRITE = /(^|\/)(node_modules|vendor|\.git|__pycache__|\.venv|venv)\//;

const ensureDir = (FS, dir) => { try { FS.mkdirTree(dir); } catch { /* exists */ } };

/** Python tracebacks without Pyodide's own frames (runpy / _pyodide) — students only care about their code. */
export function cleanTraceback(msg) {
  const lines = String(msg).split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i];
    const frame = /^\s+File "([^"]+)", line \d+/.exec(l);
    if (frame && /^(<exec>|<frozen runpy>)$|\/lib\/python[\d.]*(\.zip)?\/(_pyodide|pyodide)\//.test(frame[1])) {
      // skip this frame and its source line(s) / caret line
      while (i + 1 < lines.length && /^\s{4,}\S/.test(lines[i + 1]) && !/^\s+File /.test(lines[i + 1])) i += 1;
      continue;
    }
    out.push(l);
  }
  return out.join('\n').trim();
}

/** module names imported by a python source (top-level only is enough for package loading) */
export function importedModules(src) {
  const set = new Set();
  const re = /^\s*(?:from\s+([A-Za-z_][\w]*)[\w.]*\s+import|import\s+([^\n#]+))/gm;
  let m;
  while ((m = re.exec(src))) {
    if (m[1]) set.add(m[1]);
    else m[2].split(',').forEach((part) => { const n = part.trim().split(/\s+as\s+/)[0].split('.')[0]; if (/^[A-Za-z_]\w*$/.test(n)) set.add(n); });
  }
  return [...set];
}

/**
 * @param {object} pyodide
 * @param {object} o
 * @param {Record<string,Uint8Array>} o.files archive path -> bytes
 * @param {string} o.root     project root prefix inside the archive ('' or 'folder/')
 * @param {string} o.entry    path of the script to run, relative to the root
 * @param {string} [o.stdin]  text served to input()
 * @param {number} [o.skip]   characters of output to swallow: they were already shown by the previous attempt (see needInput)
 * @param {(s:string)=>void} o.onOut
 * @param {(s:string)=>void} o.onErr
 * @param {(s:string)=>void} [o.onStatus]
 * @returns {Promise<{ok:boolean, needInput?:boolean, emitted?:number}>}
 *   needInput: the program called input() with no line left. The caller asks the user for one, then runs again with the
 *   extra line appended to `stdin` and `skip = emitted`, so the replay picks up exactly where the first attempt stopped.
 */
export async function runPython(pyodide, { files, root = '', entry, stdin = '', skip = 0, onOut, onErr, onStatus = () => {} }) {
  const R = root ? `${root.replace(/\/$/, '')}/` : '';
  const base = '/home/pyodide/project';
  const FS = pyodide.FS;

  // fresh project directory every run (files edited / deleted in the IDE must not linger)
  try { pyodide.runPython(`import shutil, os\nshutil.rmtree(${JSON.stringify(base)}, ignore_errors=True)`); } catch { /* first run */ }
  ensureDir(FS, base);
  const pySources = [];
  for (const [path, bytes] of Object.entries(files)) {
    if (!path.startsWith(R) || path.endsWith('/')) continue;
    const rel = path.slice(R.length);
    if (!rel || SKIP_WRITE.test(`/${rel}`) || rel.split('/').includes('..')) continue;
    const full = `${base}/${rel}`;
    ensureDir(FS, full.slice(0, full.lastIndexOf('/')));
    FS.writeFile(full, bytes);
    if (rel.endsWith('.py')) pySources.push(new TextDecoder().decode(bytes));
  }
  const entryFull = `${base}/${entry}`;
  if (!files[`${R}${entry}`]) { onErr(`File not found: ${entry}\n`); return { ok: false }; }

  // stdin for input(): one line per call, then EOF
  const lines = String(stdin).length ? String(stdin).split(/\r?\n/) : [];
  let li = 0; let wantedInput = false;
  pyodide.setStdin({ stdin: () => { if (li < lines.length) return lines[li++]; wantedInput = true; return undefined; } });
  // Raw (unbatched) streams so an input() prompt without a newline ("Username: ") is not lost. Output is re-assembled into
  // whole lines for the console; the unfinished tail is flushed when the program stops or waits for input.
  let skipLeft = Math.max(0, Number(skip) || 0); let emitted = 0;
  const tails = { out: '', err: '' }; const decs = { out: new TextDecoder(), err: new TextDecoder() };
  const sinks = { out: onOut, err: onErr };
  const emit = (kind, text) => {
    emitted += text.length;
    if (skipLeft > 0) { const d = Math.min(skipLeft, text.length); skipLeft -= d; text = text.slice(d); }
    tails[kind] += text;
    const i = tails[kind].lastIndexOf('\n');
    if (i >= 0) { sinks[kind](tails[kind].slice(0, i + 1)); tails[kind] = tails[kind].slice(i + 1); }
  };
  const flushTails = () => { for (const k of ['out', 'err']) if (tails[k]) { sinks[k](tails[k]); tails[k] = ''; } };
  pyodide.setStdout({ write: (buf) => { emit('out', decs.out.decode(buf, { stream: true })); return buf.length; } });
  pyodide.setStderr({ write: (buf) => { emit('err', decs.err.decode(buf, { stream: true })); return buf.length; } });

  // packages that ship with Pyodide (numpy, pandas, …) are fetched on demand from the CDN
  try {
    const mods = new Set(); pySources.forEach((src) => importedModules(src).forEach((m) => mods.add(m)));
    if (mods.size) { onStatus('Loading packages…'); await pyodide.loadPackagesFromImports([...mods].map((m) => `import ${m}`).join('\n')); }
  } catch (err) { onErr(`Could not load packages: ${String(err?.message || err)}\n`); }

  pyodide.globals.set('__uip_entry', entryFull);
  pyodide.globals.set('__uip_root', base);
  const runner = `
import sys, os, runpy, importlib
# modules of the previous run must not survive (the worker is reused between runs)
for _n, _m in list(sys.modules.items()):
    _f = getattr(_m, '__file__', None)
    if _f and str(_f).startswith(__uip_root):
        del sys.modules[_n]
importlib.invalidate_caches()
os.chdir(__uip_root)
if __uip_root not in sys.path: sys.path.insert(0, __uip_root)
sys.argv = [__uip_entry]
__uip_exit = 0
try:
    runpy.run_path(__uip_entry, run_name='__main__')
except SystemExit as _e:
    # sys.exit() must never reach Pyodide's event loop
    __uip_exit = _e.code if isinstance(_e.code, int) else (0 if _e.code is None else 1)
    if _e.code not in (None, 0) and not isinstance(_e.code, int):
        print(_e.code, file=sys.stderr)
`;
  const MAX_INSTALLS = 6;
  const tried = new Set();
  for (let attempt = 0; attempt <= MAX_INSTALLS; attempt += 1) {
    try {
      onStatus('Running…');
      await pyodide.runPythonAsync(runner);
      const code = pyodide.globals.get('__uip_exit');
      flushTails();
      if (code) onErr(`Process exited with code ${code}\n`);
      return { ok: !code };
    } catch (err) {
      const msg = String(err?.message || err);
      const miss = /ModuleNotFoundError: No module named '([\w.]+)'/.exec(msg);
      const name = miss ? miss[1].split('.')[0] : null;
      if (name && !tried.has(name) && attempt < MAX_INSTALLS) {
        // not a Pyodide package: try a pure-python wheel from PyPI
        tried.add(name);
        try {
          onStatus(`Installing ${name} from PyPI…`);
          await pyodide.loadPackage('micropip');
          const micropip = pyodide.pyimport('micropip');
          await micropip.install(name);
          continue;
        } catch { /* fall through to showing the original error */ }
      }
      if (wantedInput && /EOFError: EOF when reading a line/.test(msg)) { flushTails(); return { ok: false, needInput: true, emitted }; }
      flushTails();
      onErr(`${cleanTraceback(msg)}\n`);
      if (/EOFError: EOF when reading a line/.test(msg)) {
        onErr('\n💡 البرنامج طلب input() بس مفيش مدخلات متاحة. اكتب القيم في مربع «مدخلات input()» تحت (سطر لكل input بالترتيب) ثم اضغط تشغيل.\n'
          + '💡 The program called input() but no input was left. Type the values in the “Input for input()” box below (one line per call, in order), then press Run.\n');
      }
      return { ok: false };
    }
  }
  return { ok: false };
}
