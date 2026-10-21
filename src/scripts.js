// Builds the bash script that runs inside the sandbox terminal for each kind of project.
// The project is unpacked into /home/dev/project (the IDE sends only the app's own folder, so the root is the app root).
// The app itself runs in a nested `bash -c`, so when it stops (Ctrl+C, crash, exit) the student drops into a normal shell.
//
// The per-kind scripts live in src/kinds/<kind>.sh (plain bash, easy to read and edit). Placeholders:
//   @ENTRY@ @PREVIEW_URL@ @ALLOWED_HOSTS@  → shell-quoted values      @HTTPS_EXPORTS@ → extra exports for https previews
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = new URL('./kinds/', import.meta.url);
const read = (f) => readFileSync(fileURLToPath(new URL(f, dir)), 'utf8').replace(/\s+$/, '');

/**
 * kind → what it runs
 *   laravel · node · python · static · shell                      (original kinds)
 *   lang    — ONE source file (entry) in any supported language: js ts py php java kt scala groovy clj c cpp cs fs vb go rs zig nim d adb cob asm rb pl raku lua r jl m sh ps1 dart hs ml ex erl lisp scm rkt pro tcl awk f90 pas v vhd sql
 *   maven · gradle · dotnet · go · cargo · rails · php · make     (whole projects, built and started with their own tool)
 *   auto    — look at the files and pick (entry given → lang)
 */
export const KINDS = ['laravel', 'node', 'python', 'static', 'shell', 'lang', 'maven', 'gradle', 'dotnet', 'go', 'cargo', 'rails', 'php', 'make', 'auto'];

/** POSIX single-quote a string. */
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

const SOURCES = Object.fromEntries(['laravel', 'node', 'python', 'static', 'shell', 'lang', 'maven', 'gradle', 'dotnet', 'go', 'cargo', 'rails', 'php', 'make'].map((k) => [k, read(`${k}.sh`)]));
const PRELUDE = read('_prelude.sh').replace('@SHIM_SOURCE@', () => read('browser-shim.cjs'));

// `auto`: first marker that matches wins (most specific first)
const AUTO = [
  ['[ -f artisan ]', 'laravel'],
  ['[ -f pom.xml ]', 'maven'],
  ['[ -f build.gradle ] || [ -f build.gradle.kts ]', 'gradle'],
  ['ls ./*.csproj ./*.sln >/dev/null 2>&1', 'dotnet'],
  ['[ -f go.mod ]', 'go'],
  ['[ -f Cargo.toml ]', 'cargo'],
  ['[ -f bin/rails ] || [ -f config.ru ]', 'rails'],
  ['[ -f manage.py ]', 'python'],
  ['[ -f composer.json ]', 'php'],
  ['[ -f package.json ]', 'node'],
  ['[ -f CMakeLists.txt ] || [ -f Makefile ] || [ -f makefile ]', 'make'],
  ['[ -f main.py ] || [ -f app.py ] || [ -f requirements.txt ]', 'python'],
  ['[ -f index.php ]', 'php'],
  ['[ -f index.html ]', 'static'],
];

function body(kind, ctx) {
  const { entry, previewUrl, previewDomain, https } = ctx;
  if (kind === 'auto') {
    if (entry) return body('lang', ctx);
    // The prelude is written to a file ONCE and every branch sources it. Repeating it in each branch made the script > 128 KB,
    // which is more than a single `bash -c` argument may be ("Argument list too long").
    const branches = AUTO.map(([test, k]) => `if ${test}; then exec bash -c ${shq(`. "$HOME/.uip-prelude.sh"\n${body(k, { ...ctx, entry: '' })}`)}; fi`);
    return `mkdir -p "$HOME"; cat > "$HOME/.uip-prelude.sh" <<'UIP_PRELUDE_EOF'\n${PRELUDE}\nUIP_PRELUDE_EOF\n${branches.join('\n')}\necho "✗ could not tell what this project is — open a file and press Run on it, or use the terminal below."\nexit 1`;
  }
  return SOURCES[kind]
    .replaceAll('@ENTRY@', () => shq(entry))
    .replaceAll('@PREVIEW_URL@', () => shq(previewUrl))
    .replaceAll('@ALLOWED_HOSTS@', () => shq(`.${previewDomain.replace(/:\d+$/, '')}`))
    .replaceAll('@HTTPS_EXPORTS@', () => (https ? 'export HTTPS=on SESSION_SECURE_COOKIE=true SESSION_SAME_SITE=none' : ''));
}

/**
 * @param {{kind: string, entry?: string, previewUrl: string, previewDomain: string}} o
 * @returns {string} bash script text
 */
export function buildScript({ kind, entry = '', previewUrl, previewDomain }) {
  if (!KINDS.includes(kind)) throw new Error(`unknown kind: ${kind}`);
  const https = /^https:/i.test(previewUrl);
  const inner = `${PRELUDE}\n${body(kind, { entry, previewUrl, previewDomain, https })}`.trim();
  return [
    'cd /home/dev/project',
    `bash -c ${shq(inner)}`,
    'code=$?',
    'echo',
    'if [ "$code" -eq 0 ]; then echo "— process finished —"; else echo "— process exited with code $code —"; fi',
    'echo "You have a normal shell now. Re-run the project with the Restart button."',
    'exec bash -l',
    '',
  ].join('\n');
}
