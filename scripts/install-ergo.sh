#!/usr/bin/env bash
# Install (or upgrade) the pinned Ergo release to /usr/local/bin/ergo. Run ON the
# server as root; scripts/deploy.sh calls it every time and it does nothing when the
# right version is already there. Bump VERSION + SHA256 together (from the release's
# ergo-<version>-checksums.txt).
set -euo pipefail
VERSION=2.19.1
SHA256=c275f2de8e8eb074c38707136392290172400b5b78616cb9f660351527924b47
NAME=ergo-$VERSION-linux-x86_64

if [ -x /usr/local/bin/ergo ] && /usr/local/bin/ergo --version 2>/dev/null | grep -q "$VERSION"; then
	exit 0
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL -o "$tmp/$NAME.tar.gz" "https://github.com/ergochat/ergo/releases/download/v$VERSION/$NAME.tar.gz"
echo "$SHA256  $tmp/$NAME.tar.gz" | sha256sum -c --quiet
tar -xzf "$tmp/$NAME.tar.gz" -C "$tmp"
install -m755 "$tmp/$NAME/ergo" /usr/local/bin/ergo
echo "installed ergo $VERSION"
# A running server keeps the old binary until restarted.
if systemctl is-active --quiet ergo; then systemctl restart ergo; fi
