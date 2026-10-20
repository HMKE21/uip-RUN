E=@ENTRY@
[ -n "$E" ] || { echo "✗ no file selected to run"; exit 1; }
[ -f "$E" ] || { echo "✗ file not found: $E"; exit 1; }
O="$HOME/.uip-out"; rm -rf "$O"; mkdir -p "$O"
D=$(dirname "$E"); B=$(basename "$E"); N="${B%.*}"
case "${E,,}" in
  *.js|*.mjs|*.cjs)
    need node; echo "▶ node $E"; export NODE_OPTIONS="--require $(uip_shim)"; exec node "$E" ;;
  *.ts|*.mts|*.cts|*.tsx)
    need tsx; echo "▶ tsx $E"; export NODE_OPTIONS="--require $(uip_shim)"; exec tsx "$E" ;;
  *.py)
    if [ -f requirements.txt ]; then
      [ -d "$HOME/venv" ] || python3 -m venv "$HOME/venv"; . "$HOME/venv/bin/activate"
      echo "▶ pip install -r requirements.txt…"; pip install -q -r requirements.txt || echo "⚠ some packages failed to install"
    fi
    echo "▶ python3 $E"; exec python3 -u "$E" ;;
  *.php)
    need php; echo "▶ php $E"; exec php "$E" ;;
  *.java)
    need javac; need java
    PKG=$(sed -n 's/^[[:space:]]*package[[:space:]]\{1,\}\([A-Za-z0-9_.]\{1,\}\)[[:space:]]*;.*/\1/p' "$E" | head -1)
    CLS="$N"; [ -n "$PKG" ] && CLS="$PKG.$N"
    find . -name '*.java' -not -path './.*' -not -path './node_modules/*' > "$O/src.txt"
    CP="."; [ -d lib ] && CP="$CP:lib/*"
    echo "▶ javac ($(wc -l < "$O/src.txt") file(s)) → java $CLS"
    javac -encoding UTF-8 -d "$O/classes" -cp "$CP" @"$O/src.txt" || exit 1
    exec java -Dfile.encoding=UTF-8 -cp "$O/classes:$CP" "$CLS" ;;
  *.c)
    need gcc; SRCS=("$E")
    for h in $(grep -ho '#include[[:space:]]*"[^"]*\.h"' "$E" | sed 's/.*"\(.*\)\.h"/\1/'); do [ -f "$D/$h.c" ] && SRCS+=("$D/$h.c"); done
    echo "▶ gcc ${SRCS[*]}"
    gcc -g -O0 -Wall "${SRCS[@]}" -o "$O/a.out" -lm -pthread || exit 1
    exec "$O/a.out" ;;
  *.cpp|*.cc|*.cxx)
    need g++; SRCS=("$E")
    for h in $(grep -ho '#include[[:space:]]*"[^"]*\.\(h\|hpp\)"' "$E" | sed 's/.*"\(.*\)\.\(h\|hpp\)"/\1/'); do for x in cpp cc cxx; do [ -f "$D/$h.$x" ] && SRCS+=("$D/$h.$x"); done; done
    echo "▶ g++ -std=c++20 ${SRCS[*]}"
    g++ -std=c++20 -g -O0 -Wall "${SRCS[@]}" -o "$O/a.out" -pthread || exit 1
    exec "$O/a.out" ;;
  *.cs)
    need dotnet; export DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1 DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1
    P="$O/cs"; mkdir -p "$P/src"; cp "$E" "$P/src/"
    cat > "$P/app.csproj" <<'CSPROJ_EOF'
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>disable</Nullable>
    <EnableDefaultCompileItems>false</EnableDefaultCompileItems>
  </PropertyGroup>
  <ItemGroup><Compile Include="src/**/*.cs" /></ItemGroup>
</Project>
CSPROJ_EOF
    echo "▶ dotnet run $E"; exec dotnet run --project "$P/app.csproj" --no-launch-profile ;;
  *.go)
    need go; export GOPATH="$HOME/go" GOCACHE="$HOME/.cache/go-build"
    echo "▶ go run $E"; exec go run "$E" ;;
  *.rs)
    need rustc; echo "▶ rustc $E"
    rustc --edition 2021 "$E" -o "$O/a.out" || exit 1
    exec "$O/a.out" ;;
  *.rb)
    need ruby; echo "▶ ruby $E"; exec ruby "$E" ;;
  *.pl|*.pm)
    need perl; echo "▶ perl $E"; exec perl "$E" ;;
  *.lua)
    if command -v lua5.4 >/dev/null 2>&1; then L=lua5.4; else need lua; L=lua; fi
    echo "▶ $L $E"; exec "$L" "$E" ;;
  *.r)
    need Rscript; echo "▶ Rscript $E"; exec Rscript "$E" ;;
  *.jl)
    need julia; echo "▶ julia $E"; exec julia "$E" ;;
  *.sh|*.bash)
    echo "▶ bash $E"; exec bash "$E" ;;
  *.kt|*.kts)
    need kotlinc; need java; echo "▶ kotlinc $E (the first compile takes a while)"
    kotlinc "$E" -include-runtime -d "$O/a.jar" 2>&1 || exit 1
    exec java -jar "$O/a.jar" ;;
  *.dart)
    need dart; echo "▶ dart run $E"; exec dart run "$E" ;;
  *.hs)
    need runghc; echo "▶ runghc $E"; exec runghc "$E" ;;
  *.f90|*.f95|*.f03|*.f)
    need gfortran; echo "▶ gfortran $E"
    gfortran "$E" -o "$O/a.out" || exit 1
    exec "$O/a.out" ;;
  *.pas|*.pp)
    need fpc; echo "▶ fpc $E"
    fpc -o"$O/a.out" "$E" || exit 1
    exec "$O/a.out" ;;
  *.sql)
    need sqlite3; echo "▶ sqlite3 (database kept in $HOME/uip.db for this session)"
    sqlite3 -header -column "$HOME/uip.db" < "$E"; exit $? ;;
  *)
    echo "✗ don't know how to run '$B' — open a terminal and run it yourself"; exit 1 ;;
esac
