#!/usr/bin/env bash
# Runs the whole stack locally: SFTPGo (sftp :2022, admin/webclient :8080),
# Caddy (:8000) and the Discord bot. Ctrl-C stops everything.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

[ -f bot/.env ] || { echo "bot/.env missing — cp bot/.env.example bot/.env and fill it in"; exit 1; }
set -a; source bot/.env; set +a

mkdir -p data/sftpgo "${SITES_DIR:-sites}" "${SUSPENDED_DIR:-suspended}" "${TRASH_DIR:-trash}"
cp infra/sftpgo.json data/sftpgo/sftpgo.json

# SFTPGo's web UI assets live wherever the package put them.
SHARE="$(brew --prefix 2>/dev/null || true)/share/sftpgo"
[ -d "$SHARE" ] || SHARE=/usr/share/sftpgo

export SITES_DIR="$ROOT/${SITES_DIR:-sites}"
export SFTPGO_DATA_PROVIDER__USERS_BASE_DIR="$SITES_DIR"
export SFTPGO_DATA_PROVIDER__NAME="$ROOT/data/sftpgo/sftpgo.db"
export SFTPGO_DEFAULT_ADMIN_USERNAME="$SFTPGO_ADMIN_USERNAME"
export SFTPGO_DEFAULT_ADMIN_PASSWORD="$SFTPGO_ADMIN_PASSWORD"
export SFTPGO_HTTPD__TEMPLATES_PATH="$SHARE/templates"
export SFTPGO_HTTPD__STATIC_FILES_PATH="$SHARE/static"
export SFTPGO_HTTPD__OPENAPI_PATH="$SHARE/openapi"

trap 'kill 0 2>/dev/null' EXIT INT TERM

# line-buffered log prefixer (sed buffers when piped)
tag() { while IFS= read -r line; do printf '%s %s\n' "$1" "$line"; done; }

sftpgo serve --config-dir "$ROOT/data/sftpgo" --log-file-path "" --log-level info 2>&1 | tag "[sftpgo]" &
caddy run --config "$ROOT/infra/Caddyfile.local" --adapter caddyfile 2>&1 | tag "[caddy] " &
# IRC is optional locally: runs if ergo is on PATH (github.com/ergochat/ergo/releases).
# Plain on 127.0.0.1:6667, TLS on :6697 with a self-signed cert.
if command -v ergo >/dev/null; then
	mkdir -p data/ergo && cp infra/ergo.motd data/ergo/ergo.motd
	[ -f data/ergo/tls/fullchain.pem ] || (mkdir -p data/ergo/tls && cd data/ergo && ergo mkcerts --conf "$ROOT/infra/ergo.yaml" --quiet)
	(cd data/ergo && ergo run --conf "$ROOT/infra/ergo.yaml" 2>&1 | tag "[ergo]  ") &
fi
(cd bot && bun run --watch bot.ts 2>&1 | tag "[bot]   ") &

wait
