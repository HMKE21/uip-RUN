# Sandbox image: every language / environment a student project may need.
#   docker build -t uip-sandbox:latest image/        (first build: 20-40 min, image ≈ 9-11 GB — build it once on the server)
#
# PHP 8.4 + Composer + MariaDB (Laravel, Symfony, WordPress…)      Node 22 + npm + TypeScript (tsx) + Deno + pnpm/yarn
# Python 3 (+pip, venv, uv)                                       Java 17 + Maven + Gradle + Kotlin + Scala 3 + Groovy + Clojure
# C / C++ (gcc, g++, make, cmake, gdb)                            Go · Rust (cargo) · Zig · Nim · D · Ada · COBOL · NASM / GNU assembler
# .NET 8 (C#, F#, VB.NET, PowerShell)                             Ruby (+Rails) · Lua · Perl · Raku · R · Julia · Octave (MATLAB) · Dart
# Haskell · OCaml · Elixir · Erlang · Common Lisp · Scheme (Guile) · Racket · Prolog · Tcl · AWK
# Fortran · Pascal · Verilog (iverilog) · VHDL (ghdl) · SQLite
#
# Missing something? Add a line below and rebuild. Too big for your server? Delete the blocks you don't need —
# a run whose toolchain is missing prints "'xyz' is not installed in this sandbox image" instead of failing mysteriously.
# The big downloads at the end (Zig, Scala, Groovy, PowerShell) are optional: if one of them cannot be downloaded the build
# carries on and only that language reports "not installed".
# Bump the rev label below whenever you change this file: scripts/local.js reads it and rebuilds an older local image by itself.
# 8.4 because current Laravel lock files pull Symfony 8 / brick/math 0.18, which require PHP >= 8.4.
FROM php:8.4-cli-bookworm
LABEL uip.sandbox.rev="4"

# PHP extensions Laravel projects usually need (sqlite is the default DB inside the sandbox, MariaDB is there for mysql projects)
ADD https://github.com/mlocati/docker-php-extension-installer/releases/latest/download/install-php-extensions /usr/local/bin/
RUN chmod +x /usr/local/bin/install-php-extensions \
 && install-php-extensions pdo_sqlite pdo_mysql pdo_pgsql mbstring intl gd zip bcmath exif pcntl opcache sockets xsl soap

# Everything that comes from Debian packages
RUN apt-get update && apt-get install -y --no-install-recommends \
      git unzip zip curl ca-certificates procps nano less sqlite3 libsqlite3-dev xz-utils \
      python3 python3-pip python3-venv python3-dev \
      build-essential gcc g++ make cmake gdb pkg-config \
      default-jdk-headless maven \
      ruby ruby-dev \
      lua5.4 \
      r-base-core \
      gfortran fp-compiler ghc \
      mariadb-server mariadb-client \
      libyaml-dev libffi-dev libssl-dev zlib1g-dev libreadline-dev libpq-dev default-libmysqlclient-dev libicu-dev \
 && gem install --no-document bundler rails \
 && rm -rf /var/lib/apt/lists/* \
 && ln -sf /usr/bin/lua5.4 /usr/local/bin/lua

# Node 22 (copied from the official image) + Composer
COPY --from=node:22-bookworm-slim /usr/local/bin/node /usr/local/bin/node
COPY --from=node:22-bookworm-slim /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && npm install -g --no-audit --no-fund typescript tsx pnpm yarn
COPY --from=composer:2 /usr/bin/composer /usr/local/bin/composer
COPY --from=denoland/deno:bin /deno /usr/local/bin/deno
# uv: Python virtualenv + pip install 10-50x faster than pip (the runner uses it automatically when it is there)
COPY --from=ghcr.io/astral-sh/uv:0.5 /uv /usr/local/bin/uv

# Go
COPY --from=golang:1.23-bookworm /usr/local/go /usr/local/go
# Rust (cargo + rustc); registry / build output go to the user's home at run time
COPY --from=rust:1-slim-bookworm /usr/local/cargo /usr/local/cargo
COPY --from=rust:1-slim-bookworm /usr/local/rustup /usr/local/rustup
# .NET 8 SDK (console + ASP.NET Core)
COPY --from=mcr.microsoft.com/dotnet/sdk:8.0-bookworm-slim /usr/share/dotnet /usr/share/dotnet
# Julia and Dart
COPY --from=julia:1.11-bookworm /usr/local/julia /usr/local/julia
COPY --from=dart:stable /usr/lib/dart /usr/lib/dart

# Gradle and Kotlin (downloaded; bump the versions when you like)
ARG GRADLE_VERSION=8.10.2
ARG KOTLIN_VERSION=2.0.21
RUN curl -fsSL "https://services.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip" -o /tmp/gradle.zip \
 && unzip -q /tmp/gradle.zip -d /opt && mv /opt/gradle-${GRADLE_VERSION} /opt/gradle \
 && curl -fsSL "https://github.com/JetBrains/kotlin/releases/download/v${KOTLIN_VERSION}/kotlin-compiler-${KOTLIN_VERSION}.zip" -o /tmp/kotlin.zip \
 && unzip -q /tmp/kotlin.zip -d /opt && rm -f /tmp/gradle.zip /tmp/kotlin.zip

# ── more languages ───────────────────────────────────────────────────────────────────────────────────────────────────
# Debian packages. If one name is unavailable on your mirror the others are still installed (one by one).
RUN set -e; apt-get update; \
    PKGS="nim ldc gnat gnucobol3 nasm elixir erlang-base ocaml-nox ocaml-findlib sbcl guile-3.0 racket swi-prolog-nox tcl gawk rakudo iverilog ghdl-mcode octave clojure"; \
    apt-get install -y --no-install-recommends $PKGS || { for p in $PKGS; do apt-get install -y --no-install-recommends $p || echo "⚠ skipped $p"; done; }; \
    rm -rf /var/lib/apt/lists/*

# Zig, Scala 3, Groovy, PowerShell — downloaded; each block is optional (a failed download only skips that language)
ARG ZIG_VERSION=0.13.0
ARG SCALA_VERSION=3.3.4
ARG GROOVY_VERSION=4.0.23
ARG PWSH_VERSION=7.4.6
RUN A=$(uname -m); \
    ( curl -fsSL "https://ziglang.org/download/${ZIG_VERSION}/zig-linux-${A}-${ZIG_VERSION}.tar.xz" | tar -xJ -C /opt && mv /opt/zig-linux-${A}-${ZIG_VERSION} /opt/zig ) || echo "⚠ Zig not installed"; \
    ( curl -fsSL "https://github.com/scala/scala3/releases/download/${SCALA_VERSION}/scala3-${SCALA_VERSION}.tar.gz" | tar -xz -C /opt && mv /opt/scala3-${SCALA_VERSION} /opt/scala3 ) || echo "⚠ Scala not installed"; \
    ( curl -fsSL "https://archive.apache.org/dist/groovy/${GROOVY_VERSION}/distribution/apache-groovy-binary-${GROOVY_VERSION}.zip" -o /tmp/groovy.zip && unzip -q /tmp/groovy.zip -d /opt && mv /opt/groovy-${GROOVY_VERSION} /opt/groovy ) || echo "⚠ Groovy not installed"; \
    case "$A" in x86_64) PA=x64;; aarch64) PA=arm64;; *) PA=$A;; esac; \
    ( mkdir -p /opt/pwsh && curl -fsSL "https://github.com/PowerShell/PowerShell/releases/download/v${PWSH_VERSION}/powershell-${PWSH_VERSION}-linux-${PA}.tar.gz" | tar -xz -C /opt/pwsh && chmod +x /opt/pwsh/pwsh ) || { rm -rf /opt/pwsh; echo "⚠ PowerShell not installed"; }; \
    rm -f /tmp/groovy.zip

ENV PATH="/usr/local/go/bin:/usr/local/cargo/bin:/usr/share/dotnet:/usr/local/julia/bin:/usr/lib/dart/bin:/opt/gradle/bin:/opt/kotlinc/bin:/opt/zig:/opt/scala3/bin:/opt/groovy/bin:/opt/pwsh:${PATH}" \
    RUSTUP_HOME=/usr/local/rustup \
    DOTNET_ROOT=/usr/share/dotnet DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1 DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1 \
    DOTNET_TieredPGO=0 DOTNET_TC_QuickJitForLoops=1 DOTNET_ReadyToRun=1 POWERSHELL_TELEMETRY_OPTOUT=1 \
    JAVA_TOOL_OPTIONS="-Dfile.encoding=UTF-8"

# unprivileged user — the project lives in /home/dev/project
RUN useradd -m -u 1000 -s /bin/bash dev && mkdir -p /home/dev/project && chown -R dev:dev /home/dev
ENV COMPOSER_ALLOW_SUPERUSER=0 COMPOSER_MEMORY_LIMIT=-1 npm_config_update_notifier=false PHP_CLI_SERVER_WORKERS=4
USER dev
WORKDIR /home/dev/project
CMD ["sleep", "infinity"]
