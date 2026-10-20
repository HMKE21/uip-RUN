import test from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';
import { buildWeb } from '../lib/buildWeb.js';

const enc = new TextEncoder();
const F = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'string' ? enc.encode(v) : v]));

test('Vite + React project: bundles local code, maps npm packages to esm.sh, inlines css/images', async () => {
  const files = F({
    'app/package.json': JSON.stringify({ dependencies: { react: '^19.1.0', 'react-dom': '^19.1.0', axios: '^1.7.0', 'react-router-dom': '^6.20.0' } }),
    'app/index.html': '<!doctype html><html><head><title>t</title><link rel="stylesheet" href="/src/extra.css"></head><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>',
    'app/src/main.jsx': "import React from 'react';import {createRoot} from 'react-dom/client';import axios from 'axios';import App from './App';import './index.css';createRoot(document.getElementById('root')).render(<App/>);",
    'app/src/App.jsx': "import logo from './logo.svg';import {useState} from 'react';import Btn from '@/components/Btn';import s from './x.module.css';export default function App(){const [n,setN]=useState(0);return <div className={s.box}><img src={logo}/><Btn onClick={()=>setN(n+1)}>{n} {import.meta.env.VITE_NAME}</Btn></div>}",
    'app/src/components/Btn.jsx': 'export default function Btn(p){return <button {...p}/>}',
    'app/src/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
    'app/src/index.css': 'body{margin:0}',
    'app/src/extra.css': '.a{background:url(./logo.svg)}',
    'app/src/x.module.css': '.box{color:red}',
    'app/.env': 'VITE_NAME=Hello\nSECRET=nope',
  });
  const { html, imports, warnings } = await buildWeb({ esbuild, files, root: 'app/' });
  assert.deepEqual(warnings, []);
  assert.match(html, /<script type="importmap">/);
  assert.equal(imports.react, 'https://esm.sh/react@^19.1.0');
  assert.equal(imports['react-dom/client'], 'https://esm.sh/react-dom@^19.1.0/client?external=react'); // must share the page's single react
  assert.equal(imports['react-dom/'], 'https://esm.sh/react-dom@^19.1.0/');
  assert.equal(imports.axios, 'https://esm.sh/axios@^1.7.0?external=react,react-dom');
  assert.ok(html.includes('"Hello"'), 'VITE_ env inlined');
  assert.ok(!html.includes('nope'), 'non-VITE env not leaked');
  assert.match(html, /body\s*\{\s*margin:\s*0/); // css bundled into <style>
  assert.match(html, /data:image\/svg\+xml;base64/); // svg inlined
  assert.ok(!/src="\/src\/main\.jsx"/.test(html), 'module tag replaced');
  assert.match(html, /import ["']react-dom\/client["']|from ["']react-dom\/client["']/);
  assert.match(html, /class="[^"]*"|className|box/);
});

test('plain HTML/CSS/JS project works (classic + module scripts)', async () => {
  const files = F({
    'index.html': '<html><head><link rel="stylesheet" href="style.css"></head><body><h1 id=h>x</h1><img src="pic.png"><script src="classic.js"></script><script type="module" src="./mod.js"></script></body></html>',
    'style.css': 'h1{color:blue}', 'classic.js': 'window.A=1', 'mod.js': "import {x} from './lib.js';document.title=x", 'lib.js': 'export const x="hi"',
    'pic.png': new Uint8Array([137, 80, 78, 71]),
  });
  const { html, imports } = await buildWeb({ esbuild, files, root: '' });
  assert.deepEqual(imports, {});
  assert.match(html, /<style>h1\{color:blue\}<\/style>/);
  assert.match(html, /<script>window\.A=1<\/script>/);
  assert.match(html, /data:image\/png;base64/);
  assert.match(html, /document\.title\s*=\s*x|"hi"/);
});

test('React project without index.html gets a synthesized shell', async () => {
  const files = F({ 'package.json': '{"dependencies":{"react":"18.2.0","react-dom":"18.2.0"}}', 'src/index.js': "import {createRoot} from 'react-dom/client';createRoot(document.body).render(<p>hi</p>)" });
  const { html, imports } = await buildWeb({ esbuild, files, root: '' });
  assert.equal(imports.react, 'https://esm.sh/react@18.2.0');
  assert.match(html, /id="root"/);
});

test('build errors are readable', async () => {
  const files = F({ 'index.html': '<script type="module" src="/a.js"></script>', 'a.js': "import './missing';\nlet = ;" });
  await assert.rejects(() => buildWeb({ esbuild, files, root: '' }), (e) => e.isBuildError && /a\.js/.test(e.message));
});

test('missing local import is reported', async () => {
  const files = F({ 'index.html': '<script type="module" src="/a.js"></script>', 'a.js': "import './missing';" });
  await assert.rejects(() => buildWeb({ esbuild, files, root: '' }), /Cannot find "\.\/missing"/);
});

test('package asset imports (`pkg/file.wasm?url`) become raw-file CDN URLs, not esm.sh module imports', async () => {
  const files = F({
    'package.json': JSON.stringify({ dependencies: { '@sapphi-red/web-noise-suppressor': '^0.4.1' } }),
    'index.html': '<!doctype html><html><body><script type="module" src="/main.js"></script></body></html>',
    'main.js': "import w from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url';import k from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url';console.log(w,k);",
  });
  const { html, imports } = await buildWeb({ esbuild, files, root: '' });
  assert.ok(html.includes('https://cdn.jsdelivr.net/npm/@sapphi-red/web-noise-suppressor@^0.4.1/rnnoise.wasm'));
  assert.ok(html.includes('https://cdn.jsdelivr.net/npm/@sapphi-red/web-noise-suppressor@^0.4.1/rnnoiseWorklet.js'));
  assert.deepEqual(Object.keys(imports), [], 'no import-map entry (and no module import) for asset files');
});

test('package-lock.json pins exact versions (esm.sh would pick the CodeMirror-5 "6.65.x" for ^6.0.2) and CodeMirror shares one @codemirror/state', async () => {
  const files = F({
    'package.json': JSON.stringify({ dependencies: { codemirror: '^6.0.2', '@codemirror/state': '^6.5.0', '@codemirror/view': '^6.30.0', '@codemirror/lang-python': '^6.2.1' } }),
    'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: {
      '': {}, 'node_modules/codemirror': { version: '6.0.2' }, 'node_modules/@codemirror/state': { version: '6.5.2' },
      'node_modules/@codemirror/view': { version: '6.36.1' }, 'node_modules/@codemirror/lang-python': { version: '6.2.1' },
      'node_modules/codemirror/node_modules/@codemirror/state': { version: '6.0.0' },
    } }),
    'index.html': '<!doctype html><html><body><script type="module" src="/main.js"></script></body></html>',
    'main.js': "import { basicSetup } from 'codemirror';import { python } from '@codemirror/lang-python';console.log(basicSetup, python);",
  });
  const { imports } = await buildWeb({ esbuild, files, root: '' });
  assert.match(imports.codemirror, /^https:\/\/esm\.sh\/codemirror@6\.0\.2\?external=react,react-dom,@codemirror\/state,@codemirror\/view$/);
  assert.equal(imports['@codemirror/state'], 'https://esm.sh/@codemirror/state@6.5.2?external=@codemirror/view');
  assert.match(imports['@codemirror/view'], /^https:\/\/esm\.sh\/@codemirror\/view@6\.36\.1\?external=@codemirror\/state$/);
  assert.match(imports['@codemirror/lang-python'], /@6\.2\.1\?external=react,react-dom,@codemirror\/state,@codemirror\/view$/);
});

test('react-router BrowserRouter is swapped for an in-memory router (srcdoc iframe has no real path)', async () => {
  const files = F({
    'package.json': JSON.stringify({ dependencies: { react: '18', 'react-router-dom': '6.20.0' } }),
    'index.html': '<div id="root"></div><script type="module" src="/src/main.js"></script>',
    'src/main.js': "import { BrowserRouter, Routes, useNavigate } from 'react-router-dom'; window.__r = [BrowserRouter, Routes, useNavigate];",
  });
  const { html, warnings } = await buildWeb({ esbuild, files, root: '' });
  assert.deepEqual(warnings, []);
  assert.match(html, /MemoryRouter/);
  assert.match(html, /initialEntries: \["\/"\]|initialEntries:\s*\['\/'\]/);
});

// ---- alert / prompt / confirm are replaced by the preview bridge (no native dialogs) ----------------------------
import vm from 'node:vm';
import { previewShim } from '../lib/buildWeb.js';

function runShim(opts, program) {
  const msgs = []; const listeners = {};
  const win = {
    parent: { postMessage: (m) => msgs.push(m) },
    addEventListener: (t, f) => { (listeners[t] ||= []).push(f); },
    history: {}, console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    document: { getElementById: () => null, createElement: () => ({ style: {}, appendChild() {}, remove() {} }), body: { appendChild() {} } },
    setTimeout: () => 0,
  };
  win.window = win;
  const ctx = vm.createContext(win);
  vm.runInContext(previewShim(opts), ctx);
  let thrown = null;
  try { vm.runInContext(program, ctx); } catch (e) { thrown = e; }
  return { msgs, thrown, listeners, ctx };
}

test('prompt() pauses the program and asks the IDE for an answer', () => {
  const r = runShim({}, `const n = prompt('Name?'); console.log('hi ' + n);`);
  assert.equal(r.thrown?.__uipInput, true);
  assert.deepEqual(r.msgs.map((m) => [m.type, m.kind, m.text, m.emitted]), [['need-input', 'prompt', 'Name?', 0]]);
});

test('a re-run with answers continues, and skips output that was already shown', () => {
  const prog = `const n = prompt('Name?'); console.log('a'); console.log('hi ' + n); alert('x');`;
  const all = runShim({ answers: ['Ali'] }, prog);
  assert.deepEqual(all.msgs.map((m) => m.text), ['a', 'hi Ali', '[alert] x']);
  const rest = runShim({ answers: ['Ali'], skip: 2 }, prog);
  assert.deepEqual(rest.msgs.map((m) => m.text), ['[alert] x']);
});

test('confirm() understands y/yes/نعم; after load prompt()/confirm() return null/false instead of blocking', () => {
  assert.equal(runShim({ answers: ['y'] }, `globalThis.r = confirm('?')`).ctx.r, true);
  assert.equal(runShim({ answers: ['n'] }, `globalThis.r = confirm('?')`).ctx.r, false);
  const late = runShim({}, `0`); late.listeners.load.forEach((f) => f());
  vm.runInContext(`globalThis.r = [prompt('x'), confirm('y')]`, late.ctx);
  assert.deepEqual(JSON.parse(JSON.stringify(late.ctx.r)), [null, false]);
});
