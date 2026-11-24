#!/bin/bash
# Optional toolchains (Zig, Scala 3, Groovy, PowerShell). A failed DOWNLOAD only skips that language;
# a CHECKSUM problem aborts the whole image build (fetch-verified exits with 3).
set -u
A=$(uname -m)
AU=$(echo "$A" | tr 'a-z' 'A-Z')   # X86_64 / AARCH64 -> picks the pinned checksum of this CPU architecture
case "$A" in x86_64) PA=x64;; aarch64) PA=arm64;; *) PA=$A;; esac
pin() { eval "printf '%s' \"\${$1_$AU:-}\""; }   # pin ZIG_SHA256 -> $ZIG_SHA256_X86_64

try() { # <name> <function>
  local name="$1"; shift
  "$@"; local rc=$?
  if [ "$rc" -eq 3 ]; then echo "✗ $name: checksum problem — build aborted" >&2; exit 1; fi
  [ "$rc" -eq 0 ] || echo "⚠ $name not installed (download or unpack failed)"
  return 0
}
install_zig()    { fetch-verified "https://ziglang.org/download/${ZIG_VERSION}/zig-linux-${A}-${ZIG_VERSION}.tar.xz" /tmp/zig.tar.xz "$(pin ZIG_SHA256)" || return $?
                   tar -xJf /tmp/zig.tar.xz -C /opt && mv "/opt/zig-linux-${A}-${ZIG_VERSION}" /opt/zig; }
install_scala() { fetch-verified "https://github.com/scala/scala3/releases/download/${SCALA_VERSION}/scala3-${SCALA_VERSION}.tar.gz" /tmp/scala.tgz "${SCALA_SHA256:-}" || return $?
                   tar -xzf /tmp/scala.tgz -C /opt && mv "/opt/scala3-${SCALA_VERSION}" /opt/scala3; }
install_groovy() { fetch-verified "https://archive.apache.org/dist/groovy/${GROOVY_VERSION}/distribution/apache-groovy-binary-${GROOVY_VERSION}.zip" /tmp/groovy.zip "${GROOVY_SHA256:-}" || return $?
                   unzip -q /tmp/groovy.zip -d /opt && mv "/opt/groovy-${GROOVY_VERSION}" /opt/groovy; }
install_pwsh()   { fetch-verified "https://github.com/PowerShell/PowerShell/releases/download/v${PWSH_VERSION}/powershell-${PWSH_VERSION}-linux-${PA}.tar.gz" /tmp/pwsh.tgz "$(pin PWSH_SHA256)" || return $?
                   mkdir -p /opt/pwsh && tar -xzf /tmp/pwsh.tgz -C /opt/pwsh && chmod +x /opt/pwsh/pwsh; }

install_v()      { fetch-verified "https://github.com/vlang/v/releases/download/${V_VERSION}/v_linux.zip" /tmp/v.zip "${V_SHA256:-}" || return $?
                   unzip -q /tmp/v.zip -d /opt && chmod -R a+rX /opt/v && chmod 755 /opt/v/v; }

install_code_server() { local CA; case "$A" in x86_64) CA=amd64;; aarch64) CA=arm64;; *) return 1;; esac
                   fetch-verified "https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/code-server-${CODE_SERVER_VERSION}-linux-${CA}.tar.gz" /tmp/code-server.tgz "$(pin CODE_SERVER_SHA256)" || return $?
                   mkdir -p /opt/code-server && tar -xzf /tmp/code-server.tgz -C /opt/code-server --strip-components=1 && ln -sf /opt/code-server/bin/code-server /usr/local/bin/code-server; }

install_cloudflared() { local CA; case "$A" in x86_64) CA=amd64;; aarch64) CA=arm64;; *) return 1;; esac
                   fetch-verified "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-${CA}" /usr/local/bin/cloudflared "$(pin CLOUDFLARED_SHA256)" || return $?
                   chmod 755 /usr/local/bin/cloudflared; }

try Zig install_zig
try code-server install_code_server
[ -z "${CLOUDFLARED_VERSION:-}" ] || try cloudflared install_cloudflared
try V install_v
try Scala install_scala
try Groovy install_groovy
try PowerShell install_pwsh
[ -x /opt/pwsh/pwsh ] || rm -rf /opt/pwsh
[ -x /opt/v/v ] || rm -rf /opt/v
[ -x /opt/code-server/bin/code-server ] || rm -rf /opt/code-server /usr/local/bin/code-server
rm -f /tmp/code-server.tgz /tmp/zig.tar.xz /tmp/scala.tgz /tmp/groovy.zip /tmp/pwsh.tgz /tmp/v.zip
# ---- required tools ------------------------------------------------------------------------------------------------------
# `try` above only WARNS when a download/unpack fails, so a full disk or a flaky network used to produce an image without
# cloudflared / code-server -- and Docker then CACHED that broken layer, so every later build kept it.
# Anything listed in EXTRAS_REQUIRED (Dockerfile ARG, default: cloudflared code-server) now fails the build instead.
# Set EXTRAS_REQUIRED="" to allow a build without them.
missing=""
for need in ${EXTRAS_REQUIRED:-}; do
  case "$need" in
    cloudflared) [ -x /usr/local/bin/cloudflared ] || missing="$missing cloudflared" ;;
    code-server) [ -x /usr/local/bin/code-server ] || missing="$missing code-server" ;;
    *) echo "⚠ EXTRAS_REQUIRED: unknown tool '$need' (ignored)" >&2 ;;
  esac
done
if [ -n "$missing" ]; then
  echo "✗ required tool(s) not installed:$missing" >&2
  echo "  Usual causes: the server disk is full ('No space left on device' above) or GitHub is unreachable from the build." >&2
  echo "  Free space (see scripts/free-space.sh) and build again, or set EXTRAS_REQUIRED=\"\" to skip the check." >&2
  exit 1
fi
exit 0
