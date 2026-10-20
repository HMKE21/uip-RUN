echo "▶ Gradle project"
need java
if [ -f gradlew ]; then chmod +x gradlew 2>/dev/null; G="sh ./gradlew"; else need gradle; G=gradle; fi
GF=$(ls build.gradle build.gradle.kts 2>/dev/null | head -1)
if [ -n "$GF" ] && grep -q 'org.springframework.boot' "$GF"; then
  echo "▶ gradle bootRun (Spring Boot, port 8080 — first run downloads Gradle and dependencies)"
  exec $G --console=plain bootRun
fi
if [ -n "$GF" ] && grep -Eq "application|mainClass" "$GF"; then
  echo "▶ gradle installDist (first run downloads Gradle and dependencies)"
  $G -q --console=plain installDist || exit 1
  BIN=$(ls build/install/*/bin/* 2>/dev/null | grep -v '\.bat$' | head -1)
  [ -n "$BIN" ] || { echo "✗ installDist produced no start script"; exit 1; }
  echo "▶ $BIN"; exec "$BIN"
fi
echo "▶ gradle build"; exec $G --console=plain build
