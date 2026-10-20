echo "▶ PHP project"
need php
if [ -f composer.json ] && [ ! -d vendor ]; then
  echo "▶ composer install… (first run, can take a few minutes)"
  composer install --no-interaction --prefer-dist --no-progress || echo "⚠ composer install failed — continuing"
fi
if grep -qsi 'mysql' composer.json .env .env.example wp-config.php config/database.php 2>/dev/null; then
  start_mysql && export DB_HOST=127.0.0.1 DB_PORT=3306 DB_DATABASE=app DB_USERNAME=root DB_PASSWORD=
fi
DOC=.
for d in public web www htdocs public_html; do [ -d "$d" ] && { DOC="$d"; break; }; done
export PHP_CLI_SERVER_WORKERS=4
echo "▶ php -S 0.0.0.0:8000 -t $DOC — the preview opens automatically"
exec php -S 0.0.0.0:8000 -t "$DOC"
