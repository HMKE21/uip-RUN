import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { loadPyodide } from 'pyodide';
import { runPython, cleanTraceback, importedModules } from '../lib/pyRun.js';

const enc = new TextEncoder();
const F = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, enc.encode(v)]));
let py;
before(async () => { py = await loadPyodide(); });

const run = async (files, entry, opts = {}) => {
  let out = ''; let err = '';
  const res = await runPython(py, { files: F(files), entry, root: opts.root || '', stdin: opts.stdin, onOut: (s) => { out += s; }, onErr: (s) => { err += s; } });
  return { ...res, out, err };
};

test('prints and imports sibling modules', async () => {
  const r = await run({ 'main.py': 'from util import add\nprint("sum", add(2, 3))', 'util.py': 'def add(a,b): return a+b' }, 'main.py');
  assert.equal(r.ok, true); assert.equal(r.out, 'sum 5\n'); assert.equal(r.err, '');
});

test('project inside a folder of the archive (root prefix) + subpackages', async () => {
  const r = await run({ 'proj/app/main.py': 'import pkg.mod as m\nprint(m.X)', 'proj/app/pkg/__init__.py': '', 'proj/app/pkg/mod.py': 'X = "ok"' }, 'main.py', { root: 'proj/app/' });
  assert.equal(r.ok, true); assert.equal(r.out, 'ok\n');
});

test('input() is fed from the stdin box and EOF raises cleanly', async () => {
  const r = await run({ 'main.py': 'n = input("name? ")\nprint("hi", n)\ntry:\n    input()\nexcept EOFError:\n    print("eof")' }, 'main.py', { stdin: 'Ahmed' });
  assert.equal(r.ok, true); assert.match(r.out, /hi Ahmed/); assert.match(r.out, /eof/);
});

test('errors show a student-friendly traceback (no Pyodide internals)', async () => {
  const r = await run({ 'main.py': 'def f():\n    return 1/0\nf()' }, 'main.py');
  assert.equal(r.ok, false);
  assert.match(r.err, /ZeroDivisionError/); assert.match(r.err, /main\.py/); assert.doesNotMatch(r.err, /_pyodide|runpy/);
});

test('files deleted between runs do not linger', async () => {
  await run({ 'main.py': 'print(1)', 'old.py': 'print("old")' }, 'main.py');
  const r = await run({ 'main.py': 'import os\nprint(os.path.exists("old.py"))' }, 'main.py');
  assert.equal(r.out, 'False\n');
});

test('edited modules are re-imported on the next run (worker is reused)', async () => {
  await run({ 'main.py': 'import util\nprint(util.V)', 'util.py': 'V = 1' }, 'main.py');
  const r = await run({ 'main.py': 'import util\nprint(util.V)', 'util.py': 'V = 2' }, 'main.py');
  assert.equal(r.out, '2\n');
});

test('sys.exit(0) is a success, missing entry is reported', async () => {
  assert.equal((await run({ 'main.py': 'import sys\nprint("a")\nsys.exit(0)' }, 'main.py')).ok, true);
  const bad = await run({ 'main.py': 'import sys\nsys.exit(3)' }, 'main.py');
  assert.equal(bad.ok, false); assert.match(bad.err, /exited with code 3/);
  const r = await run({ 'x.py': '' }, 'main.py');
  assert.equal(r.ok, false); assert.match(r.err, /File not found/);
});

test('helpers', () => {
  assert.deepEqual(importedModules('import os, numpy as np\nfrom pandas.io import x\n# import nope\nimport a.b.c').sort(), ['a', 'numpy', 'os', 'pandas']);
  assert.equal(cleanTraceback('Traceback (most recent call last):\n  File "/lib/python313.zip/_pyodide/_base.py", line 1, in run\n    x\n  File "/home/pyodide/project/main.py", line 2, in <module>\n    boom()\nNameError: boom'), 'Traceback (most recent call last):\n  File "/home/pyodide/project/main.py", line 2, in <module>\n    boom()\nNameError: boom');
});
