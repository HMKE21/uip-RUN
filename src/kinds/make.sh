echo "▶ C / C++ project"
need gcc
MARK="$HOME/.uip-build-mark"; touch "$MARK"; sleep 1
if [ -f CMakeLists.txt ]; then
  need cmake
  echo "▶ cmake -S . -B build && cmake --build build"
  cmake -S . -B build -DCMAKE_BUILD_TYPE=Debug && cmake --build build -j2 || exit 1
elif [ -f Makefile ] || [ -f makefile ] || [ -f GNUmakefile ]; then
  need make; echo "▶ make"; make -j2 || exit 1
else
  echo "✗ no Makefile or CMakeLists.txt found"; exit 1
fi
BIN=$(find . -type f -perm -u+x -newer "$MARK" ! -name '*.so*' ! -name '*.a' ! -name '*.sh' ! -path './.git/*' ! -path '*/CMakeFiles/*' 2>/dev/null | head -1)
if [ -n "$BIN" ]; then echo "▶ $BIN"; exec "$BIN"; fi
echo "✓ build finished — no executable was produced; run it from the shell below"
