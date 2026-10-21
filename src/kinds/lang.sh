E=@ENTRY@
[ -n "$E" ] || { echo "✗ no file selected to run"; exit 1; }
[ -f "$E" ] || { echo "✗ file not found: $E"; exit 1; }
O="$HOME/.uip-out"; rm -rf "$O"; mkdir -p "$O"
D=$(dirname "$E"); B=$(basename "$E"); N="${B%.*}"

# Speed: compiled languages go through cbuild (an identical build is taken from the cache instead of being compiled again),
# the JVM is started with flags that favour short programs, and every compiler writes its temporary files to $O (never into the project).
JF="-XX:+UseSerialGC -Xshare:auto"                                   # JVM flags for the student's program
JC="-J-XX:TieredStopAtLevel=1 -J-XX:+UseSerialGC -J-Xshare:auto"      # same for javac (a short-lived compiler)
export JAVA_OPTS="-XX:TieredStopAtLevel=1 -XX:+UseSerialGC -Xshare:auto"   # kotlinc / groovy / scala launchers
export DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1 DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1 DART_SUPPRESS_ANALYTICS=true RUST_BACKTRACE=1

# a .NET project is built once (cached by cbuild) and then started with `dotnet app.dll`  — C#, F#, VB.NET
dotnet_file() { # <cs|fs|vb>
  need dotnet
  local X="$1" P="$O/dn" EX=""
  mkdir -p "$P/src"; cp "$E" "$P/src/"
  [ "$X" = cs ] && EX='<ImplicitUsings>enable</ImplicitUsings><Nullable>disable</Nullable>'
  [ "$X" = vb ] && EX='<OptionStrict>Off</OptionStrict><OptionInfer>On</OptionInfer>'
  cat > "$P/app.${X}proj" <<DOTNET_PROJ_EOF
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0</TargetFramework>
    <AssemblyName>app</AssemblyName>
    $EX
    <EnableDefaultCompileItems>false</EnableDefaultCompileItems>
    <NuGetAudit>false</NuGetAudit>
    <UseAppHost>false</UseAppHost>
    <TieredPGO>false</TieredPGO>
    <SatelliteResourceLanguages>en</SatelliteResourceLanguages>
    <GenerateDocumentationFile>false</GenerateDocumentationFile>
  </PropertyGroup>
  <ItemGroup><Compile Include="src/**/*.$X" /></ItemGroup>
</Project>
DOTNET_PROJ_EOF
  echo "▶ dotnet build $E"
  cbuild "dn$X:$E" "$P/out" dotnet build "$P/app.${X}proj" -c Release -o "$P/out" --nologo -v q -clp:NoSummary -p:UseSharedCompilation=true || exit 1
  export DOTNET_TieredPGO=0 DOTNET_TC_QuickJitForLoops=1 DOTNET_ReadyToRun=1
  exec dotnet "$P/out/app.dll"
}

# first class (in a folder of .class files) that has public static void main(String[])
java_main() { # <classes-dir> <classpath>
  local c
  for c in $(cd "$1" && find . -name '*.class' ! -name '*$*' | sed 's#^\./##; s#\.class$##; s#/#.#g'); do
    javap -cp "$2" "$c" 2>/dev/null | grep -q 'void main(java.lang.String\[\])' && { echo "$c"; return 0; }
  done
  return 1
}

# .pl is Perl or Prolog: Perl marks ($var, use strict, my …) win, otherwise ":-" or facts like  parent(tom, bob).  mean Prolog
is_prolog() {
  grep -qE 'use[[:space:]]+(strict|warnings)|^[[:space:]]*my[[:space:]]|\$[A-Za-z_]|^#!.*perl' "$1" && return 1
  grep -qE ':-|^[a-z][A-Za-z0-9_]*(\(.*\))?[[:space:]]*\.[[:space:]]*$' "$1"
}

case "${E,,}" in
  # ───────────── scripting ─────────────
  *.js|*.mjs|*.cjs)
    need node; echo "▶ node $E"; export NODE_OPTIONS="--require $(uip_shim)"; exec node "$E" ;;
  *.ts|*.mts|*.cts|*.tsx)
    need tsx; echo "▶ tsx $E"; export NODE_OPTIONS="--require $(uip_shim)"; exec tsx "$E" ;;
  *.py)
    uip_pyenv
    echo "▶ python3 $E"; exec python3 -u "$E" ;;
  *.php)
    need php; echo "▶ php $E"; exec php "$E" ;;
  *.rb)
    need ruby; echo "▶ ruby $E"; exec ruby "$E" ;;
  *.pm)
    need perl; echo "▶ perl $E"; exec perl "$E" ;;
  *.pl)
    if is_prolog "$E"; then
      need swipl; echo "▶ swipl $E   (Prolog — type queries at the ?- prompt, halt. to leave)"; exec swipl -q "$E"
    fi
    need perl; echo "▶ perl $E"; exec perl "$E" ;;
  *.lua)
    if command -v lua5.4 >/dev/null 2>&1; then L=lua5.4; else need lua; L=lua; fi
    echo "▶ $L $E"; exec "$L" "$E" ;;
  *.r)
    need Rscript; echo "▶ Rscript $E"; exec Rscript --vanilla "$E" ;;
  *.jl)
    need julia; echo "▶ julia $E"; exec julia --startup-file=no "$E" ;;
  *.sh|*.bash)
    echo "▶ bash $E"; exec bash "$E" ;;
  *.ps1)
    need pwsh; echo "▶ pwsh $E"; exec pwsh -NoLogo -NoProfile -File "$E" ;;
  *.tcl)
    need tclsh; echo "▶ tclsh $E"; exec tclsh "$E" ;;
  *.awk)
    need gawk; echo "▶ gawk -f $E   (reads standard input — Ctrl+D ends it)"; exec gawk -f "$E" ;;
  *.raku|*.rakumod|*.p6)
    need raku; echo "▶ raku $E"; exec raku "$E" ;;
  *.m)
    need octave-cli; echo "▶ octave $E   (MATLAB / Octave)"; exec octave-cli --quiet "$E" ;;
  *.sql)
    # engine: from the file name (a.mysql.sql, a.pg.sql, a.sqlite.sql) or a first-lines comment  "-- engine: mysql | postgres | sqlite"; default SQLite
    ENG=sqlite; LB="${E,,}"
    case "$LB" in
      *.mysql.sql|*.mariadb.sql) ENG=mysql ;;
      *.pg.sql|*.pgsql.sql|*.psql.sql|*.postgres.sql|*.postgresql.sql) ENG=postgres ;;
      *.sqlite.sql) ENG=sqlite ;;
      *) H=$(head -n 5 "$E" | tr 'A-Z' 'a-z' | sed -n 's/^[[:space:]]*--[[:space:]]*\(engine\|db\|database\|dialect\)[[:space:]]*[:=][[:space:]]*\([a-z]*\).*/\2/p' | head -1)
         case "$H" in mysql|mariadb) ENG=mysql ;; postgres|postgresql|pgsql|pg|psql) ENG=postgres ;; esac ;;
    esac
    if [ "$ENG" = sqlite ] && grep -qiE '^[[:space:]]*GO[[:space:]]*$|DECLARE[[:space:]]+@|SELECT[[:space:]]+TOP[[:space:]]+[0-9(]|N?VARCHAR\(MAX\)|IDENTITY[[:space:]]*\([0-9]' "$E"; then
      echo "⚠ this looks like T-SQL (Microsoft SQL Server). The sandbox runs SQL on SQLite, MariaDB (MySQL) or PostgreSQL — T-SQL-only syntax will fail."
    fi
    case "$ENG" in
      mysql)
        need mariadb; start_mysql || exit 1
        echo "▶ MariaDB/MySQL: $B   (open a client afterwards with:  mariadb --no-defaults -uroot --socket=\$HOME/mysql.sock app)"
        mariadb --no-defaults -uroot --socket="$HOME/mysql.sock" --default-character-set=utf8mb4 --table app < "$E"; exit $? ;;
      postgres)
        need psql; start_pg || exit 1
        echo "▶ PostgreSQL: $B   (open a client afterwards with:  psql -h 127.0.0.1 -U postgres app)"
        psql -h 127.0.0.1 -U postgres -d app -v ON_ERROR_STOP=1 -f "$E"; exit $? ;;
      *)
        need sqlite3; echo "▶ SQLite: $B   (database kept in $HOME/uip.db for this session — use  -- engine: mysql  or  -- engine: postgres  on the first line, or name the file x.mysql.sql / x.pg.sql, for the other engines)"
        sqlite3 -header -column "$HOME/uip.db" < "$E"; exit $? ;;
    esac ;;

  # ───────────── JVM ─────────────
  *.java)
    need javac; need java
    PKG=$(sed -n 's/^[[:space:]]*package[[:space:]]\{1,\}\([A-Za-z0-9_.]\{1,\}\)[[:space:]]*;.*/\1/p' "$E" | head -1)
    CLS="$N"; [ -n "$PKG" ] && CLS="$PKG.$N"
    find . -name '*.java' -not -path './.*' -not -path './node_modules/*' > "$O/src.txt"
    CP="."; [ -d lib ] && CP="$CP:lib/*"
    echo "▶ javac ($(wc -l < "$O/src.txt") file(s)) → java $CLS"
    cbuild "java:$E" "$O/classes" javac $JC -encoding UTF-8 -d "$O/classes" -cp "$CP" @"$O/src.txt" || exit 1
    exec java $JF -Dfile.encoding=UTF-8 -cp "$O/classes:$CP" "$CLS" ;;
  *.kt|*.kts)
    need kotlinc; need java; echo "▶ kotlinc $E (the first compile of new code takes a while)"
    cbuild "kt:$E" "$O/a.jar" kotlinc "$E" -include-runtime -d "$O/a.jar" || exit 1
    exec java $JF -jar "$O/a.jar" ;;
  *.scala)
    need scalac; need scala; need java; echo "▶ scalac $E"
    cbuild "scala:$E" "$O/classes" scalac -d "$O/classes" "$E" || exit 1
    CLS=$(java_main "$O/classes" "$O/classes") || { echo "✗ no main method found (use  @main def run() = …  or  object Main extends App)"; exit 1; }
    echo "▶ scala $CLS"; exec scala -classpath "$O/classes" "$CLS" ;;
  *.groovy|*.gvy)
    need groovy; echo "▶ groovy $E"; exec groovy "$E" ;;
  *.clj|*.cljc)
    need clojure; echo "▶ clojure $E"; exec clojure "$E" ;;

  # ───────────── .NET ─────────────
  *.cs)  dotnet_file cs ;;
  *.fs)  dotnet_file fs ;;
  *.vb)  dotnet_file vb ;;
  *.fsx)
    need dotnet; echo "▶ dotnet fsi $E"; exec dotnet fsi "$E" ;;

  # ───────────── native compilers ─────────────
  *.c)
    need gcc; SRCS=("$E")
    for h in $(grep -ho '#include[[:space:]]*"[^"]*\.h"' "$E" | sed 's/.*"\(.*\)\.h"/\1/'); do [ -f "$D/$h.c" ] && SRCS+=("$D/$h.c"); done
    echo "▶ gcc ${SRCS[*]}"
    cbuild "c:$E" "$O/a.out" gcc -pipe -O1 -g -Wall "${SRCS[@]}" -o "$O/a.out" -lm -pthread || exit 1
    exec "$O/a.out" ;;
  *.cpp|*.cc|*.cxx)
    need g++; SRCS=("$E")
    for h in $(grep -ho '#include[[:space:]]*"[^"]*\.\(h\|hpp\)"' "$E" | sed 's/.*"\(.*\)\.\(h\|hpp\)"/\1/'); do for x in cpp cc cxx; do [ -f "$D/$h.$x" ] && SRCS+=("$D/$h.$x"); done; done
    echo "▶ g++ -std=c++20 ${SRCS[*]}"
    cbuild "cpp:$E" "$O/a.out" g++ -std=c++20 -pipe -O1 -g -Wall "${SRCS[@]}" -o "$O/a.out" -pthread || exit 1
    exec "$O/a.out" ;;
  *.go)
    need go; export GOPATH="${UIP_PCACHE:-$HOME}/go" GOCACHE="${UIP_PCACHE:-$HOME/.cache}/go-build"
    if [ -f go.mod ]; then export GOFLAGS=-mod=mod; else export CGO_ENABLED=0; fi   # no cgo = no C compiler involved = much faster first build
    echo "▶ go build $E"
    cbuild "go:$E" "$O/a.out" go build -o "$O/a.out" "$E" || exit 1
    exec "$O/a.out" ;;
  *.rs)
    need rustc; echo "▶ rustc $E"
    cbuild "rs:$E" "$O/a.out" rustc --edition 2021 -C opt-level=1 -C debug-assertions=on -C overflow-checks=on -C codegen-units=16 "$E" -o "$O/a.out" || exit 1
    exec "$O/a.out" ;;
  *.zig)
    need zig; echo "▶ zig build-exe $E"
    cbuild "zig:$E" "$O/a.out" zig build-exe "$E" -O ReleaseSafe -femit-bin="$O/a.out" --cache-dir "$O/zc" --global-cache-dir "$HOME/.cache/zig" || exit 1
    exec "$O/a.out" ;;
  *.nim)
    need nim; echo "▶ nim c $E"
    cbuild "nim:$E" "$O/a.out" nim c --hints:off --warnings:off -d:release --checks:on --nimcache:"$O/nc" --out:"$O/a.out" "$E" || exit 1
    exec "$O/a.out" ;;
  *.d)
    need ldc2; echo "▶ ldc2 $E"
    cbuild "d:$E" "$O/a.out" ldc2 -O1 -I"$D" -od="$O" -of="$O/a.out" "$E" || exit 1
    exec "$O/a.out" ;;
  *.adb)
    need gnatmake; echo "▶ gnatmake $E"; mkdir -p "$O/obj"
    cbuild "ada:$E" "$O/a.out" gnatmake -q -D "$O/obj" -aI"$D" -o "$O/a.out" "$E" || exit 1
    exec "$O/a.out" ;;
  *.cob|*.cbl|*.cobol)
    need cobc; echo "▶ cobc $E"
    FREE=""; grep -qiE '^[[:space:]]{0,3}(IDENTIFICATION|ID)[[:space:]]+DIVISION' "$E" && FREE="-free"
    cbuild "cob:$E" "$O/a.out" cobc -x $FREE -I "$D" -o "$O/a.out" "$E" || exit 1
    exec "$O/a.out" ;;
  *.f90|*.f95|*.f03|*.f)
    need gfortran; echo "▶ gfortran $E"
    cbuild "f:$E" "$O/a.out" gfortran -pipe -O1 "$E" -o "$O/a.out" || exit 1
    exec "$O/a.out" ;;
  *.pas|*.pp)
    need fpc; echo "▶ fpc $E"
    cbuild "pas:$E" "$O/a.out" fpc -v0 -O1 -FU"$O" -o"$O/a.out" "$E" || exit 1
    exec "$O/a.out" ;;
  *.asm|*.nasm)
    need nasm; need ld; echo "▶ nasm -f elf64 $E"
    nasm -f elf64 -g -F dwarf "$E" -o "$O/a.o" || exit 1
    if grep -qiE '^[[:space:]]*global[[:space:]]+main\b|^[[:space:]]*extern[[:space:]]' "$E"; then need gcc; gcc -no-pie "$O/a.o" -o "$O/a.out" -lm || exit 1; else ld "$O/a.o" -o "$O/a.out" || exit 1; fi
    exec "$O/a.out" ;;
  *.s)
    need gcc; echo "▶ gcc $E (GNU assembler)"
    if grep -qE '^[[:space:]]*\.globa?l[[:space:]]+_start' "$E"; then gcc -nostdlib -static "$E" -o "$O/a.out" || exit 1; else gcc -no-pie "$E" -o "$O/a.out" -lm || exit 1; fi
    exec "$O/a.out" ;;

  # ───────────── functional / logic ─────────────
  *.hs)
    need runghc; echo "▶ runghc $E"; exec runghc "$E" ;;
  *.ml)
    need ocamlopt; echo "▶ ocamlopt $E"; cp "$E" "$O/$B"
    if command -v ocamlfind >/dev/null 2>&1; then OC=(ocamlfind ocamlopt -package str,unix -linkpkg); else OC=(ocamlopt); fi
    cbuild "ml:$E" "$O/a.out" "${OC[@]}" "$O/$B" -o "$O/a.out" || exit 1
    exec "$O/a.out" ;;
  *.ex|*.exs)
    need elixir; echo "▶ elixir $E"; exec elixir "$E" ;;
  *.erl)
    need erl
    if grep -q '^-module(' "$E"; then
      need erlc; MOD=$(sed -n 's/^-module(\([A-Za-z0-9_]*\)).*/\1/p' "$E" | head -1)
      echo "▶ erlc $E"; erlc -o "$O" "$E" || exit 1
      FN=""; for f in main start run; do grep -Eq "^$f\(\)" "$E" && { FN=$f; break; }; done
      [ -n "$FN" ] || { echo "✗ define and export main/0 (or start/0 / run/0) in module $MOD — or write the file as an escript"; exit 1; }
      echo "▶ $MOD:$FN()"; exec erl -noshell -pa "$O" -eval "$MOD:$FN(), halt()."
    fi
    need escript; echo "▶ escript $E"; exec escript "$E" ;;
  *.lisp|*.lsp)
    need sbcl; echo "▶ sbcl --script $E"; exec sbcl --script "$E" ;;
  *.scm|*.ss)
    need guile; echo "▶ guile $E"; exec guile --no-auto-compile -s "$E" ;;
  *.rkt)
    need racket; echo "▶ racket $E"; exec racket "$E" ;;
  *.pro|*.prolog)
    need swipl; echo "▶ swipl $E   (Prolog — type queries at the ?- prompt, halt. to leave)"; exec swipl -q "$E" ;;
  *.dart)
    need dart; echo "▶ dart run $E"; exec dart run "$E" ;;

  # ───────────── hardware description ─────────────
  *.v|*.sv)
    need iverilog; need vvp; echo "▶ iverilog $E"
    if ! iverilog -g2012 -I "$D" -o "$O/a.vvp" "$E" 2> "$O/iv.err"; then
      if grep -q 'Unknown module type' "$O/iv.err"; then   # the design lives in other files of the same folder
        ALL=("$E"); for f in "$D"/*.v "$D"/*.sv; do [ -f "$f" ] && [ "$f" != "$D/$B" ] && ALL+=("$f"); done
        echo "▶ iverilog (${#ALL[@]} files)"
        iverilog -g2012 -I "$D" -o "$O/a.vvp" "${ALL[@]}" || exit 1
      else cat "$O/iv.err"; exit 1; fi
    else cat "$O/iv.err"; fi
    exec vvp "$O/a.vvp" ;;
  *.vhd|*.vhdl)
    need ghdl; echo "▶ ghdl $E"; mkdir -p "$O/work"
    TOP=$(grep -oiE '^[[:space:]]*entity[[:space:]]+[A-Za-z0-9_]+[[:space:]]+is' "$E" | awk '{print $2}' | grep -iE 'tb|test|bench' | tail -1)
    [ -n "$TOP" ] || TOP=$(grep -oiE '^[[:space:]]*entity[[:space:]]+[A-Za-z0-9_]+[[:space:]]+is' "$E" | awk '{print $2}' | tail -1)
    [ -n "$TOP" ] || { echo "✗ no entity found in $B"; exit 1; }
    ghdl -i --std=08 --workdir="$O/work" "$D"/*.vhd "$D"/*.vhdl 2>/dev/null; ghdl -i --std=08 --workdir="$O/work" "$E" || exit 1
    echo "▶ top-level entity: $TOP"
    ghdl -m --std=08 --workdir="$O/work" "$TOP" || exit 1
    exec ghdl -r --std=08 --workdir="$O/work" "$TOP" ;;
  *)
    echo "✗ don't know how to run '$B' — open a terminal and run it yourself"; exit 1 ;;
esac
