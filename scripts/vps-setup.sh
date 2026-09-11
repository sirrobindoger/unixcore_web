#!/usr/bin/env bash
# One-time provisioning of a fresh Ubuntu 24.04 box. Run ON the server as root.
# (Already applied to 45.55.222.209 on 2026-09-11; kept so it can be redone.)
# Afterwards: put bot/.env at /srv/unixcore/bot/.env, write /etc/sftpgo/sftpgo.env
# with SFTPGO_DEFAULT_ADMIN_USERNAME/PASSWORD matching it, then run scripts/deploy.sh
# from your machine.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
SSH_PORT=${SSH_PORT:-2222}

# 512 MB droplets need swap for bun + sftpgo + caddy
if ! swapon --show | grep -q /swapfile; then
	fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
	echo '/swapfile none swap sw 0 0' >> /etc/fstab
	echo 'vm.swappiness=10' > /etc/sysctl.d/90-swap.conf && sysctl -p /etc/sysctl.d/90-swap.conf
fi

# Admin sshd moves to $SSH_PORT so SFTPGo can own 22. Ubuntu's sshd is
# socket-activated, so the port lives on ssh.socket, not in sshd_config.
# Reconnect on the new port before relying on it.
mkdir -p /etc/systemd/system/ssh.socket.d
printf '[Socket]\nListenStream=\nListenStream=0.0.0.0:%s\nListenStream=[::]:%s\n' "$SSH_PORT" "$SSH_PORT" > /etc/systemd/system/ssh.socket.d/port.conf
printf 'Port %s\n' "$SSH_PORT" > /etc/ssh/sshd_config.d/10-port.conf
systemctl daemon-reload && systemctl restart ssh.socket

apt-get update -qq
apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl gnupg rsync unzip software-properties-common
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
add-apt-repository -y ppa:sftpgo/sftpgo
apt-get update -qq && apt-get install -y -qq caddy sftpgo
systemctl stop sftpgo   # package starts it on :2022 with its own config; deploy.sh replaces that
curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash

mkdir -p /srv/unixcore/{bot,sites,suspended,trash,data}
chown -R sftpgo:sftpgo /srv/unixcore
echo "done — now copy bot/.env up, create /etc/sftpgo/sftpgo.env, and run scripts/deploy.sh"
