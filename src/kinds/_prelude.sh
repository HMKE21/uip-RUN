need() { command -v "$1" >/dev/null 2>&1 || { echo "✗ '$1' is not installed in this sandbox image (add it to image/Dockerfile and rebuild the image)"; exit 127; }; }

# browser-style prompt()/alert()/confirm() for Node scripts; prints the path of the preload file
uip_shim() {
  mkdir -p "$HOME/.uip"
  cat > "$HOME/.uip/browser-shim.cjs" <<'UIP_SHIM_EOF'
@SHIM_SOURCE@
UIP_SHIM_EOF
  echo "$HOME/.uip/browser-shim.cjs"
}

# a throw-away MariaDB (MySQL-compatible) server on 127.0.0.1:3306, root without password, database "app"
start_mysql() {
  command -v mariadbd >/dev/null 2>&1 || { echo "⚠ MariaDB is not installed in this sandbox image"; return 1; }
  local D="$HOME/mysql-data" S="$HOME/mysql.sock"
  if [ ! -d "$D/mysql" ]; then
    echo "▶ initialising MariaDB (first run)…"
    mkdir -p "$D"
    mariadb-install-db --no-defaults --datadir="$D" --auth-root-authentication-method=normal --skip-test-db >"$HOME/mysql-init.log" 2>&1 || { echo "✗ could not initialise MariaDB (see $HOME/mysql-init.log)"; return 1; }
  fi
  if ! mariadb-admin --no-defaults -uroot --socket="$S" ping >/dev/null 2>&1; then
    echo "▶ starting MariaDB on 127.0.0.1:3306…"
    ( mariadbd --no-defaults --datadir="$D" --socket="$S" --bind-address=127.0.0.1 --port=3306 --skip-name-resolve \
        --innodb-buffer-pool-size=64M --performance-schema=OFF --character-set-server=utf8mb4 >"$HOME/mysql.log" 2>&1 & )
    local i; for i in $(seq 1 60); do mariadb-admin --no-defaults -uroot --socket="$S" ping >/dev/null 2>&1 && break; sleep 0.5; done
  fi
  mariadb-admin --no-defaults -uroot --socket="$S" ping >/dev/null 2>&1 || { echo "✗ MariaDB did not start (see $HOME/mysql.log)"; return 1; }
  mariadb --no-defaults -uroot --socket="$S" -e "CREATE DATABASE IF NOT EXISTS app CHARACTER SET utf8mb4" || return 1
  echo "✓ MariaDB ready — host 127.0.0.1, port 3306, user root (no password), database app"
}
