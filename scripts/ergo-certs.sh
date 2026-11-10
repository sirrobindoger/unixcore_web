#!/usr/bin/env bash
# Give Ergo copies of Caddy's Let's Encrypt certs, so IRC on :6697 uses the same
# certs as the website: unixcore.sh -> tls/{fullchain,privkey}.pem and
# irc.unixcore.sh -> tls/irc-{fullchain,privkey}.pem (Ergo picks by SNI). Until Caddy
# has an irc.unixcore.sh cert, the unixcore.sh one stands in so Ergo can start.
# Runs as root: before Ergo starts (ExecStartPre in infra/ergo.service, with
# --no-reload) and daily from infra/ergo-certs.timer, which rehashes Ergo on change.
set -euo pipefail
STORE=/var/lib/caddy/.local/share/caddy/certificates
DEST=/var/lib/ergo/tls
certdir() { ls -d "$STORE"/*/"$1" 2>/dev/null | head -1 || true; }

MAIN=$(certdir unixcore.sh)
[ -n "$MAIN" ] || { echo "no Caddy cert for unixcore.sh yet"; exit 1; }
IRC=$(certdir irc.unixcore.sh)
if [ -n "$IRC" ]; then IRC_CRT=$IRC/irc.unixcore.sh.crt IRC_KEY=$IRC/irc.unixcore.sh.key
else IRC_CRT=$MAIN/unixcore.sh.crt IRC_KEY=$MAIN/unixcore.sh.key; fi

install -d -o ergo -g ergo -m700 "$DEST"
changed=0
put() { # src dest
	cmp -s "$1" "$DEST/$2" && return 0
	install -o ergo -g ergo -m600 "$1" "$DEST/$2"
	changed=1
}
put "$MAIN/unixcore.sh.crt" fullchain.pem
put "$MAIN/unixcore.sh.key" privkey.pem
put "$IRC_CRT" irc-fullchain.pem
put "$IRC_KEY" irc-privkey.pem

[ $changed = 1 ] || exit 0
echo "updated ergo certs${IRC:+ (with irc.unixcore.sh)}"
if [ "${1:-}" != "--no-reload" ] && systemctl is-active --quiet ergo; then
	systemctl reload ergo
fi
