need chromium; need Xvfb; need x11vnc; need websockify
export DISPLAY=:99
SCREEN=@SCREEN@
# start page: the client sends it as  u:<base64 of the URL>  (a URL has characters the entry field does not allow)
START=$(printf '%s' @ENTRY@ | sed 's/^u://' | base64 -d 2>/dev/null | head -c 2000)
case "$START" in http://*|https://*) ;; *) START="about:blank";; esac
# fixed profile folder: downloads land in the project folder, so "Save to My PC" can bring them back
UDD="$HOME/.uip-chromium"
mkdir -p "$UDD/Default" "$PWD/Downloads"
cat > "$UDD/Default/Preferences" <<UIP_CHROMIUM_PREFS
{"download":{"default_directory":"$PWD/Downloads","prompt_for_download":false,"directory_upgrade":true},"profile":{"default_content_setting_values":{"notifications":2}},"intl":{"accept_languages":"ar,en-US,en"}}
UIP_CHROMIUM_PREFS
rm -f /tmp/.X99-lock
( setsid Xvfb :99 -screen 0 "${SCREEN}x24" -nolisten tcp >"$HOME/xvfb.log" 2>&1 & )
for i in $(seq 1 60); do [ -S /tmp/.X11-unix/X99 ] && break; sleep 0.2; done
command -v openbox >/dev/null 2>&1 && ( setsid openbox >"$HOME/openbox.log" 2>&1 & )
( setsid x11vnc -display :99 -forever -shared -nopw -localhost -rfbport 5900 -noxdamage -xkb -wait 5 -defer 5 -quiet >"$HOME/x11vnc.log" 2>&1 & )
# a private copy of noVNC whose index page is the viewer itself (the proxy URL has no path)
mkdir -p "$HOME/novnc"; for f in /usr/share/novnc/*; do ln -sf "$f" "$HOME/novnc/"; done; ln -sf /usr/share/novnc/vnc.html "$HOME/novnc/index.html"
( setsid websockify --web "$HOME/novnc" 6080 127.0.0.1:5900 >"$HOME/websockify.log" 2>&1 & )
W=${SCREEN%x*}; H=${SCREEN#*x}
( setsid chromium --no-sandbox --disable-dev-shm-usage --user-data-dir="$UDD" --no-first-run --no-default-browser-check \
    --password-store=basic --disable-features=Translate,MediaRouter --disable-background-networking \
    --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist --enable-webgl \
    --force-device-scale-factor=1 --window-position=0,0 --window-size="$W,$H" --start-maximized \
    "$START" >"$HOME/chromium.log" 2>&1 & )
for i in $(seq 1 100); do
  (exec 3<>/dev/tcp/127.0.0.1/6080) 2>/dev/null && { echo "✓ Cloud browser is ready"; break; }
  sleep 0.3
done
(exec 3<>/dev/tcp/127.0.0.1/6080) 2>/dev/null || { echo "✗ The cloud browser did not start (see $HOME/websockify.log, $HOME/xvfb.log)"; tail -n 5 "$HOME/xvfb.log" 2>/dev/null; exit 1; }
echo "  Files you download in the browser are saved in $PWD/Downloads"
exit 0
