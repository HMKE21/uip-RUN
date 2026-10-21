// Origins allowed to embed this runner AND to send it projects. Keep in sync with `frame-ancestors` in vercel.json.
export const ALLOWED_PARENTS = [
  'https://uip-nub.vercel.app',
  'http://localhost:5173',
  'http://localhost:4173',
];

// Pinned third-party assets (pinned versions + SRI where the browser lets us check it).
export const ESBUILD_WASM_URL = 'https://cdn.jsdelivr.net/npm/esbuild-wasm@0.28.1/esbuild.wasm';
export const ESBUILD_WASM_FALLBACK_URL = 'https://unpkg.com/esbuild-wasm@0.28.1/esbuild.wasm'; // same npm file => same SRI
export const ESBUILD_WASM_SRI = 'sha384-rec1r0J9Ufis2IHYieHkK7GfXQzesTCl9szFFpvr6cJ8ZZsVRQzqKFX/KGGqqJNj';
export const PYODIDE_BASE = 'https://cdn.jsdelivr.net/pyodide/v0.29.5/full/';

export const PYTHON_TIMEOUT_MS = 120_000; // a run is killed after this long (infinite loops)

export const PYODIDE_LOAD_TIMEOUT_MS = 60_000; // downloading + starting the Python engine (first visit only; then it is cached)
export const PYTHON_BOOT_TIMEOUT_MS = 20_000;  // the Python worker must say "alive" within this long (else it was blocked)
export const RUN_HARD_CAP_MS = 300_000;        // absolute limit for a run, including package downloads
