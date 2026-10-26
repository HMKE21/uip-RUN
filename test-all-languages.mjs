// usage: node run-all.mjs <create.js> <uip-RUN-main> <outdir> [onlyIds,comma]
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [createJs, runDir, outDir, only] = process.argv.slice(2);
const src = readFileSync(createJs, 'utf8');
const hello = new Function(`return (${/const HELLO = (\{[\s\S]*?\n\});/.exec(src)[1]})`)();
const types = [...src.matchAll(/\{ id: '(\w+)', ext: '(\w+)', group: 'code'/g)].map((m) => ({ id: m[1], ext: m[2] }));
const { buildScript } = await import(pathToFileURL(join(runDir, 'src/scripts.js')).href);
mkdirSync(outDir, { recursive: true });
const results = [];
for (const t of types) {
  if (only && !only.split(',').includes(t.id)) continue;
  const code = hello[t.id];
  const base = t.id === 'java' ? 'Main' : 'main';   // default names given by the dialog
  const file = `${base}.${t.ext}`;
  const root = mkdtempSync(join(outDir, `${t.id}-`)); const proj = join(root, 'project'); mkdirSync(proj);
  if (code == null) { results.push({ id: t.id, file, status: 'NO_TEMPLATE' }); continue; }
  writeFileSync(join(proj, file), code);
  const s = buildScript({ kind: 'lang', entry: file, previewUrl: 'http://a.localhost', previewDomain: 'localhost' })
    .replace('cd /home/dev/project', `cd '${proj}'`).replace('exec bash -l\n', '');
  const t0 = Date.now();
  const r = spawnSync('bash', ['-c', s], { input: '', env: { ...process.env, JAVA_TOOL_OPTIONS: '-Dfile.encoding=UTF-8', HOME: root, PATH: `${process.env.PATH}:/opt/scala3/bin:/opt/pwsh:/usr/local/lib/python3.13/site-packages/ziglang` }, encoding: 'utf8', timeout: 170_000 });
  const out = `${r.stdout}${r.stderr}`;
  const ok = t.id === 'sql' ? /Sara/.test(out) && /Omar/.test(out) && r.status === 0 : (/^\s*Welcome In UIP NUB\s*$/m.test(out) && !/syntax error|error:/i.test(out));
  results.push({ id: t.id, file, status: ok ? 'PASS' : 'FAIL', secs: ((Date.now() - t0) / 1000).toFixed(1), tail: out.trim().split('\n').slice(0, 14).join('\n').slice(0, 900) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${t.id.padEnd(8)} ${file}  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
writeFileSync(join(outDir, 'results.json'), JSON.stringify(results, null, 1));
