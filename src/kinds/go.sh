echo "▶ Go project"
need go
export GOPATH="$HOME/go" GOCACHE="$HOME/.cache/go-build" GOFLAGS=-mod=mod HOST=0.0.0.0 PORT=8080
T=.
if ! grep -lq '^package main' ./*.go 2>/dev/null && [ -d cmd ]; then T="./cmd/$(ls cmd | head -1)"; fi
echo "▶ go run $T (first run downloads modules)"
exec go run "$T"
