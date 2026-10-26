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

try Zig install_zig
try V install_v
try Scala install_scala
try Groovy install_groovy
try PowerShell install_pwsh
[ -x /opt/pwsh/pwsh ] || rm -rf /opt/pwsh
[ -x /opt/v/v ] || rm -rf /opt/v
rm -f /tmp/zig.tar.xz /tmp/scala.tgz /tmp/groovy.zip /tmp/pwsh.tgz /tmp/v.zip
exit 0
