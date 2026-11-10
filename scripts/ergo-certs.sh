#!/usr/bin/env bash
# Give Ergo a copy of Caddy's Let's Encrypt cert for unixcore.sh, so IRC on :6697
# uses the same cert as the website. Runs as root: before Ergo starts
# (ExecStartPre in infra/ergo.service, with --no-reload) and daily from
# infra/ergo-certs.timer, which rehashes Ergo when Caddy has renewed.
set -euo pipefail
DOMAIN=${DOMAIN:-unixcore.sh}
SRC=$(ls -d /var/lib/caddy/.local/share/caddy/certificates/*/"$DOMAIN" 2>/dev/null | head -1)
DEST=/var/lib/ergo/tls
[ -n "$SRC" ] || { echo "no Caddy cert for $DOMAIN yet"; exit 1; }

install -d -o ergo -g ergo -m700 "$DEST"
if cmp -s "$SRC/$DOMAIN.crt" "$DEST/fullchain.pem" && cmp -s "$SRC/$DOMAIN.key" "$DEST/privkey.pem"; then
	exit 0
fi
install -o ergo -g ergo -m600 "$SRC/$DOMAIN.crt" "$DEST/fullchain.pem"
install -o ergo -g ergo -m600 "$SRC/$DOMAIN.key" "$DEST/privkey.pem"
echo "copied $DOMAIN cert for ergo"
if [ "${1:-}" != "--no-reload" ] && systemctl is-active --quiet ergo; then
	systemctl reload ergo
fi
