#!/usr/bin/env bash
# Push the repo to the VPS and restart what changed. Safe to re-run.
# One-time provisioning (packages, swap, ssh port) lives in scripts/vps-setup.sh.
set -euo pipefail
HOST=${HOST:-root@45.55.222.209}
PORT=${PORT:-2222}
DEST=/srv/unixcore
cd "$(dirname "$0")/.."

rsync -az --delete -e "ssh -p $PORT" \
	--exclude .git --exclude node_modules --exclude data --exclude sites \
	--exclude suspended --exclude trash --exclude bot/.env --exclude .DS_Store \
	./ "$HOST:$DEST/"

ssh -p "$PORT" "$HOST" bash -s <<REMOTE
set -euo pipefail
cd $DEST
[ -f bot/.env ] || { echo "$DEST/bot/.env missing on the server — copy it up first"; exit 1; }
install -m644 infra/Caddyfile /etc/caddy/Caddyfile
install -m640 -o root -g sftpgo infra/sftpgo.vps.json /etc/sftpgo/sftpgo.json
install -m644 infra/unixcore-bot.service /etc/systemd/system/unixcore-bot.service
mkdir -p sites suspended trash data
chown -R sftpgo:sftpgo $DEST
chmod 750 $DEST/bot; chmod 640 bot/.env
sudo -u sftpgo -H env HOME=/var/lib/sftpgo /usr/local/bin/bun install --frozen-lockfile --cwd bot >/dev/null
caddy validate --config /etc/caddy/Caddyfile >/dev/null
systemctl daemon-reload
systemctl enable --now sftpgo caddy unixcore-bot >/dev/null
systemctl restart sftpgo
systemctl reload caddy || systemctl restart caddy
systemctl restart unixcore-bot
sleep 3
systemctl --no-pager --lines=0 status sftpgo caddy unixcore-bot | grep -E '^(●|×|.*Active:)'
REMOTE
