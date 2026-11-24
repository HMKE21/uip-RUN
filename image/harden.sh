#!/bin/sh
# Hardening of a sandbox container. Runs as root (a) once at image build (Dockerfile: `harden.sh build`) and (b) on every new session
# container (src/docker.js -> hardenContainer: `harden.sh auto`), so it also protects an image that was built before this script changed.
# Idempotent. Nothing in here removes a tool students use.
#
# FAIL-CLOSED: the gateway reads the last line of the output. Only "HARDEN-OK" lets a session start; anything else
# (HARDEN-FAIL lines, a timeout, a crash, no output) destroys the container and the student gets an error instead of an open shell.
#
# Modes:
#   build   apply everything, verify everything, write the marker file; exit 1 if anything is still open (fails the image build)
#   auto    (default) if the image carries the marker for THIS revision and the quick checks pass -> nothing to do (fast);
#           otherwise apply + full verify.  Prints HARDEN-FAIL <what> lines and finally HARDEN-OK; exit 1 on failure.
#   verify  checks only (full scan), changes nothing.
#
# What it closes (each one was reachable from the "My PC" terminal):
#   1  setuid / setgid binaries                      -> none left
#   2  su / sudo / runuser / passwd / mount / ...    -> root-only (mode 0700): the shell can not even try them ("su: Authentication failure" probing)
#   3  accounts                                      -> every password locked ("*"), service accounts get a nologin shell (postgres had /bin/bash)
#   4  world-writable files / folders (rustup toolchains, cargo/bin, /var/www/html ...) -> closed (sticky dirs such as /tmp stay as they are)
#   5  credentials of the bundled databases          -> root-only
# HARDEN_ROOT=<dir> runs the same logic against a copy of the file tree (used by the tests only).

HARDEN_REV=2
R="${HARDEN_ROOT:-}"
MARK="$R/etc/uip-hardened"
MODE="${1:-auto}"
FAILS=0
fail() { FAILS=$((FAILS + 1)); echo "HARDEN-FAIL $1"; }

PRIV_TOOLS="su sudo sudoedit runuser newgrp sg chsh chfn passwd gpasswd chage expiry pkexec mount umount login unix_chkpwd"
BIN_DIRS="/bin /sbin /usr/bin /usr/sbin /usr/local/bin /usr/local/sbin"
# every place a package or a toolchain installer may leave something world-writable
WW_DIRS="/usr /opt /var/www /var/opt /var/local /srv /etc"
SVC_USERS="postgres|mysql|epmd|www-data|list|irc|news|uucp|proxy|backup|games|man|lp|mail|daemon|bin|sys|sync"

existing() { for d in "$@"; do [ -d "$R$d" ] && printf '%s ' "$R$d"; done; }

# ---------------------------------------------------------------------------------------------------------------- apply
apply() {
  # 1) no setuid / setgid files anywhere in the program folders
  # shellcheck disable=SC2046
  D=$(existing /bin /sbin /usr /opt); [ -n "$D" ] && find $D -xdev -type f -perm /6000 -exec chmod a-s {} + 2>/dev/null

  # 2) privilege tools are root-only: `dev` gets "Permission denied" instead of a password prompt
  for d in $BIN_DIRS; do
    for t in $PRIV_TOOLS; do
      f="$R$d/$t"
      [ -f "$f" ] && [ ! -L "$f" ] && chmod 0700 "$f" 2>/dev/null
    done
  done

  # 3) accounts: no password works for anybody (the container never needs one) and service accounts have no login shell.
  #    Edited in place (cat > file) so the file keeps its owner / mode.
  if [ -f "$R/etc/shadow" ] && [ -w "$R/etc/shadow" ]; then
    T=$(mktemp) && sed -E 's#^([^:]+):[^:]*:#\1:*:#' "$R/etc/shadow" > "$T" && cat "$T" > "$R/etc/shadow"; rm -f "$T"
  fi
  if [ -f "$R/etc/passwd" ] && [ -w "$R/etc/passwd" ]; then
    T=$(mktemp) && sed -E "s#^(($SVC_USERS):.*):[^:]*\$#\\1:/usr/sbin/nologin#" "$R/etc/passwd" > "$T" && cat "$T" > "$R/etc/passwd"; rm -f "$T"
  fi

  # 4) nothing writable by "other" in the program / config folders (a planted `cargo` or `rustc` would run for every later command).
  #    Sticky folders (/tmp, /var/tmp, /dev/shm) are meant to be shared and are not touched.
  # shellcheck disable=SC2046
  D=$(existing $WW_DIRS); [ -n "$D" ] && find $D -xdev ! -type l -perm -0002 ! -perm -1000 -exec chmod o-w {} + 2>/dev/null
  # rustup's scratch folders belong to the student account (works at image build; at run time without CAP_CHOWN it is simply skipped)
  for d in tmp downloads update-hashes; do [ -e "$R/usr/local/rustup/$d" ] && chown dev:dev "$R/usr/local/rustup/$d" 2>/dev/null; done

  # 5) database credentials are root-only
  for f in "$R"/etc/mysql/debian.cnf "$R"/etc/postgresql/*/main/pg_hba.conf; do [ -f "$f" ] && chmod o-rwx "$f" 2>/dev/null; done
}

# --------------------------------------------------------------------------------------------------------------- verify
# quick = only the cheap checks (no full tree scans)
verify() {
  FAILS=0
  for d in $BIN_DIRS; do
    for t in $PRIV_TOOLS; do
      f="$R$d/$t"
      if [ -f "$f" ] && [ ! -L "$f" ]; then
        m=$(stat -c %a "$f" 2>/dev/null) || m=777
        [ $((0$m & 05)) -eq 0 ] || fail "privilege-tool:$d/$t"
      fi
    done
  done
  if [ -f "$R/etc/shadow" ]; then
    # any account whose password field is not locked
    bad=$(cut -d: -f1,2 "$R/etc/shadow" | grep -Ev ':[*!]' | head -n1)
    [ -z "$bad" ] || fail "unlocked-account:${bad%%:*}"
  fi
  if [ -f "$R/etc/passwd" ]; then
    bad=$(grep -E "^($SVC_USERS):" "$R/etc/passwd" | grep -Ev ':/usr/sbin/nologin$|:/bin/false$|:/sbin/nologin$|:/bin/sync$' | head -n1)
    [ -z "$bad" ] || fail "service-account-shell:${bad%%:*}"
  fi
  for f in "$R"/etc/mysql/debian.cnf "$R"/etc/postgresql/*/main/pg_hba.conf; do
    if [ -f "$f" ]; then m=$(stat -c %a "$f" 2>/dev/null) || m=777; [ $((0$m & 07)) -eq 0 ] || fail "db-credentials:$f"; fi
  done
  [ "$1" = quick ] && return
  # shellcheck disable=SC2046
  D=$(existing /bin /sbin /usr /opt)
  if [ -n "$D" ]; then p=$(find $D -xdev -type f -perm /6000 -print -quit 2>/dev/null); [ -z "$p" ] || fail "setuid:$p"; fi
  D=$(existing $WW_DIRS)
  if [ -n "$D" ]; then p=$(find $D -xdev ! -type l -perm -0002 ! -perm -1000 -print -quit 2>/dev/null); [ -z "$p" ] || fail "world-writable:$p"; fi
}

case "$MODE" in
  verify) verify full ;;
  build)
    apply; verify full
    if [ "$FAILS" -eq 0 ]; then echo "$HARDEN_REV" > "$MARK"; chmod 644 "$MARK"; fi ;;
  *) # auto
    if [ -f "$MARK" ] && [ "$(cat "$MARK" 2>/dev/null)" = "$HARDEN_REV" ]; then
      verify quick
      [ "$FAILS" -eq 0 ] && { echo "HARDEN-OK"; exit 0; }
    fi
    apply; verify full ;;
esac

if [ "$FAILS" -eq 0 ]; then echo "HARDEN-OK"; exit 0; fi
exit 1
