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
  assert.match(run({ entry: 'a.xyz', files: { 'a.xyz': '' } }), /don't know how to run/);
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

// ── the extra languages: each test runs only where the toolchain is installed (the Docker image has all of them) ──
const one = (name, cmds, entry, code, expect) => test(`${name}: ${entry}`, needs(cmds, () => { assert.match(run({ entry, files: { [entry]: code } }), expect); }));
one('nim', ['nim', 'gcc'], 'a.nim', 'echo "nim ok"', /nim ok/);
one('d', ['ldc2'], 'a.d', 'import std.stdio; void main(){ writeln("d ok"); }', /d ok/);
one('ada', ['gnatmake'], 'h.adb', 'with Ada.Text_IO; procedure H is begin Ada.Text_IO.Put_Line("ada ok"); end H;', /ada ok/);
one('cobol (fixed format)', ['cobc'], 'a.cob', '       IDENTIFICATION DIVISION.\n       PROGRAM-ID. A.\n       PROCEDURE DIVISION.\n           DISPLAY "cobol ok".\n           STOP RUN.\n', /cobol ok/);
one('cobol (free format)', ['cobc'], 'f.cob', 'IDENTIFICATION DIVISION.\nPROGRAM-ID. F.\nPROCEDURE DIVISION.\n    DISPLAY "cobol free ok".\n    STOP RUN.\n', /cobol free ok/);
one('assembly (NASM)', ['nasm', 'ld'], 'a.asm', 'section .data\nmsg db "asm ok",10\nsection .text\nglobal _start\n_start:\n mov rax,1\n mov rdi,1\n mov rsi,msg\n mov rdx,7\n syscall\n mov rax,60\n xor rdi,rdi\n syscall\n', /asm ok/);
one('elixir', ['elixir'], 'a.exs', 'IO.puts "elixir ok"', /elixir ok/);
one('erlang module', ['erl', 'erlc'], 'h.erl', '-module(h).\n-export([main/0]).\nmain() -> io:format("erlang ok~n").\n', /erlang ok/);
one('erlang escript', ['escript'], 'e.erl', '#!/usr/bin/env escript\nmain(_) -> io:format("escript ok~n").\n', /escript ok/);
one('ocaml', ['ocamlopt'], 'a.ml', 'let () = print_endline "ocaml ok"', /ocaml ok/);
one('common lisp', ['sbcl'], 'a.lisp', '(format t "lisp ok~%")', /lisp ok/);
one('scheme', ['guile'], 'a.scm', '(display "scheme ok") (newline)', /scheme ok/);
one('prolog', ['swipl'], 'a.pro', ':- initialization(main).\nmain :- write(\'prolog ok\'), nl, halt.\n', /prolog ok/);
one('tcl', ['tclsh'], 'a.tcl', 'puts "tcl ok"', /tcl ok/);
one('awk', ['gawk'], 'a.awk', 'BEGIN { print "awk ok" }', /awk ok/);
one('raku', ['raku'], 'a.raku', 'say "raku ok";', /raku ok/);
one('groovy', ['groovy'], 'a.groovy', 'println "groovy ok"', /groovy ok/);
one('clojure', ['clojure'], 'a.clj', '(println "clojure ok")', /clojure ok/);
one('verilog', ['iverilog', 'vvp'], 'a.v', 'module t; initial begin $display("verilog ok"); $finish; end endmodule', /verilog ok/);
one('vhdl', ['ghdl'], 'a.vhd', 'entity tb is end tb;\narchitecture a of tb is begin process begin report "vhdl ok"; wait; end process; end a;\n', /vhdl ok/);
one('go (single file, no go.mod)', ['go'], 'a.go', 'package main\nimport "fmt"\nfunc main(){ fmt.Println("go ok") }', /go ok/);
one('rust', ['rustc'], 'a.rs', 'fn main(){ println!("rust ok"); }', /rust ok/);
one('fortran', ['gfortran'], 'a.f90', 'program a\nprint *, "fortran ok"\nend program a\n', /fortran ok/);
one('pascal', ['fpc'], 'a.pas', "begin writeln('pascal ok'); end.", /pascal ok/);

test('.pl: Perl stays Perl, facts and rules are Prolog', needs(['perl', 'swipl'], () => {
  assert.match(run({ entry: 'a.pl', files: { 'a.pl': 'use strict; my $x = 2; print "perl ", $x * 2, "\\n";' } }), /perl 4/);
  assert.match(run({ entry: 'a.pl', input: 'grand(tom, X).\nhalt.\n', files: { 'a.pl': 'parent(tom, bob).\nparent(bob, ann).\ngrand(X, Z) :- parent(X, Y), parent(Y, Z).\n' } }), /X = ann/);
}));

test('build cache: unchanged code is not compiled twice, changed code is', needs(['gcc'], () => {
  const files = { 'a.c': '#include <stdio.h>\nint main(){puts("v1");return 0;}' };
  const root = mkdtempSync(join(tmpdir(), 'sbxc-')); const proj = join(root, 'project'); mkdirSync(proj);
  const go = () => {
    const s = buildScript({ kind: 'lang', entry: 'a.c', previewUrl: 'http://a.localhost', previewDomain: 'localhost' }).replace('cd /home/dev/project', `cd '${proj}'`).replace('exec bash -l\n', '');
    const r = spawnSync('bash', ['-c', s], { env: { ...process.env, HOME: root }, encoding: 'utf8', timeout: 60_000 }); return `${r.stdout}${r.stderr}`;
  };
  for (const [p, c] of Object.entries(files)) writeFileSync(join(proj, p), c);
  assert.doesNotMatch(go(), /build skipped/);
  assert.match(go(), /build skipped[^]*v1/);
  writeFileSync(join(proj, 'a.c'), files['a.c'].replace('v1', 'v2'));
  const third = go(); assert.doesNotMatch(third, /build skipped/); assert.match(third, /v2/);
}));

test('python with requirements.txt: the venv is reused and pip/uv is skipped the second time', needs(['python3'], () => {
  const root = mkdtempSync(join(tmpdir(), 'sbxp-')); const proj = join(root, 'project'); mkdirSync(proj);
  writeFileSync(join(proj, 'requirements.txt'), '# nothing to install\n'); writeFileSync(join(proj, 'a.py'), 'print("py ok")');
  const go = () => {
    const s = buildScript({ kind: 'lang', entry: 'a.py', previewUrl: 'http://a.localhost', previewDomain: 'localhost' }).replace('cd /home/dev/project', `cd '${proj}'`).replace('exec bash -l\n', '');
    const r = spawnSync('bash', ['-c', s], { env: { ...process.env, HOME: root }, encoding: 'utf8', timeout: 90_000 }); return `${r.stdout}${r.stderr}`;
  };
  assert.match(go(), /installing requirements/);
  const again = go(); assert.match(again, /py ok/); assert.doesNotMatch(again, /installing requirements/);
}));

test('auto script stays small enough for one `bash -c` argument (limit 128 KB)', () => {
  assert.ok(Buffer.byteLength(buildScript({ kind: 'auto', previewUrl: 'http://a.localhost', previewDomain: 'localhost' })) < 100_000);
});

test('a missing toolchain for the new languages is reported by name', () => {
  if (!has('zig')) assert.match(run({ entry: 'a.zig', files: { 'a.zig': 'pub fn main() void {}' } }), /'zig' is not installed in this sandbox image/);
  if (!has('scalac')) assert.match(run({ entry: 'a.scala', files: { 'a.scala': '@main def run() = println(1)' } }), /'scalac' is not installed/);
});

// ── SQL: SQLite by default, MariaDB / PostgreSQL by file name or a "-- engine:" comment ──
const unpriv = typeof process.getuid === 'function' && process.getuid() !== 0; // MariaDB / PostgreSQL refuse to run as root
test('sql: SQLite by default', needs(['sqlite3'], () => {
  assert.match(run({ entry: 'a.sql', files: { 'a.sql': 'CREATE TABLE t(n TEXT); INSERT INTO t VALUES ("x1"); SELECT * FROM t;' } }), /x1/);
}));
test('sql: a T-SQL script gets a clear warning', needs(['sqlite3'], () => {
  assert.match(run({ entry: 'a.sql', files: { 'a.sql': 'DECLARE @x INT = 1;\nSELECT 1;' } }), /looks like T-SQL/);
}));
test('tsql: a .tsql file runs on the built-in T-SQL runner (PRINT, variables, GO, TOP, TRY/CATCH)', needs(['python3'], () => {
  const out = run({ entry: 'main.tsql', files: { 'main.tsql': "PRINT 'Welcome In UIP NUB';\nDECLARE @n INT = 2;\nCREATE TABLE t (id INT IDENTITY(1,1) PRIMARY KEY, [name] NVARCHAR(20));\nINSERT INTO t ([name]) VALUES ('a'),('b'),('c');\nGO\nSELECT TOP 2 * FROM dbo.t ORDER BY id DESC;\nBEGIN TRY SELECT * FROM nope; END TRY BEGIN CATCH PRINT 'caught ' + ERROR_MESSAGE(); END CATCH" } });
  assert.match(out, /Welcome In UIP NUB/);
  assert.match(out, /\(2 rows affected\)/);
  assert.match(out, /caught Invalid object name 'nope'/);
}));
test('sql: "-- engine: mysql" runs on MariaDB', needs(['mariadbd', 'mariadb'], (t) => {
  if (!unpriv) return t.skip('MariaDB will not run as root');
  assert.match(run({ entry: 'a.sql', files: { 'a.sql': '-- engine: mysql\nCREATE TABLE t(id INT AUTO_INCREMENT PRIMARY KEY, n VARCHAR(9));\nINSERT INTO t(n) VALUES ("my1");\nSELECT * FROM t;' } }), /my1/);
}));
test('sql: a.pg.sql runs on PostgreSQL', needs(['psql'], (t) => {
  if (!unpriv || !has('ls /usr/lib/postgresql/*/bin/initdb')) return t.skip('needs PostgreSQL and a non-root user');
  assert.match(run({ entry: 'a.pg.sql', files: { 'a.pg.sql': "CREATE TABLE t(id SERIAL PRIMARY KEY, n TEXT);\nINSERT INTO t(n) VALUES ('pg1');\nSELECT * FROM t;" } }), /pg1/);
}));
