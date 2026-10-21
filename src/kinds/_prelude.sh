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

# ── per-user persistent cache (a Docker volume the gateway mounts at $UIP_PCACHE) ─────────────────────────────────
# The IDE uploads the project WITHOUT node_modules / vendor, so every run used to download and install everything again.
# uip_save keeps a tar of the installed folder keyed by a hash of the manifest files; uip_restore unpacks it next time
# (seconds instead of minutes, no network). Package-manager caches live there too. Nothing is shared between users.
if [ -n "$UIP_PCACHE" ] && [ -w "$UIP_PCACHE" ]; then
  export npm_config_cache="$UIP_PCACHE/npm" COMPOSER_CACHE_DIR="$UIP_PCACHE/composer" PIP_CACHE_DIR="$UIP_PCACHE/pip" YARN_CACHE_FOLDER="$UIP_PCACHE/yarn"
  # dependency caches of the other ecosystems (a second run of a Maven / Gradle / NuGet / Go / Cargo project skips the downloads)
  export NUGET_PACKAGES="$UIP_PCACHE/nuget" GRADLE_USER_HOME="$UIP_PCACHE/gradle" UV_CACHE_DIR="$UIP_PCACHE/uv"
  export MAVEN_OPTS="${MAVEN_OPTS:+$MAVEN_OPTS }-Dmaven.repo.local=$UIP_PCACHE/m2"
fi
export UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never
uip_hash() { cat "$@" 2>/dev/null | sha1sum | cut -c1-16; }
uip_restore() { # <dir> <tag> <manifest files…>
  local dir="$1" tag="$2"; shift 2
  [ -n "$UIP_PCACHE" ] && [ -w "$UIP_PCACHE" ] || return 1
  local f; f="$UIP_PCACHE/snap/$tag-$(uip_hash "$@").tar"
  [ -f "$f" ] || return 1
  if tar -xf "$f" 2>/dev/null; then touch "$f"; echo "▶ $dir restored from your cache — install skipped"; return 0; fi
  rm -rf "$dir"; return 1
}
uip_save() { # <dir> <tag> <manifest files…>
  local dir="$1" tag="$2"; shift 2
  if [ -z "$UIP_PCACHE" ] || [ ! -w "$UIP_PCACHE" ]; then echo "⚠ persistent cache is not available - $dir will be reinstalled on every run (check USER_CACHE / Docker provider)"; return 0; fi
  [ -d "$dir" ] || return 0
  local mb; mb=$(du -sm "$dir" 2>/dev/null | cut -f1)
  [ "${mb:-99999}" -le "${UIP_SNAP_MAX_MB:-1500}" ] || { echo "⚠ $dir is ${mb}MB (limit ${UIP_SNAP_MAX_MB:-1500}MB) - not cached, every run will reinstall. Raise UIP_SNAP_MAX_MB."; return 0; }
  mkdir -p "$UIP_PCACHE/snap"
  local f; f="$UIP_PCACHE/snap/$tag-$(uip_hash "$@").tar"
  if tar -cf "$f.tmp" "$dir" 2>/dev/null && mv -f "$f.tmp" "$f"; then echo "▶ $dir saved to your cache — the next run starts much faster"; else rm -f "$f.tmp"; fi
  ls -t "$UIP_PCACHE/snap/$tag"-*.tar 2>/dev/null | tail -n +4 | xargs -r rm -f   # keep the 3 newest per project type
  # keep the whole cache under the quota: drop the oldest snapshots, then the package-manager caches
  local total; total=$(du -sm "$UIP_PCACHE" 2>/dev/null | cut -f1)
  while [ "${total:-0}" -gt "${UIP_CACHE_MAX_MB:-2048}" ]; do
    local old; old=$(ls -tr "$UIP_PCACHE"/snap/*.tar 2>/dev/null | head -1)
    [ -n "$old" ] || { rm -rf "$UIP_PCACHE"/npm "$UIP_PCACHE"/pip "$UIP_PCACHE"/composer "$UIP_PCACHE"/yarn "$UIP_PCACHE"/nuget "$UIP_PCACHE"/gradle "$UIP_PCACHE"/uv "$UIP_PCACHE"/m2 "$UIP_PCACHE"/go "$UIP_PCACHE"/.cargo "$UIP_PCACHE"/bcache; break; }
    rm -f "$old"; total=$(du -sm "$UIP_PCACHE" 2>/dev/null | cut -f1)
  done
}

# ── build cache: a compiled program is built once per (language, sources) and then just started ──────────────────────
# Restart / Run on unchanged code skips the compiler completely (C# and Kotlin take seconds, even C++ takes a second or two).
# Lives in the per-user volume when there is one, otherwise in the container's home (still helps within one session).
UIP_BC="${UIP_PCACHE:-$HOME/.uip}/bcache"
uip_bkey() { # <tag> → hash of the tag and of the (small, non-hidden) files around the entry
  { echo "rev1 $1"; find . -maxdepth 3 -type f -size -512k ! -path '*/.*' ! -path '*/node_modules/*' ! -path '*/target/*' ! -path '*/build/*' ! -path '*/vendor/*' 2>/dev/null | sort | head -400 | xargs -r -d '\n' sha1sum 2>/dev/null; } | sha1sum | cut -c1-20
}
uip_bget() { # <tag> <out-path>   (a file or a folder)  → 0 when restored from the cache
  UIP_BKEY=$(uip_bkey "$1"); local f="$UIP_BC/$UIP_BKEY.tar"
  [ -f "$f" ] || return 1
  mkdir -p "$(dirname "$2")"
  if tar -C "$(dirname "$2")" -xf "$f" 2>/dev/null && [ -e "$2" ]; then touch "$f"; echo "▶ same code as last time — build skipped (cached)"; return 0; fi
  rm -rf "$2"; return 1
}
uip_bput() { # <out-path>   (after uip_bget)
  [ -e "$1" ] && [ -n "$UIP_BKEY" ] || return 0
  local mb; mb=$(du -sm "$1" 2>/dev/null | cut -f1); [ "${mb:-999}" -le 100 ] || return 0
  mkdir -p "$UIP_BC"
  local f="$UIP_BC/$UIP_BKEY.tar"
  if tar -C "$(dirname "$1")" -cf "$f.tmp" "$(basename "$1")" 2>/dev/null; then mv -f "$f.tmp" "$f"; else rm -f "$f.tmp"; fi
  ls -t "$UIP_BC"/*.tar 2>/dev/null | tail -n +41 | xargs -r rm -f   # keep the 40 newest builds
}
cbuild() { # <tag> <out-path> <compiler command…>  — run the compiler unless an identical build is cached
  local tag="$1" out="$2"; shift 2
  uip_bget "$tag" "$out" && return 0
  "$@" || return 1
  uip_bput "$out"; return 0
}

# Python virtualenv (uv when the image has it: 10-50x faster than pip; pip otherwise)
uip_pyvenv() {
  if command -v uv >/dev/null 2>&1; then [ -d "$HOME/venv" ] || uv venv -q "$HOME/venv"
  else [ -d "$HOME/venv" ] || python3 -m venv "$HOME/venv"; fi
  . "$HOME/venv/bin/activate"
}
uip_pip() { if command -v uv >/dev/null 2>&1; then uv pip install -q "$@"; else pip install -q "$@"; fi; }
# create the venv and install requirements.txt — skipped when requirements.txt did not change
uip_pyenv() {
  [ -f requirements.txt ] || return 0
  uip_pyvenv
  local h; h=$(uip_hash requirements.txt)
  [ -f "$HOME/venv/.req-$h" ] && return 0
  echo "▶ installing requirements.txt…"
  if uip_pip -r requirements.txt; then touch "$HOME/venv/.req-$h"; else echo "⚠ some packages failed to install"; fi
}
