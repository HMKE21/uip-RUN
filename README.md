# uip-sandbox — real sandbox for the UIP project IDE

Runs a student's code in a **locked-down Docker container** on a server of yours — **any language, single file or a whole
project** — and gives the IDE a real terminal (xterm.js) plus a live preview.

| `kind` | what it runs |
|---|---|
| `lang` + `entry` | one file: JavaScript (browser-style `prompt/alert` work in the terminal) · TypeScript · Python · PHP · Java · C · C++ · C# · Go · Rust · Ruby · Perl · Lua · R · Julia · Bash · Kotlin · Dart · Haskell · Fortran · Pascal · SQL (SQLite) |
| `laravel` | `composer install` → build assets → **SQLite or a real MariaDB** (when `.env` says `mysql`) → `migrate` → `php -S` |
| `node` | `npm install` → Vite / Next / Nuxt / Angular dev server, `npm start`, or plain `node` |
| `python` | `pip install -r requirements.txt` → script, Django `runserver`, Flask, FastAPI (`uvicorn`) |
| `maven` · `gradle` | Spring Boot (`spring-boot:run` / `bootRun`) or a plain `main()` project |
| `dotnet` · `go` · `cargo` · `rails` · `php` · `make` | ASP.NET / console · Go modules · Rust · Rails / Rack · Symfony, WordPress, plain PHP · Makefile / CMake (builds, then runs the new executable) |
| `static` · `shell` · `auto` | static site · just a terminal · detect from the files |

The per-kind scripts are plain bash in `src/kinds/*.sh` — add a language by adding a `case` line to `src/kinds/lang.sh`
(and the toolchain to `image/Dockerfile`).

```
Browser (UIP IDE) ──POST /api/v1/projects/{id}/sandbox-token──▶ Full-API   (checks the user may open the project, signs a 2-minute token)
        │
        ├──wss://sandbox.example.com/ws?token=…──────────────▶ this gateway  (terminal + control channel, uploads the project zip)
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
Projects run in containers, but without the server firewall: for demos with your own projects, not for strangers.

## 1. Server requirements
Linux VPS (≥ 4 vCPU / 8 GB RAM and ~30 GB disk for ~4 parallel sessions — Java, Kotlin, Gradle, Rust and .NET need more than the old
1 GB per session, so `SANDBOX_MEMORY` now defaults to `2g`; compiled languages and the first dependency download are slow), Docker, Node ≥ 20, a domain with wildcard DNS.
Optional but recommended: [gVisor](https://gvisor.dev) (`SANDBOX_RUNTIME=runsc`) for stronger isolation.

## 2. Install
```bash
git clone <this repo> /opt/uip-sandbox && cd /opt/uip-sandbox
npm ci --omit=dev
docker build -t uip-sandbox:latest image/        # PHP, Node, Python, Java, C/C++, Go, Rust, .NET, Ruby, … (~6-8 GB, build once)
sudo ./deploy/egress-firewall.sh                 # block private networks / metadata for sandbox containers (re-run after reboot)
cp .env.example .env && nano .env                # SANDBOX_JWT_SECRET (openssl rand -hex 32), ALLOWED_ORIGINS, PREVIEW_DOMAIN
sudo cp deploy/uip-sandbox.service /etc/systemd/system/ && sudo systemctl enable --now uip-sandbox
```
HTTPS: use `deploy/Caddyfile` (needs a Caddy build with your DNS provider module, for the wildcard certificate).
DNS: `sandbox.example.com` and `*.sbx.example.com` → the server. Use a domain **different from** your main site for the previews
(student apps can set cookies for the preview domain).

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
* The token is HS256, 2 minutes, single use (`jti`), audience `uip-sandbox`; the WebSocket also checks `Origin`.
* Preview URLs contain a random 64-bit session id and only work while the session lives; they can only be framed by `ALLOWED_ORIGINS`.
* The service user needs access to the Docker socket, which is root-equivalent **on that server** — keep it dedicated and patched.
* No per-container disk quota is set; put Docker's data-root on a size-limited volume (e.g. XFS project quotas) if you expect abuse.
