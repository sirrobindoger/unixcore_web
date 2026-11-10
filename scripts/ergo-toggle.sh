#!/usr/bin/env bash
# Apply the IRC on/off switch (/srv/unixcore/data/irc-state, written by the bot's
# /irc command). Run as root by ergo-toggle.service when the file changes.
set -euo pipefail
STATE=$(tr -d '[:space:]' < /srv/unixcore/data/irc-state 2>/dev/null || echo on)
if [ "$STATE" = off ]; then
	systemctl stop ergo
	echo "irc switched off"
else
	systemctl start ergo
	echo "irc switched on"
fi
