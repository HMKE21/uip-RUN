echo "▶ Rust (Cargo) project"
need cargo
export CARGO_HOME="$HOME/.cargo" CARGO_TARGET_DIR="$HOME/target" HOST=0.0.0.0 PORT=8080
echo "▶ cargo run (first run downloads and compiles crates — be patient)"
exec cargo run
