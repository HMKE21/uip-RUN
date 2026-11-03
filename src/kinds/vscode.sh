need code-server
CS_PORT=13337
# settings + installed extensions live in the per-user cache volume when there is one, so they survive between sessions
CSDIR="${UIP_PCACHE:+$UIP_PCACHE/vscode}"; CSDIR="${CSDIR:-$HOME/.uip-vscode}"
mkdir -p "$CSDIR/data/User" "$CSDIR/extensions"
if [ ! -f "$CSDIR/data/User/settings.json" ]; then
  cat > "$CSDIR/data/User/settings.json" <<'UIP_VSCODE_SETTINGS'
{
  "workbench.colorTheme": "Default Dark Modern",
  "workbench.startupEditor": "none",
  "telemetry.telemetryLevel": "off",
  "update.mode": "none",
  "extensions.autoUpdate": false,
  "security.workspace.trust.enabled": false,
  "files.autoSave": "afterDelay",
  "files.autoSaveDelay": 800,
  "editor.fontSize": 14,
  "editor.minimap.enabled": false,
  "editor.formatOnSave": false,
  "terminal.integrated.defaultProfile.linux": "bash",
  "git.openRepositoryInParentFolders": "never"
}
UIP_VSCODE_SETTINGS
fi
echo "▶ Starting VS Code (code-server) on port $CS_PORT…"
( setsid nohup code-server --bind-addr "0.0.0.0:$CS_PORT" --auth none --disable-telemetry --disable-update-check --disable-workspace-trust \
    --user-data-dir "$CSDIR/data" --extensions-dir "$CSDIR/extensions" --app-name "UIPE Code" "$PWD" >"$HOME/code-server.log" 2>&1 & )
for i in $(seq 1 120); do
  (exec 3<>"/dev/tcp/127.0.0.1/$CS_PORT") 2>/dev/null && { echo "✓ VS Code is ready"; break; }
  sleep 0.5
done
(exec 3<>"/dev/tcp/127.0.0.1/$CS_PORT") 2>/dev/null || { echo "✗ VS Code did not start (see $HOME/code-server.log)"; tail -n 20 "$HOME/code-server.log" 2>/dev/null; exit 1; }
echo "  Your project folder: $PWD"
echo "  Dev servers you start from VS Code (ports 3000, 5173, 8000, 8080…) are reachable from the Ports menu of the app."
exit 0
