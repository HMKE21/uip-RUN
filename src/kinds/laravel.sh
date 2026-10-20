echo "▶ Laravel project"
[ -f .env ] || { [ -f .env.example ] && cp .env.example .env; } || touch .env
mkdir -p database storage/framework/{cache/data,sessions,views} storage/logs bootstrap/cache
export APP_ENV=local APP_DEBUG=true APP_URL=@PREVIEW_URL@ ASSET_URL=@PREVIEW_URL@
# MySQL / MariaDB projects get a real MariaDB inside the sandbox; everything else uses SQLite
DBC=$(grep -E '^DB_CONNECTION=' .env 2>/dev/null | tail -1 | cut -d= -f2 | tr -d '"\r ')
if { [ "$DBC" = mysql ] || [ "$DBC" = mariadb ]; } && start_mysql; then
  export DB_CONNECTION="$DBC" DB_HOST=127.0.0.1 DB_PORT=3306 DB_DATABASE=app DB_USERNAME=root DB_PASSWORD=
else
  touch database/database.sqlite
  export DB_CONNECTION=sqlite DB_DATABASE="$PWD/database/database.sqlite"
fi
export SESSION_DRIVER=file CACHE_STORE=file CACHE_DRIVER=file QUEUE_CONNECTION=sync MAIL_MAILER=log LOG_CHANNEL=stderr
@HTTPS_EXPORTS@
if [ ! -d vendor ]; then
  if ! uip_restore vendor composer composer.json composer.lock; then
    echo "▶ composer install… (first run, can take a few minutes)"
    composer install --no-interaction --prefer-dist --no-progress --no-scripts || { echo "✗ composer install failed"; exit 1; }
    composer dump-autoload -q 2>/dev/null
    uip_save vendor composer composer.json composer.lock
  fi
fi
if [ -f package.json ] && [ ! -d public/build ] && grep -q '"build"' package.json; then
  echo "▶ building front-end assets (npm install && npm run build)…"
  { npm install --no-audit --no-fund --loglevel=error --prefer-offline && npm run build; } || echo "⚠ front-end build failed — continuing without it"
fi
if ! grep -Eq '^APP_KEY=.+' .env 2>/dev/null; then php artisan key:generate --force --no-interaction || true; fi
php artisan package:discover --ansi 2>/dev/null || true
echo "▶ php artisan migrate ($DB_CONNECTION)…"
php artisan migrate --force --no-interaction || echo "⚠ migrations failed — fix them and run: php artisan migrate"
php artisan storage:link 2>/dev/null || true
export PHP_CLI_SERVER_WORKERS=4
ROUTER=public/index.php
[ -f server.php ] && ROUTER=server.php
[ -f vendor/laravel/framework/src/Illuminate/Foundation/resources/server.php ] && ROUTER=vendor/laravel/framework/src/Illuminate/Foundation/resources/server.php
echo "▶ Laravel is starting on port 8000 — the preview opens automatically"
exec php -S 0.0.0.0:8000 -t public "$ROUTER"
