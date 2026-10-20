/**
 * buildWeb — turns a project's files (React/Vite, plain HTML/CSS/JS) into ONE self-contained HTML document
 * that the runner shows in a sandboxed iframe (srcdoc). No server, no npm install:
 *   - local modules are bundled by esbuild (esbuild-wasm in the browser, native esbuild in tests)
 *   - npm packages are NOT bundled: they are resolved by the page's import map to esm.sh
 *   - CSS / images / fonts are inlined
 * `esbuild` is injected so the exact same code runs in the browser and in Node tests.
 */

export const ESM_CDN = 'https://esm.sh';
export const DEFAULT_REACT = '18.3.1';

const dec = new TextDecoder();
const text = (u8) => dec.decode(u8);

export const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/^\.?\//, '');
const dirOf = (p) => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); };
const extOf = (p) => { const m = /\.([a-z0-9]+)$/i.exec(p.split('?')[0]); return m ? m[1].toLowerCase() : ''; };

/** resolve `rel` against directory `base` ('' = root). Returns null if it escapes the root. */
export function joinPath(base, rel) {
  const out = base ? base.split('/') : [];
  for (const part of String(rel).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!out.length) return null; out.pop(); } else out.push(part);
  }
  return out.join('/');
}

const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon',
  svg: 'image/svg+xml', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', mp3: 'audio/mpeg', wav: 'audio/wav',
  mp4: 'video/mp4', webm: 'video/webm', json: 'application/json', css: 'text/css', js: 'text/javascript', html: 'text/html', txt: 'text/plain',
};
const ASSET_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'svg', 'woff', 'woff2', 'ttf', 'otf', 'mp3', 'wav', 'mp4', 'webm']);
const RESOLVE_EXT = ['', '.tsx', '.ts', '.jsx', '.js', '.mjs', '.cjs', '.json', '.css'];
const MAX_INLINE_ASSET = 2 * 1024 * 1024;

function toBase64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
export const dataUri = (u8, path) => `data:${MIME[extOf(path)] || 'application/octet-stream'};base64,${toBase64(u8)}`;

const isRemote = (u) => /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(u);

/** "^18.2.0" -> kept as a range esm.sh understands; workspace:/file:/git/latest/* -> '' (= latest) */
export function esmVersion(range) {
  const r = String(range || '').trim();
  if (/^[\^~]?\d[\w.+-]*$/.test(r) || /^[><=]+\s*\d/.test(r)) return r.replace(/\s+/g, '');
  return '';
}
function pkgOf(spec) {
  const parts = spec.split('/');
  const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  return { name, sub: spec.slice(name.length) };
}

function parseEnv(src) {
  const out = {};
  for (const line of src.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

/**
 * Bridge injected into the preview page (talks to the runner shell, which relays it to the IDE).
 *  - console.* / errors are forwarded to the IDE console.
 *  - alert / confirm / prompt are REPLACED. The preview iframe has no `allow-modals`, so native dialogs never open
 *    (they can freeze the tab, can be looped forever and, worse, look like a message from the platform itself).
 *    alert()   -> logged to the console + a small non-blocking banner inside the preview.
 *    prompt()/confirm() while the page is still starting up -> the program is paused, the IDE shows its OWN input line,
 *      and the page is re-run with the collected answers (same idea as input() in Python). Output that was already
 *      shown is skipped on the re-run (`skip`).
 *    prompt()/confirm() after the page has loaded (inside a click handler…) can not pause the program -> they return
 *      null / false and say so in the console.
 * Written as a real function so it is readable and testable; it is serialised into the page with toString().
 */
function previewBridge(opts) {
  var P = window.parent;
  var answers = (opts && opts.answers) || [];
  var skip = (opts && opts.skip) || 0;
  var used = 0, emitted = 0, loaded = false, waiting = false;
  function send(l, t) { try { P.postMessage({ uipPreview: true, type: 'console', level: l, text: t }, '*'); } catch (e) {} }
  function ser(a) {
    try {
      if (a instanceof Error) return a.stack || String(a);
      if (typeof a === 'string') return a;
      if (a === undefined) return 'undefined';
      return JSON.stringify(a, function (k, v) {
        if (typeof v === 'function') return '[Function]';
        if (typeof Node !== 'undefined' && v instanceof Node) return '<' + v.nodeName + '>';
        return v;
      });
    } catch (e) { return String(a); }
  }
  // every line of output counts, so a re-run can skip exactly the lines that were already shown
  function out(l, t) { if (waiting) return; emitted++; if (emitted <= skip) return; send(l, t); }
  ['log', 'info', 'warn', 'error', 'debug'].forEach(function (l) {
    var o = console[l];
    console[l] = function () { var a = [].slice.call(arguments); out(l, a.map(ser).join(' ')); return o.apply(console, a); };
  });
  window.addEventListener('load', function () { loaded = true; });
  window.addEventListener('error', function (e) {
    if (waiting || (e.error && e.error.__uipInput)) { e.preventDefault(); return; }
    out('error', (e.message || 'Error') + (e.filename ? ' (' + String(e.filename).split('/').pop() + ':' + e.lineno + ')' : ''));
  });
  window.addEventListener('unhandledrejection', function (e) {
    if (waiting || (e.reason && e.reason.__uipInput)) { e.preventDefault(); return; }
    out('error', 'Unhandled promise rejection: ' + ser(e.reason));
  });

  // a small, non-blocking banner (styled by us, clearly labelled, auto-dismissed)
  function banner(text) {
    try {
      var host = document.getElementById('__uip_alerts');
      if (!host) {
        host = document.createElement('div'); host.id = '__uip_alerts';
        host.style.cssText = 'position:fixed;z-index:2147483647;left:50%;bottom:14px;transform:translateX(-50%);display:flex;flex-direction:column;gap:6px;max-width:min(92vw,420px);pointer-events:none;font:13px/1.4 system-ui,sans-serif';
        (document.body || document.documentElement).appendChild(host);
      }
      var b = document.createElement('div');
      b.style.cssText = 'background:#111827;color:#f9fafb;border:1px solid #374151;border-radius:10px;padding:9px 12px;box-shadow:0 8px 24px rgba(0,0,0,.35);white-space:pre-wrap;word-break:break-word;direction:auto';
      var tag = document.createElement('div'); tag.textContent = 'alert (UIP preview)'; tag.style.cssText = 'font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:#9ca3af;margin-bottom:2px';
      var body = document.createElement('div'); body.textContent = String(text).slice(0, 600);
      b.appendChild(tag); b.appendChild(body); host.appendChild(b);
      setTimeout(function () { try { b.remove(); } catch (e) {} }, 5000);
    } catch (e) {}
  }
  window.alert = function (m) {
    var t = m === undefined ? '' : String(m);
    if (waiting) return;
    emitted++; if (emitted <= skip) return;
    send('log', '[alert] ' + t); banner(t);
  };
  function ask(kind, text) {
    if (used < answers.length) return { ok: true, value: String(answers[used++]) };
    if (loaded || waiting) {
      if (!waiting) out('warn', kind + '() cannot wait for an answer after the page has loaded; it returned ' + (kind === 'confirm' ? 'false' : 'null') + '. Use an <input> / a custom dialog instead.');
      return { ok: false };
    }
    waiting = true;
    try { P.postMessage({ uipPreview: true, type: 'need-input', kind: kind, text: String(text === undefined ? '' : text), emitted: emitted }, '*'); } catch (e) {}
    var err = new Error('UIP: waiting for input'); err.__uipInput = true; throw err; // stops the program right here
  }
  window.prompt = function (m, def) {
    var r = ask('prompt', m);
    if (!r.ok) return null;
    return r.value === '' && def !== undefined && def !== null ? String(def) : r.value;
  };
  window.confirm = function (m) {
    var r = ask('confirm', m);
    return r.ok && /^\s*(y|yes|ok|true|1|نعم|أيوه|ايوه|اه|آه)\s*$/i.test(r.value);
  };
  try {
    var ps = history.pushState, rs = history.replaceState;
    history.pushState = function (s, t, u) { try { return ps.call(history, s, t, u); } catch (e) {} };
    history.replaceState = function (s, t, u) { try { return rs.call(history, s, t, u); } catch (e) {} };
  } catch (e) {}
}
export const previewShim = (opts = {}) => `(${previewBridge.toString()})(${JSON.stringify({ answers: Array.isArray(opts.answers) ? opts.answers.slice(0, 200).map(String) : [], skip: Number(opts.skip) || 0 })});`;
/** kept for callers that only want the default (no answers) shim */
export const PREVIEW_SHIM = previewShim();

const ENTRY_CANDIDATES = ['src/main.jsx', 'src/main.tsx', 'src/main.js', 'src/main.ts', 'src/index.jsx', 'src/index.tsx', 'src/index.js', 'src/index.ts', 'main.jsx', 'main.tsx', 'index.jsx', 'index.tsx', 'index.js'];

function formatErrors(errors) {
  return errors.map((e) => {
    const loc = e.location;
    const where = loc ? `${loc.file.replace(/^vfs:/, '')}:${loc.line}:${loc.column}` : '';
    return `${where ? `${where}: ` : ''}${e.text}${loc?.lineText ? `\n    ${loc.lineText.trim()}` : ''}`;
  }).join('\n');
}

/**
 * @param {object} o
 * @param {object} o.esbuild   esbuild or esbuild-wasm module (already initialised)
 * @param {Record<string,Uint8Array>} o.files  every project file, keyed by archive path
 * @param {string} o.root      project root inside the archive ('' or 'folder/')
 * @param {string[]} [o.answers]  answers already given to prompt()/confirm() (the page is re-run with them)
 * @param {number} [o.skip]       console lines to swallow on this re-run (already shown)
 * @returns {Promise<{html:string, imports:Record<string,string>, warnings:string[]}>}
 */
export async function buildWeb({ esbuild, files, root = '', answers = [], skip = 0 }) {
  const R = root ? `${norm(root).replace(/\/$/, '')}/` : '';
  const has = (rel) => Object.prototype.hasOwnProperty.call(files, R + rel);
  const read = (rel) => files[R + rel];
  const warnings = [];

  let pkg = {};
  if (has('package.json')) { try { pkg = JSON.parse(text(read('package.json'))); } catch { warnings.push('package.json is not valid JSON — ignored.'); } }
  const deps = { ...(pkg.devDependencies || {}), ...(pkg.dependencies || {}) };
  // Exact versions from package-lock.json (when the project has one). A range like "^6.0.2" must NOT be handed to
  // esm.sh: it picks the highest match, which for `codemirror` is the legacy CodeMirror 5 release published as 6.65.x.
  const lock = {};
  if (has('package-lock.json')) {
    try {
      const j = JSON.parse(text(read('package-lock.json')));
      if (j.packages) {
        for (const [k, v] of Object.entries(j.packages)) {
          const m = /^node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(k);
          if (m && /^\d/.test(v?.version || '')) lock[m[1]] = v.version;
        }
      } else if (j.dependencies) {
        for (const [k, v] of Object.entries(j.dependencies)) if (/^\d/.test(v?.version || '')) lock[k] = v.version;
      }
    } catch { /* ignore an unreadable lockfile */ }
  }
  const verOf = (name) => lock[name] || esmVersion(deps[name]);

  // ---- Vite-style env ----------------------------------------------------------------------------
  const env = {};
  for (const f of ['.env', '.env.development', '.env.local', '.env.development.local']) if (has(f)) Object.assign(env, parseEnv(text(read(f))));
  const define = {
    'process.env.NODE_ENV': '"development"',
    'import.meta.env.MODE': '"development"', 'import.meta.env.DEV': 'true', 'import.meta.env.PROD': 'false',
    'import.meta.env.SSR': 'false', 'import.meta.env.BASE_URL': '"/"',
  };
  // `import.meta.env` on its own (unset VITE_ vars, `import.meta.env?.DEV`, `const e = import.meta.env`) must be an object too,
  // otherwise esbuild leaves it undefined and the app crashes on first read.
  const envObject = { MODE: 'development', DEV: true, PROD: false, SSR: false, BASE_URL: '/' };
  for (const [k, v] of Object.entries(env)) if (k.startsWith('VITE_')) envObject[k] = v;
  define['import.meta.env'] = JSON.stringify(envObject);
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith('VITE_')) define[`import.meta.env.${k}`] = JSON.stringify(v);
    if (k.startsWith('REACT_APP_')) define[`process.env.${k}`] = JSON.stringify(v);
  }

  // ---- the HTML shell ----------------------------------------------------------------------------
  let html; let htmlDir = '';
  if (has('index.html')) html = text(read('index.html'));
  else if (has('public/index.html')) { html = text(read('public/index.html')).replace(/%PUBLIC_URL%/g, ''); }
  if (html == null) {
    const entry = ENTRY_CANDIDATES.find(has);
    if (!entry) throw new Error('No index.html and no React entry file (src/main.jsx, src/index.js …) found in this project.');
    html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>App</title></head><body><div id="root"></div><script type="module" src="/${entry}"></script></body></html>`;
  } else if (!/<script\b[^>]*type\s*=\s*["']module["'][^>]*\bsrc=/i.test(html) && !/<script\b[^>]*\bsrc=/i.test(html)) {
    // CRA-style template without a script tag: add the conventional entry
    const entry = ENTRY_CANDIDATES.find(has);
    if (entry) html = html.replace(/<\/body>/i, `<script type="module" src="/${entry}"></script></body>`);
  }

  // look a URL used in the HTML/CSS up in the project (root-relative also tries public/)
  const findAsset = (url, fromDir = htmlDir) => {
    const clean = url.split('#')[0].split('?')[0];
    if (!clean || isRemote(clean)) return null;
    const cands = clean.startsWith('/')
      ? [joinPath('', clean), joinPath('public', clean)]
      : [joinPath(fromDir, clean), joinPath('public', clean)];
    for (const c of cands) if (c != null && has(c)) return c;
    return null;
  };

  // ---- esbuild virtual file system ---------------------------------------------------------------
  const bare = new Set();
  let usesJsx = false;
  const resolveFile = (p) => {
    if (p == null) return null;
    if (extOf(p) && has(p)) return p;
    for (const e of RESOLVE_EXT.slice(1)) if (has(p + e)) return p + e;
    for (const e of RESOLVE_EXT.slice(1)) if (has(`${p}/index${e}`)) return `${p}/index${e}`;
    return null;
  };

  const vfsPlugin = {
    name: 'uip-vfs',
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        const spec = args.path;
        if (args.kind === 'entry-point') return { path: spec.replace(/^vfs:/, ''), namespace: 'vfs' };
        const [bareSpec, query] = spec.split('?');
        const fromDir = args.importer ? dirOf(args.importer) : '';
        let target = null;
        if (bareSpec.startsWith('.')) target = joinPath(fromDir, bareSpec);
        else if (bareSpec.startsWith('/')) target = joinPath('', bareSpec);
        else if (bareSpec.startsWith('@/') || bareSpec.startsWith('~/')) target = joinPath('src', bareSpec.slice(2));
        else if (/^[a-z]+:/i.test(bareSpec) && !bareSpec.startsWith('@')) return { path: spec, external: true }; // https:, data: …
        if (target != null || bareSpec.startsWith('.') || bareSpec.startsWith('/')) {
          const hit = target == null ? null : resolveFile(target);
          if (!hit) return { errors: [{ text: `Cannot find "${spec}" in the project (imported from ${args.importer || 'entry'}).` }] };
          return { path: hit, namespace: 'vfs', pluginData: { query } };
        }
        // Vite-style asset import of a file inside an npm package (`pkg/file.wasm?url`, `pkg/worklet.js?url`):
        // the student code wants the file's URL (for fetch / AudioWorklet.addModule / new Worker), NOT a module,
        // so hand back a raw-file CDN URL instead of an esm.sh module import.
        if (query === 'url') {
          const { name, sub } = pkgOf(bareSpec);
          const v = verOf(name);
          return { path: `${name}${v ? `@${v}` : ''}${sub}`, namespace: 'pkg-asset' };
        }
        // The preview lives in an about:srcdoc iframe, whose location.pathname is "srcdoc" — so BrowserRouter matches no
        // route ("No routes matched location "srcdoc""). Student code that imports the router is pointed at a tiny shim
        // that swaps the browser routers for in-memory ones starting at "/"; everything else is re-exported untouched.
        if ((bareSpec === 'react-router-dom' || bareSpec === 'react-router') && args.namespace === 'vfs') {
          return { path: bareSpec, namespace: 'router-shim' };
        }
        // a bare package name -> served by esm.sh through the import map
        bare.add(bareSpec);
        return { path: bareSpec, external: true };
      });
      build.onLoad({ filter: /.*/, namespace: 'router-shim' }, (args) => ({
        contents: `import * as R from ${JSON.stringify(args.path)};
import { createElement } from 'react';
export * from ${JSON.stringify(args.path)};
export const BrowserRouter = R.MemoryRouter
  ? (props) => createElement(R.MemoryRouter, { basename: props.basename, future: props.future, initialEntries: ['/'] }, props.children)
  : R.BrowserRouter;
export const createBrowserRouter = R.createMemoryRouter
  ? (routes, opts) => R.createMemoryRouter(routes, { ...(opts || {}), initialEntries: ['/'] })
  : R.createBrowserRouter;`,
        loader: 'js',
      }));
      build.onLoad({ filter: /.*/, namespace: 'pkg-asset' }, (args) => ({
        contents: `export default ${JSON.stringify(`https://cdn.jsdelivr.net/npm/${args.path}`)}`, loader: 'js',
      }));
      build.onLoad({ filter: /.*/, namespace: 'vfs' }, (args) => {
        const u8 = files[R + args.path];
        if (!u8) return { errors: [{ text: `Missing file ${args.path}` }] };
        const ext = extOf(args.path);
        const q = args.pluginData?.query || '';
        if (q === 'raw') return { contents: text(u8), loader: 'text' };
        if (q === 'url' || ASSET_EXT.has(ext)) {
          if (u8.length > MAX_INLINE_ASSET) { warnings.push(`${args.path} is larger than 2MB and was not inlined.`); return { contents: 'export default ""', loader: 'js' }; }
          return { contents: `export default ${JSON.stringify(dataUri(u8, args.path))}`, loader: 'js' };
        }
        if (ext === 'json') return { contents: text(u8), loader: 'json' };
        if (ext === 'css') return { contents: text(u8), loader: /\.module\.css$/i.test(args.path) ? 'local-css' : 'css', resolveDir: '/' };
        if (['ts', 'tsx', 'mts', 'cts'].includes(ext)) { if (ext === 'tsx') usesJsx = true; return { contents: text(u8), loader: ext === 'tsx' ? 'tsx' : 'ts' }; }
        if (ext === 'jsx' || ext === 'js' || ext === 'mjs' || ext === 'cjs') { const t = text(u8); if (/<[A-Za-z][\w.]*[\s/>]/.test(t)) usesJsx = true; return { contents: t, loader: 'jsx' }; }
        return { contents: text(u8), loader: 'text' };
      });
    },
  };

  // ---- take the HTML apart -----------------------------------------------------------------------
  const attr = (attrs, name) => { const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(attrs); return m ? (m[2] ?? m[3] ?? m[4]) : null; };
  const moduleEntries = []; // { rel }
  const order = []; // placeholders so bundled modules keep their place relative to each other
  html = html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (full, attrs, body) => {
    const src = attr(attrs, 'src');
    if (!src) return full; // inline script — untouched
    if (isRemote(src)) return full; // CDN script — untouched
    const rel = findAsset(src);
    if (!rel) { warnings.push(`Script ${src} was not found in the project.`); return ''; }
    const isModule = /type\s*=\s*["']module["']/i.test(attrs) || /\.(jsx|tsx|ts|mjs)$/i.test(rel);
    if (isModule) { moduleEntries.push(rel); order.push(rel); return ''; }
    const code = text(files[R + rel]).replace(/<\/script/gi, '<\\/script');
    return `<script>${code}</script>`;
  });

  // <link rel=stylesheet href=local> -> <style> (url() inside become data URIs)
  const inlineCssUrls = (css, cssPath) => css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, q, u) => {
    if (isRemote(u)) return m;
    const rel = findAsset(u, dirOf(cssPath));
    if (!rel || files[R + rel].length > MAX_INLINE_ASSET) return m;
    return `url("${dataUri(files[R + rel], rel)}")`;
  });
  html = html.replace(/<link\b([^>]*)>/gi, (full, attrs) => {
    const href = attr(attrs, 'href'); const rel = (attr(attrs, 'rel') || '').toLowerCase();
    if (!href || isRemote(href)) return full;
    const hit = findAsset(href);
    if (!hit) return full;
    if (rel.includes('stylesheet')) return `<style>${inlineCssUrls(text(files[R + hit]), hit)}</style>`;
    if (/icon/.test(rel) && files[R + hit].length <= MAX_INLINE_ASSET) return full.replace(href, dataUri(files[R + hit], hit));
    return full;
  });
  // <img src>, <source src>, <video src>, <audio src>
  html = html.replace(/(<(?:img|source|video|audio|image)\b[^>]*?\bsrc\s*=\s*)(["'])([^"']+)\2/gi, (full, pre, q, u) => {
    const hit = findAsset(u);
    return hit && files[R + hit].length <= MAX_INLINE_ASSET ? `${pre}${q}${dataUri(files[R + hit], hit)}${q}` : full;
  });

  // ---- bundle the module scripts -----------------------------------------------------------------
  const bundles = [];
  if (moduleEntries.length) {
    const uniq = [...new Set(moduleEntries)];
    let result;
    try {
      result = await esbuild.build({
        entryPoints: uniq.map((rel, i) => ({ in: `vfs:${rel}`, out: `entry${i}` })),
        bundle: true, write: false, format: 'esm', target: 'es2020', outdir: '/out',
        jsx: 'automatic', define, plugins: [vfsPlugin], logLevel: 'silent', sourcemap: 'inline', legalComments: 'none',
        loader: { '.json': 'json' },
      });
    } catch (err) {
      const list = err?.errors?.length ? formatErrors(err.errors) : String(err?.message || err);
      const e = new Error(list); e.isBuildError = true; throw e;
    }
    (result.warnings || []).slice(0, 5).forEach((w) => warnings.push(w.text));
    uniq.forEach((rel, i) => {
      const js = result.outputFiles.find((f) => f.path.endsWith(`/entry${i}.js`));
      const css = result.outputFiles.find((f) => f.path.endsWith(`/entry${i}.css`));
      bundles.push({ rel, js: js ? js.text : '', css: css ? css.text : '' });
    });
  }

  // ---- import map for npm packages ---------------------------------------------------------------
  const imports = {};
  const reactRange = verOf('react') || DEFAULT_REACT;
  const domRange = verOf('react-dom') || reactRange;
  const needReact = usesJsx || bare.has('react') || [...bare].some((s) => s.startsWith('react/') || s.startsWith('react-dom'));
  if (needReact) {
    imports.react = `${ESM_CDN}/react@${reactRange}`;
    imports['react/'] = `${ESM_CDN}/react@${reactRange}/`;
    imports['react-dom'] = `${ESM_CDN}/react-dom@${domRange}?external=react`;
    imports['react-dom/'] = `${ESM_CDN}/react-dom@${domRange}/`;
  }
  // Packages that must exist exactly ONCE on the page (CodeMirror checks `instanceof` across its packages). esm.sh would
  // otherwise bundle its own copy of each into every package, so they are kept external and served from the import map.
  const SINGLETONS = ['@codemirror/state', '@codemirror/view', '@codemirror/language', '@lezer/common', '@lezer/highlight', '@lezer/lr'];
  const SHARES = (n) => /^(@codemirror\/|codemirror$|@lezer\/|@uiw\/codemirror)/.test(n);
  const singles = SINGLETONS.filter((n) => deps[n] || lock[n]);
  const anyShares = [...bare].some((spec) => SHARES(pkgOf(spec).name));
  for (const spec of bare) {
    const { name, sub } = pkgOf(spec);
    if (name === 'react') continue; // react/* is covered by the prefix entry
    if (name === 'react-dom') { if (sub) imports[spec] = `${ESM_CDN}/react-dom@${domRange}${sub}?external=react`; continue; } // keep ONE react instance
    const v = verOf(name);
    const ext = ['react', 'react-dom'];
    if (SHARES(name)) singles.forEach((n) => { if (n !== name) ext.push(n); });
    imports[spec] = `${ESM_CDN}/${name}${v ? `@${v}` : ''}${sub}?external=${ext.join(',')}`;
  }
  if (anyShares) {
    for (const n of singles) {
      if (imports[n]) continue;
      const v = verOf(n);
      const others = singles.filter((x) => x !== n);
      imports[n] = `${ESM_CDN}/${n}${v ? `@${v}` : ''}${others.length ? `?external=${others.join(',')}` : ''}`;
    }
  }

  // ---- assemble ----------------------------------------------------------------------------------
  const esc = (s) => s.replace(/<\/script/gi, '<\\/script');
  const headBits = [
    `<script>${previewShim({ answers, skip }).replace(/<\/script/gi, '<\\/script')}</script>`,
    Object.keys(imports).length ? `<script type="importmap">${JSON.stringify({ imports }).replace(/</g, '\\u003c')}</script>` : '',
    deps.tailwindcss && /^[\^~]?3|^3/.test(String(deps.tailwindcss).replace(/^[\^~]/, '')) ? '<script src="https://cdn.tailwindcss.com/3.4.17"></script>' : '',
    ...bundles.filter((b) => b.css).map((b) => `<style>${b.css}</style>`),
  ].filter(Boolean).join('\n');
  const tailBits = order.map((rel) => { const b = bundles.find((x) => x.rel === rel); return b ? `<script type="module">${esc(b.js)}</script>` : ''; }).join('\n');

  html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => `${m}\n${headBits}`) : `${headBits}\n${html}`;
  html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${tailBits}\n</body>`) : `${html}\n${tailBits}`;
  if (!/<!doctype/i.test(html)) html = `<!doctype html>\n${html}`;

  return { html, imports, warnings };
}
