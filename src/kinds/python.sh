ENTRY=@ENTRY@
[ -n "$ENTRY" ] || ENTRY=main.py
echo "▶ Python project"
if [ -f requirements.txt ]; then
  [ -d "$HOME/venv" ] || python3 -m venv "$HOME/venv"
  . "$HOME/venv/bin/activate"
  echo "▶ pip install -r requirements.txt…"; pip install -q -r requirements.txt || echo "⚠ some packages failed to install"
fi
if [ "$ENTRY" = manage.py ]; then
  echo "▶ Django dev server on port 8000"; python3 manage.py migrate --noinput 2>/dev/null; exec python3 manage.py runserver 0.0.0.0:8000
fi
MOD="${ENTRY%.py}"; MOD="${MOD//\//.}"
if [ -f "$ENTRY" ] && grep -Eq '(^|[^A-Za-z_])FastAPI\(' "$ENTRY" && ! grep -q 'uvicorn.run' "$ENTRY"; then
  APPVAR=$(grep -Eo '^[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=[[:space:]]*FastAPI\(' "$ENTRY" | head -1 | sed 's/[[:space:]]*=.*//'); [ -n "$APPVAR" ] || APPVAR=app
  [ -d "$HOME/venv" ] || python3 -m venv "$HOME/venv"; . "$HOME/venv/bin/activate"
  python3 -c 'import uvicorn, fastapi' 2>/dev/null || { echo "▶ pip install fastapi uvicorn…"; pip install -q fastapi uvicorn; }
  echo "▶ uvicorn $MOD:$APPVAR on port 8000"; exec python3 -m uvicorn "$MOD:$APPVAR" --host 0.0.0.0 --port 8000
fi
if [ -f "$ENTRY" ] && grep -Eq '(^|[^A-Za-z_])Flask\(' "$ENTRY" && ! grep -Eq '\.run\(' "$ENTRY"; then
  [ -d "$HOME/venv" ] || python3 -m venv "$HOME/venv"; . "$HOME/venv/bin/activate"
  python3 -c 'import flask' 2>/dev/null || { echo "▶ pip install flask…"; pip install -q flask; }
  echo "▶ flask run on port 5000"; exec python3 -m flask --app "$MOD" run --host 0.0.0.0 --port 5000
fi
exec python3 -u "$ENTRY"
