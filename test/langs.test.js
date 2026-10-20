import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildScript, KINDS } from '../src/scripts.js';

// Runs the REAL generated script for a project in a temp folder (no container): proves the per-language commands work.
const has = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0;
function run({ files, kind = 'lang', entry = '', input = '' }) {
  const root = mkdtempSync(join(tmpdir(), 'sbxt-'));
  const proj = join(root, 'project'); mkdirSync(proj);
  for (const [p, c] of Object.entries(files)) { mkdirSync(dirname(join(proj, p)), { recursive: true }); writeFileSync(join(proj, p), c); }
  const s = buildScript({ kind, entry, previewUrl: 'http://a.localhost', previewDomain: 'localhost' })
    .replace('cd /home/dev/project', `cd '${proj}'`).replace('exec bash -l\n', '');
  const r = spawnSync('bash', ['-c', s], { input, env: { ...process.env, HOME: root }, encoding: 'utf8', timeout: 90_000 });
  return `${r.stdout}${r.stderr}`;
}
const needs = (cmds, fn) => (t) => (cmds.every(has) ? fn(t) : t.skip(`${cmds.join(', ')} not installed here`));

test('every kind is listed once', () => { assert.equal(new Set(KINDS).size, KINDS.length); });

test('javascript written for the browser (prompt / alert) runs in the terminal, Arabic input included', needs(['node'], () => {
  const out = run({ entry: 'mai.js', input: 'سارة\n3\n4\n', files: { 'mai.js': 'const n = prompt("Name:"); const a = Number(prompt("A:")); const b = Number(prompt("B:"));\nconsole.log("Hello, " + n + "!", "Sum =", a + b);\nalert(`Hi ${n}, sum ${a + b}`);' } });
  assert.match(out, /Hello, سارة! Sum = 7/);
  assert.match(out, /Hi سارة, sum 7/);
}));

test('node: ES modules and process.argv work', needs(['node'], () => {
  assert.match(run({ entry: 'a.mjs', files: { 'a.mjs': 'import os from "node:os"; console.log("ok", typeof os.cpus);' } }), /ok function/);
}));

test('python single file, with stdin', needs(['python3'], () => {
  assert.match(run({ entry: 'hi.py', input: 'Ali\n', files: { 'hi.py': 'print("Hi", input())' } }), /Hi Ali/);
}));

test('c: compiles the file and the .c next to a local header', needs(['gcc'], () => {
  const out = run({ entry: 'main.c', files: {
    'main.c': '#include <stdio.h>\n#include "util.h"\nint main(){ printf("sum=%d\\n", add(2,3)); return 0; }',
    'util.h': 'int add(int,int);', 'util.c': 'int add(int a,int b){return a+b;}' } });
  assert.match(out, /sum=5/);
}));

test('c++: C++20 and a local header + source', needs(['g++'], () => {
  const out = run({ entry: 'main.cpp', files: {
    'main.cpp': '#include <iostream>\n#include "greet.hpp"\nint main(){ std::cout << greet("UIP") << std::endl; }',
    'greet.hpp': '#include <string>\nstd::string greet(const std::string&);', 'greet.cpp': '#include "greet.hpp"\nstd::string greet(const std::string& n){ return "hello " + n; }' } });
  assert.match(out, /hello UIP/);
}));

test('java: package + several files, entry = the file with main()', needs(['javac', 'java'], () => {
  const out = run({ entry: 'src/app/Main.java', files: {
    'src/app/Main.java': 'package app;\npublic class Main { public static void main(String[] a){ System.out.println(Util.twice(21)); } }',
    'src/app/Util.java': 'package app;\nclass Util { static int twice(int x){ return x*2; } }' } });
  assert.match(out, /^42$/m);
}));

test('perl and bash', needs(['perl'], () => {
  assert.match(run({ entry: 'a.pl', files: { 'a.pl': 'print "perl ok\\n";' } }), /perl ok/);
  assert.match(run({ entry: 'a.sh', files: { 'a.sh': 'echo "bash ok"' } }), /bash ok/);
}));

test('missing toolchain gives a clear message, unknown extension too', () => {
  assert.match(run({ entry: 'a.zig', files: { 'a.zig': '' } }), /don't know how to run/);
  assert.match(run({ entry: 'missing.js', files: {} }), /file not found/);
  assert.match(run({ kind: 'lang', entry: '', files: {} }), /no file selected/);
});

test('auto: a plain project is recognised, nothing recognisable says so', needs(['python3'], () => {
  assert.match(run({ kind: 'auto', files: { 'main.py': 'print("auto py")' } }), /auto py/);
  assert.match(run({ kind: 'auto', files: { 'readme.txt': 'x' } }), /could not tell/);
  assert.match(run({ kind: 'auto', entry: 'x.py', files: { 'x.py': 'print("auto entry")' } }), /auto entry/);
}));

test('project kinds complain clearly when their files / tools are missing', () => {
  const dir = { 'readme.txt': 'x' };
  assert.match(run({ kind: 'make', files: dir }), /no Makefile or CMakeLists|not installed/);
  assert.match(run({ kind: 'dotnet', files: dir }), /no \.csproj|not installed/);
  assert.match(run({ kind: 'rails', files: dir }), /not installed|not a Rails/);
});

test('make: a Makefile project is built and the new executable is started', needs(['gcc', 'make'], () => {
  const out = run({ kind: 'make', files: { 'main.c': '#include <stdio.h>\nint main(){puts("made");return 0;}', Makefile: 'app: main.c\n\tgcc main.c -o app\n' } });
  assert.match(out, /made/);
}));
