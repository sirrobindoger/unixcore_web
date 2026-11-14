#!/usr/bin/env bash
# Push the repo to the VPS and restart what changed. Safe to re-run.
# One-time provisioning (packages, swap, ssh port) lives in scripts/vps-setup.sh.
set -euo pipefail
HOST=${HOST:-unixcore}   # ssh alias; the IP stays out of this public repo
PORT=${PORT:-2222}
DEST=/srv/unixcore
cd "$(dirname "$0")/.."

rsync -az --delete -e "ssh -p $PORT" \
	--exclude .git --exclude node_modules --exclude data --exclude sites \
	--exclude suspended --exclude trash --exclude bot/.env --exclude .DS_Store --exclude .cloudflare \
	./ "$HOST:$DEST/"

ssh -p "$PORT" "$HOST" bash -s <<REMOTE
set -euo pipefail
cd $DEST
[ -f bot/.env ] || { echo "$DEST/bot/.env missing on the server — copy it up first"; exit 1; }
caddy list-modules 2>/dev/null | grep -q '^dns.providers.cloudflare\$' || { echo "caddy lacks the Cloudflare DNS plugin; see scripts/vps-setup.sh"; exit 1; }
grep -q '^CF_API_TOKEN=.' /etc/caddy/cloudflare.env 2>/dev/null || { echo "/etc/caddy/cloudflare.env (CF_API_TOKEN) missing; see infra/caddy-cloudflare.conf"; exit 1; }
install -m644 infra/Caddyfile /etc/caddy/Caddyfile
# Caddy only reads the token's env file at start, so a new drop-in means a restart.
CADDY_RESTART=0
if ! cmp -s infra/caddy-cloudflare.conf /etc/systemd/system/caddy.service.d/cloudflare.conf; then
	install -D -m644 infra/caddy-cloudflare.conf /etc/systemd/system/caddy.service.d/cloudflare.conf
	CADDY_RESTART=1
fi
# SFTP and IRC listen only on the Reserved IP (DigitalOcean delivers it to the
# droplet's private "anchor" address), never on the droplet's own public IP, which
# stays hidden behind Cloudflare. nonlocal_bind lets them start at boot before the
# address is up.
ANCHOR=\$(curl -sf -m 5 http://169.254.169.254/metadata/v1/interfaces/public/0/anchor_ipv4/address || true)
[ -n "\$ANCHOR" ] || { echo "no anchor IP in droplet metadata"; exit 1; }
echo 'net.ipv4.ip_nonlocal_bind = 1' > /etc/sysctl.d/60-unixcore-bind.conf
sysctl -q -p /etc/sysctl.d/60-unixcore-bind.conf
sed "s/@ANCHOR_IP@/\$ANCHOR/" infra/sftpgo.vps.json > /etc/sftpgo/sftpgo.json
chown root:sftpgo /etc/sftpgo/sftpgo.json; chmod 640 /etc/sftpgo/sftpgo.json
install -m644 infra/unixcore-bot.service /etc/systemd/system/unixcore-bot.service
# IRC (Ergo): binary, user, config, MOTD, units. Cert comes from Caddy via ergo-certs.sh.
bash scripts/install-ergo.sh
id ergo >/dev/null 2>&1 || useradd --system --home-dir /var/lib/ergo --shell /usr/sbin/nologin ergo
install -d -o ergo -g ergo -m750 /var/lib/ergo
install -d -m755 /etc/ergo
sed 's/^        ":6697":\$/        "'\$ANCHOR':6697":/' infra/ergo.yaml > /etc/ergo/ircd.yaml
chmod 644 /etc/ergo/ircd.yaml
grep -q "\"\$ANCHOR:6697\":" /etc/ergo/ircd.yaml || { echo "could not pin Ergo's :6697 listener to \$ANCHOR"; exit 1; }
install -m644 -o ergo -g ergo infra/ergo.motd /var/lib/ergo/ergo.motd
install -m644 infra/ergo.service infra/ergo-certs.service infra/ergo-certs.timer infra/ergo-toggle.path infra/ergo-toggle.service /etc/systemd/system/
# The bridge's oper login (flood-throttle exemption), hashed from IRC_PASSWORD. Only
# written once; a new env file needs a restart, not a rehash, to take effect.
ERGO_RESTART=0
if [ ! -f /etc/ergo/ergo.env ] && grep -q '^IRC_PASSWORD=.' bot/.env; then
	PW=\$(grep '^IRC_PASSWORD=' bot/.env | cut -d= -f2-)
	HASH=\$(printf '%s\n%s\n' "\$PW" "\$PW" | /usr/local/bin/ergo genpasswd 2>/dev/null | tail -1)
	umask 077
	printf "ERGO__OPERS='{\"bridge\": {\"class\": \"bridge\", \"password\": \"%s\"}}'\n" "\$HASH" > /etc/ergo/ergo.env
	chown root:ergo /etc/ergo/ergo.env; chmod 640 /etc/ergo/ergo.env
	ERGO_RESTART=1
fi
mkdir -p sites suspended trash data
[ -f data/irc-state ] || echo on > data/irc-state   # /toggle_irc switch (bot writes it)
chown -R sftpgo:sftpgo $DEST
chmod 750 $DEST/bot; chmod 640 bot/.env
chmod 755 scripts/*.sh
sudo -u sftpgo -H env HOME=/var/lib/sftpgo /usr/local/bin/bun install --frozen-lockfile --cwd bot >/dev/null
(set -a; . /etc/caddy/cloudflare.env; caddy validate --config /etc/caddy/Caddyfile >/dev/null)
systemctl daemon-reload
systemctl enable --now sftpgo caddy ergo ergo-certs.timer ergo-toggle.path unixcore-bot >/dev/null
systemctl restart sftpgo
if [ \$CADDY_RESTART = 1 ]; then systemctl restart caddy; else systemctl reload caddy || systemctl restart caddy; fi
# Rehash rather than restart, so a deploy doesn't kick everyone off IRC. Certs first:
# a rehash with a cert file missing is rejected and Ergo keeps the old config.
scripts/ergo-certs.sh --no-reload
if [ \$ERGO_RESTART = 1 ]; then systemctl restart ergo; else systemctl reload-or-restart ergo; fi
systemctl restart unixcore-bot
sleep 3
systemctl --no-pager --lines=0 status sftpgo caddy ergo unixcore-bot | grep -E '^(●|×|.*Active:)'
REMOTE
