echo "▶ Node project"
if [ ! -f package.json ]; then echo "✗ package.json not found"; exit 1; fi
if [ ! -d node_modules ]; then
  echo "▶ npm install… (first run, can take a few minutes)"
  npm install --no-audit --no-fund || { echo "✗ npm install failed"; exit 1; }
fi
export HOST=0.0.0.0 PORT=3000 BROWSER=none DANGEROUSLY_DISABLE_HOST_CHECK=true CHOKIDAR_USEPOLLING=1
export __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=@ALLOWED_HOSTS@
if grep -q '"vite"' package.json && grep -q '"dev"' package.json; then
  echo "▶ npm run dev (Vite)"; exec npm run dev -- --host 0.0.0.0 --port 5173
elif grep -q '"@angular/cli"' package.json; then
  echo "▶ ng serve (Angular) on port 4200"; exec npx ng serve --host 0.0.0.0 --port 4200 --disable-host-check
elif grep -q '"next"' package.json && grep -q '"dev"' package.json; then
  echo "▶ npm run dev (Next.js)"; exec npm run dev -- -H 0.0.0.0 -p 3000
elif grep -q '"nuxt"' package.json && grep -q '"dev"' package.json; then
  echo "▶ npm run dev (Nuxt)"; exec npm run dev -- --host 0.0.0.0 --port 3000
elif grep -q '"dev"' package.json; then
  echo "▶ npm run dev"; exec npm run dev
elif grep -q '"start"' package.json; then
  echo "▶ npm start"; exec npm start
else
  MAIN=$(node -p "require('./package.json').main || ''" 2>/dev/null)
  if [ -z "$MAIN" ]; then for f in index.js server.js app.js main.js; do [ -f "$f" ] && MAIN=$f && break; done; fi
  if [ -n "$MAIN" ] && [ -f "$MAIN" ]; then
    echo "▶ node $MAIN"; export NODE_OPTIONS="--require $(uip_shim)"; exec node "$MAIN"
  fi
  echo "✗ package.json has no \"dev\" or \"start\" script and no entry file"; exit 1
fi
