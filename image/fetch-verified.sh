#!/bin/sh
# fetch-verified <url> <out-file> <expected-sha256 | empty>
# Exit codes: 0 ok · 1 download failed (caller may skip an optional language) · 3 checksum problem (the build MUST stop).
url="$1"; out="$2"; want="$3"
curl -fsSL --retry 3 --retry-delay 2 "$url" -o "$out" || { rm -f "$out"; exit 1; }
got=$(sha256sum "$out" | cut -d' ' -f1)
if [ -n "$want" ]; then
  if [ "$got" != "$want" ]; then
    echo "✗ checksum MISMATCH for $url" >&2; echo "  expected $want" >&2; echo "  got      $got" >&2
    echo "  (changed a version? run: npm run pin-image -- --refresh)" >&2
    rm -f "$out"; exit 3
  fi
  echo "✔ verified $url"
elif [ "${PINS_STRICT:-0}" = 1 ]; then
  echo "✗ no pinned checksum for $url (sha256 $got) — run: npm run pin-image" >&2
  rm -f "$out"; exit 3
else
  echo "⚠ UNVERIFIED download $url (sha256 $got)" >&2
fi
