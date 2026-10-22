# uip-sandbox — real sandbox for the UIP project IDE

Runs a student's code in a **locked-down Docker container** on a server of yours — **any language, single file or a whole
project** — and gives the IDE a real terminal (xterm.js) plus a live preview.

| `kind` | what it runs |
|---|---|
| `lang` + `entry` | one file, **~60 file types / 45+ languages**: JavaScript (browser-style `prompt/alert` work in the terminal) · TypeScript · Python · PHP · Ruby · Perl · Raku · Lua · R · Julia · MATLAB/Octave · Bash · PowerShell · Tcl · AWK · SQL (SQLite, MariaDB/MySQL or PostgreSQL) · Java · Kotlin · Scala · Groovy · Clojure · C · C++ · C# · F# · VB.NET · Go · Rust · Zig · Nim · D · Ada · COBOL · Assembly (NASM / GNU) · Fortran · Pascal · Dart · Haskell · OCaml · Elixir · Erlang · Common Lisp · Scheme · Racket · Prolog · Verilog · VHDL |
| `laravel` | `composer install` → build assets → **SQLite or a real MariaDB** (when `.env` says `mysql`) → `migrate` → `php -S` |
| `node` | `npm install` → Vite / Next / Nuxt / Angular dev server, `npm start`, or plain `node` |
| `python` | `pip install -r requirements.txt` → script, Django `runserver`, Flask, FastAPI (`uvicorn`) |
| `maven` · `gradle` | Spring Boot (`spring-boot:run` / `bootRun`) or a plain `main()` project |
| `dotnet` · `go` · `cargo` · `rails` · `php` · `make` | ASP.NET / console · Go modules · Rust · Rails / Rack · Symfony, WordPress, plain PHP · Makefile / CMake (builds, then runs the new executable) |
| `static` · `shell` · `auto` | static site · just a terminal · detect from the files |

The per-kind scripts are plain bash in `src/kinds/*.sh` — add a language by adding a `case` line to `src/kinds/lang.sh`
(and the toolchain to `image/Dockerfile`, then bump `LABEL uip.sandbox.rev` there so existing images get rebuilt).

### Why runs are fast
* **Build cache** — a compiled program (C, C++, Rust, Go, Zig, Nim, D, Ada, COBOL, Java, Kotlin, Scala, C#, F#, VB.NET, OCaml…) is built once per
  *(language, sources)*. **Run / Restart on unchanged code skips the compiler** (Rust: 8 s → 0.07 s). Kept in the per-user volume (or the
  container's home when there is none); the 40 newest builds are kept.
* **Dependency caches in the per-user volume** — npm, Composer, pip/**uv**, Maven, Gradle, NuGet, Go modules, Cargo: a second run of a project downloads nothing.
* **uv** instead of pip for `requirements.txt` (10–50× faster), and the venv is reused until `requirements.txt` changes.
* Tuned toolchains: `-O1` for C/C++/Rust (a debug build of a loop-heavy program is 10–50× slower), JVM flags for short programs (`SerialGC`, CDS,
  C1 for the compilers), .NET without the NuGet audit / apphost / PGO, Go without cgo for single files (no C compiler in the build), one build + `dotnet app.dll` instead of `dotnet run`.
* 2 CPUs per session by default (`SANDBOX_CPUS`; it is a cap, not a reservation).

### "'xyz' is not installed in this sandbox image"
Your image was built from an older `image/Dockerfile`. `npm run local` now compares the image's `uip.sandbox.rev` label with the Dockerfile and rebuilds by itself;
on a server the gateway prints a warning at start-up — rebuild with `npm run build-image`.

```
Browser (UIP IDE) ──POST /api/v1/projects/{id}/sandbox-token──▶ Full-API   (checks the user may open the project, signs a 2-minute token)
        │
        ├──wss://sandbox.example.com/ws  (1st frame {t:'auth',token})▶ this gateway  (terminal + control channel, uploads the project zip)
        └──iframe https://<sessionId>.sbx.example.com ───────▶ this gateway  (reverse proxy to the app inside the container)
```

* One container per session, **one session per user**, all limits configurable (CPU, RAM, PIDs, lifetime, idle time).
* The container has `--cap-drop ALL`, `no-new-privileges`, no mounts, no secrets, and (with `deploy/egress-firewall.sh`) can reach
  the Internet (npm, Packagist, PyPI) but **not** private networks, the cloud metadata service or the host.
* Laravel: `composer install` → front-end build (if needed) → SQLite (or MariaDB for `DB_CONNECTION=mysql`) + `migrate` → `php -S 0.0.0.0:8000`.
  Node: `npm install` → `npm run dev` (Vite gets `--host 0.0.0.0`). Python: `pip install -r requirements.txt` → your script / Django `runserver`.
* The preview opens automatically when something listens on 8000 / 5173 / 3000 / 4173 / 8080 / 5000 (on `0.0.0.0`, not only `127.0.0.1`;
  Flask's `app.run()` needs `host="0.0.0.0"` — the terminal shows a hint if it doesn't).
* Run it on a **separate server** from Full-API and the database. It is not for Railway's free plan (it needs Docker and a wildcard domain).

## Quick start on your own computer (free demo)
Needs Docker (Docker Desktop on Windows/macOS) and Node ≥ 20.
```bash
npm ci --omit=dev
npm run local          # builds the image on the first run, creates .env.local, prints the 2 variables for Railway, starts on :8787
```
Then set `SANDBOX_URL=http://localhost:8787` and the printed `SANDBOX_JWT_SECRET` on Railway. The React app's CSP must allow
`ws://localhost:8787` (connect-src) and `http://*.localhost:8787` (frame-src) — already included in the overlay.
It only works in the browser of the computer that runs it (Chrome/Edge/Firefox; Chrome may ask to allow access to local devices — click Allow).
Projects run in containers, but **without the server firewall** (Docker Desktop on Windows / macOS has none): code run there can reach your computer and local network. For your own projects only — `npm run local` sets `ALLOW_NO_FIREWALL=1` for you on those systems; never let students use it. Real users need the Linux server below.

## 1. Server requirements
Linux VPS (≥ 4 vCPU / 8 GB RAM and ~40 GB disk for ~4 parallel sessions — Java, Kotlin, Gradle, Rust and .NET need more than the old
1 GB per session, so `SANDBOX_MEMORY` now defaults to `2g`; compiled languages and the first dependency download are slow), Docker, Node ≥ 20, a domain with wildcard DNS.
Optional but recommended: [gVisor](https://gvisor.dev) (`SANDBOX_RUNTIME=runsc`) for stronger isolation.

## 2. Install
```bash
git clone <this repo> /opt/uip-sandbox && cd /opt/uip-sandbox
npm ci --omit=dev
npm run build-image                              # pins every base image (digest) and download (sha256) in image/pins.env — commit it — then builds (~9-11 GB, build once)
sudo ./deploy/egress-firewall.sh                 # block private networks / metadata for sandbox containers (the systemd unit re-runs it before every start)
cp .env.example .env && nano .env                # SANDBOX_JWT_SECRET (openssl rand -hex 32), ALLOWED_ORIGINS, PREVIEW_DOMAIN
sudo cp deploy/uip-sandbox.service /etc/systemd/system/ && sudo systemctl enable --now uip-sandbox
```
HTTPS: use `deploy/Caddyfile` (needs a Caddy build with your DNS provider module, for the wildcard certificate).
DNS: `sandbox.example.com` and `*.sbx.example.com` → the server. Use a domain **different from** your main site for the previews
(student apps can set cookies for the preview domain).

On start the gateway **proves** the firewall works (a throw-away sandbox tries to reach every address of the host and a container on
another Docker network) and **exits with an error if anything gets through**; it repeats the check every 10 minutes, stops sessions and
refuses new ones if the protection disappears, and `/healthz` turns 503. Student code is never run without it.
The used-token table is kept in `$STATE_DIRECTORY` (`/var/lib/uip-sandbox/jti.log`, set up by the unit's `StateDirectory=`), so a restart
does not make a stolen token usable again.

### Updating the image (Dockerfile)
Change a version / tag in `image/Dockerfile`, bump `LABEL uip.sandbox.rev`, run `npm run pin-image -- --refresh` and review the diff of
`image/pins.env`, then `npm run build-image`. A download without a matching checksum, or a changed one, **stops the build**.
Checksums are compared with the publisher's own (Gradle, Kotlin, Groovy, PowerShell, Zig); Scala 3 publishes none, so its pin is
trust-on-first-use. Not pinned: Debian packages (apt, signed), `gem` / `npm -g` installs inside the image (latest at build time).

## 3. Connect Full-API (Railway)
Add two variables and redeploy:
```
SANDBOX_URL=https://sandbox.example.com
SANDBOX_JWT_SECRET=<same value as the gateway>
```

## 4. Connect the React app
In `vercel.json` **and** `netlify.toml` replace `https://*.sandbox-previews.example.com` (in `frame-src`) with your preview wildcard,
e.g. `https://*.sbx.example.com`. `connect-src` already allows `wss:`. Run `npm install` (adds `@xterm/xterm`, `@xterm/addon-fit`) and redeploy.
The Run dropdown then lists "Laravel", "Node", "Python (Flask/Django)", "React — dev server (sandbox)" and "Python — … (interactive terminal)".

## Wire protocol (IDE ⇄ gateway: JSON text frames + one binary frame)
`→ {t:'init', kind, entry, cols, rows, resume?}` · `← {t:'send-files'}` · `→ <zip bytes>` · `← status | session | out | preview | hint | exit | error | closed`
· `→ input | resize | restart | stop`. `kind` ∈ laravel · node · python · static · shell · lang · maven · gradle · dotnet · go · cargo · rails · php · make · auto.

## Tests
`npm test` — token verification, script generation (every script is parsed by `bash -n`), `/proc/net/tcp` parser, and an
end-to-end run of the gateway with the *local* provider (`SANDBOX_PROVIDER=local`: **no isolation, development only**).

## Security notes
* **Token**: HS256, <= 15 min, single use (`jti` mandatory, remembered on disk across restarts; if it can't be stored the login is refused), audience `uip-sandbox`, issuer `uip-api`. Failed logins are rate-limited per IP.
* **WebSocket**: `Origin` checked, token only in the first frame, an unauthenticated socket may send at most 4 KB, connections per IP / unauthenticated sockets capped, text frames <= 64 KB, output back-pressured.
* **Project zip**: central directory inspected before unpacking (zip-slip, absolute paths, zip bombs, file count, encrypted/zip64).
* **Container**: `--cap-drop ALL`, `no-new-privileges`, CPU/RAM/PID/file-size limits, IPv6 off, public DNS only, `enable_icc=false` network, no secrets (gateway env never passed on), cache volume named from a 128-bit hash.
* **Disk**: watchdog stops a session over `SANDBOX_MAX_DISK_MB` and clears an oversized cache. For a hard quota use `SANDBOX_DISK` or a size-limited Docker data-root.
* **Network**: `deploy/egress-firewall.sh` blocks private ranges, metadata, **and the host on every address**; the systemd unit re-applies it before each start, and the gateway **verifies it works** at start-up and every 10 min (`ALLOW_NO_FIREWALL=1` skips the check — your own machine only).
* **Previews**: no login — the link *is* the capability (128-bit random id, dies with the session; **Stop** revokes it). Anyone who has the link sees the preview: don't post it publicly.
  Hardening: framed only by `ALLOWED_ORIGINS`, `X-Robots-Tag: noindex`, `Domain=` stripped from cookies, Referrer-Policy `same-origin`, an IP that requests unknown ids is blocked for a minute (`MAX_PREVIEW_MISSES`),
  the first IPs that open each preview are logged (`preview_viewer`). Use ONE wildcard certificate (as in `deploy/Caddyfile`), never per-host certificates — those would publish every session id in the public certificate-transparency logs. Use a SEPARATE registrable domain.
* **Gateway**: binds 127.0.0.1, systemd-sandboxed. Docker access is root-equivalent on the host: dedicated server, ideally gVisor (`SANDBOX_RUNTIME=runsc`).
* **Browser runner**: preview iframe has NO `allow-same-origin` / `allow-modals`; storage is in-memory.
* `SANDBOX_PROVIDER=local` has no isolation and refuses to start in production / with https previews.
* **Supply chain**: images by digest, downloads by sha256 (`image/pins.env`), `install-php-extensions` from a pinned image instead of `latest`; the build fails on any mismatch.
