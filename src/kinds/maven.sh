echo "▶ Maven project"
need mvn; need java
export MAVEN_OPTS="${MAVEN_OPTS:+$MAVEN_OPTS }-Xmx512m -XX:TieredStopAtLevel=1 -XX:+UseSerialGC -Xshare:auto"
if grep -Eq 'spring-boot-maven-plugin|spring-boot-starter-parent' pom.xml; then
  echo "▶ mvn spring-boot:run (Spring Boot, port 8080 — first run downloads dependencies)"
  exec mvn -B -ntp spring-boot:run
fi
echo "▶ mvn compile (first run downloads dependencies)"
mvn -B -ntp -q compile || exit 1
MAINF=$(grep -rl 'static void main' src/main/java 2>/dev/null | head -1)
if [ -z "$MAINF" ]; then echo "✗ no class with main() found under src/main/java"; exit 1; fi
CLS=$(echo "${MAINF#src/main/java/}" | sed 's/\.java$//; s#/#.#g')
mvn -B -ntp -q dependency:build-classpath -Dmdep.outputFile="$HOME/.cp.txt" >/dev/null 2>&1 || : > "$HOME/.cp.txt"
echo "▶ java $CLS"
exec java -Dfile.encoding=UTF-8 -cp "target/classes:$(cat "$HOME/.cp.txt")" "$CLS"
