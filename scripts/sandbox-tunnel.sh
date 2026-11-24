#!/usr/bin/env bash
# Host-side helper: push a project into the running sandbox container, start it, open a cloudflared quick tunnel.
#   sudo ./scripts/sandbox-tunnel.sh --zip ~/UIP-React-main.zip
#   sudo ./scripts/sandbox-tunnel.sh --dir ~/my-project
#   sudo ./scripts/sandbox-tunnel.sh                       # project already in /home/dev/project (uploaded by the IDE)
# Options: --zip FILE | --dir DIR | --cmd 'command' | --port N | --no-tunnel
set -euo pipefail

ZIP=""; DIR=""; CMD=""; PORT=""; TUNNEL=1
usage() { sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'; }
while [ $# -gt 0 ]; do
  case "$1" in
    --zip) ZIP="${2:-}"; shift 2;;
    --dir) DIR="${2:-}"; shift 2;;
    --cmd) CMD="${2:-}"; shift 2;;
    --port) PORT="${2:-}"; shift 2;;
    --no-tunnel) TUNNEL=0; shift;;
    -h|--help) usage; exit 0;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2;;
  esac
done

T=""; T2=""
trap '[ -z "$T2" ] || rm -f "$T2"; [ -z "$T" ] || rm -rf "$T"' EXIT

# ---- 1) docker + container ---------------------------------------------------------------------------------------------
if docker info >/dev/null 2>&1; then DOCKER=(docker); else DOCKER=(sudo docker); fi
D() { "${DOCKER[@]}" "$@"; }
C=$(D ps --filter name=uip-sbx --format '{{.CreatedAt}}|{{.ID}}' | sort -r | head -1 | cut -d'|' -f2)
if [ -z "$C" ]; then echo "✗ no running sandbox container (uip-sbx-*). Press Run in the IDE once, then run this again." >&2; exit 1; fi
dx() { D exec "$C" bash -lc "$1"; }
echo "▶ container: $C"

# ---- 2) upload (optional) + detect ---------------------------------------------------------------------------------------
if [ -n "$ZIP" ] || [ -n "$DIR" ]; then
  T=$(mktemp -d); mkdir -p "$T/src"
  if [ -n "$ZIP" ]; then
    [ -f "$ZIP" ] || { echo "✗ zip not found: $ZIP" >&2; exit 1; }
    command -v unzip >/dev/null || { echo "✗ unzip is not installed on the host (apt install unzip)" >&2; exit 1; }
    unzip -q "$ZIP" -d "$T/src"
  else
    [ -d "$DIR" ] || { echo "✗ folder not found: $DIR" >&2; exit 1; }
    cp -a "$DIR/." "$T/src/"
  fi
  rm -rf "$T/src/__MACOSX"
  SRC="$T/src"
  if [ "$(ls -A "$SRC" | wc -l)" -eq 1 ] && [ -d "$SRC/$(ls -A "$SRC")" ]; then SRC="$SRC/$(ls -A "$SRC")"; fi   # GitHub-style zip: one top folder
  echo "▶ uploading $(du -sh "$SRC" | cut -f1) into /home/dev/project …"
  dx 'mkdir -p /home/dev/project && find /home/dev/project -mindepth 1 -maxdepth 1 -exec rm -rf {} +'
  D cp "$SRC/." "$C:/home/dev/project/"
  D exec -u 0 "$C" chown -R dev:dev /home/dev/project
else
  dx 'test -d /home/dev/project' || { echo "✗ /home/dev/project does not exist: pass --zip or --dir" >&2; exit 1; }
  if [ -z "$(dx 'ls -A /home/dev/project | grep -v -E "^(README.txt|package-lock.json)$" | head -1' || true)" ]; then
    echo "✗ /home/dev/project is empty: pass --zip or --dir (or run the project from the IDE first)" >&2; exit 1
  fi
fi

KIND=""
if [ -n "$CMD" ]; then KIND=custom
elif dx 'test -f /home/dev/project/artisan'; then KIND=laravel
elif dx 'test -f /home/dev/project/package.json'; then KIND=node
fi
if [ -z "$PORT" ]; then
  case "$KIND" in
    laravel) PORT=8000;;
    node) if dx "grep -q '\"vite\"' /home/dev/project/package.json"; then PORT=5173; else PORT=3000; fi;;
    *) PORT=5173;;
  esac
fi
echo "▶ detected: ${KIND:-unknown}   port: $PORT"

# ---- 3) tunnel first (Laravel needs the public URL as APP_URL) -------------------------------------------------------
URL=""
if [ "$TUNNEL" -eq 1 ]; then
  dx 'command -v cloudflared >/dev/null' || { echo "✗ cloudflared is not in this image (rebuild it: npm run build-image) — or use --no-tunnel" >&2; exit 1; }
  dx 'pkill -x cloudflared 2>/dev/null; rm -f /tmp/cf.log; true'
  D exec -d "$C" bash -lc "cloudflared tunnel --no-autoupdate --url http://127.0.0.1:$PORT >/tmp/cf.log 2>&1"
  echo -n "▶ waiting for the tunnel URL "
  for _ in $(seq 1 40); do
    URL=$(dx "grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' /tmp/cf.log 2>/dev/null | head -1" || true)
    [ -n "$URL" ] && break; echo -n "."; sleep 1
  done; echo
  [ -n "$URL" ] || { echo "✗ no tunnel URL after 40 s. Log:" >&2; dx 'tail -20 /tmp/cf.log' >&2 || true; exit 1; }
fi

# ---- 4) start the app (detached) ---------------------------------------------------------------------------------------
dx 'pkill -f "[v]ite|[a]rtisan serve|php -[S]" 2>/dev/null; rm -f /tmp/app.log; true'
T2=$(mktemp)
{
  echo 'set -e'; echo 'cd /home/dev/project'
  if [ -n "$CMD" ]; then
    echo "$CMD"
  elif [ "$KIND" = laravel ]; then
    cat <<LARAVEL
[ -d vendor ] || composer install --no-interaction --prefer-dist
[ -f .env ] || cp .env.example .env
grep -q '^APP_KEY=.\+' .env || php artisan key:generate --force
if grep -q '^DB_CONNECTION=sqlite' .env || ! grep -q '^DB_CONNECTION=' .env; then mkdir -p database; touch database/database.sqlite; fi
php artisan migrate --force || true
if [ -f package.json ] && [ ! -d public/build ]; then npm install --no-audit --no-fund && npm run build || true; fi
exec php artisan serve --host 0.0.0.0 --port $PORT
LARAVEL
  elif [ "$KIND" = node ]; then
    cat <<NODE
[ -d node_modules ] || npm install --no-audit --no-fund
if grep -q '"vite"' package.json && grep -q '"dev"' package.json; then exec npm run dev -- --host 0.0.0.0 --port $PORT
elif grep -q '"dev"' package.json; then exec npm run dev
else exec npm start; fi
NODE
  else
    echo "no package.json or artisan found: pass --cmd 'your command'" >&2; exit 1
  fi
} > "$T2" || exit 1
D cp "$T2" "$C:/tmp/uip-start.sh"
EXTRA=()
[ -z "$URL" ] || EXTRA=(-e "APP_URL=$URL" -e "ASSET_URL=$URL" -e APP_ENV=local -e APP_DEBUG=true)
D exec -d -w /home/dev/project -e HOST=0.0.0.0 -e "PORT=$PORT" -e BROWSER=none -e __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=.trycloudflare.com ${EXTRA[@]+"${EXTRA[@]}"} "$C" bash -lc 'bash /tmp/uip-start.sh >/tmp/app.log 2>&1'
echo "▶ starting the app (npm/composer install can take a few minutes) — log:  sudo docker exec $C tail -f /tmp/app.log"

echo -n "▶ waiting for port $PORT "
UP=0
for _ in $(seq 1 180); do
  if dx "curl -s -o /dev/null --max-time 2 http://127.0.0.1:$PORT/"; then UP=1; break; fi
  echo -n "."; sleep 2
done; echo
if [ "$UP" -ne 1 ]; then echo "✗ the app did not answer on $PORT. Last log lines:" >&2; dx 'tail -30 /tmp/app.log' >&2 || true; exit 1; fi

echo "✓ app is up on 127.0.0.1:$PORT inside the sandbox"
[ -z "$URL" ] || echo "✓ public URL: $URL   (random link, anyone who has it can open it; stop it with:  sudo docker exec $C pkill cloudflared)"
