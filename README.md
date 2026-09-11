# unixcore.sh

Every member of the Discord gets a static site at `unixcore.sh/<name>/`, managed
entirely from a Discord menu and uploaded over SFTP (or a browser file manager).

```
bot/     Bun + discord.js 14 — the menu, mod commands, SFTPGo API client
infra/   SFTPGo config + Caddyfile
scripts/ dev.sh runs the whole stack locally
sites/   one directory per site (served by Caddy, jailed per user by SFTPGo)
```

How the pieces fit:

- **SFTPGo** owns logins and quotas. Users are *virtual* — no Linux accounts —
  each jailed to `sites/<slug>` with a 100 MB byte quota. Its web client doubles
  as a drag-and-drop uploader.
- **Caddy** serves `sites/` as static files. Nothing user-uploaded is ever executed.
- **The bot** maps Discord user ID → slug in SQLite and drives SFTPGo's REST
  API. Suspending a site moves its folder to `suspended/` and disables the
  login; deleting moves it to `trash/`.

## Local demo

```bash
brew install sftpgo caddy
cp bot/.env.example bot/.env   # fill in TOKEN + GUILD_ID, set SFTPGO_ADMIN_PASSWORD
./scripts/dev.sh
```

Then in Discord: `/site menu` in the channel where the menu should live.

- Sites: http://localhost:8000/<slug>/ (hub at http://localhost:8000/)
- SFTP: `localhost:2022`, username = slug
- Web file manager: http://localhost:8080/web/client
- SFTPGo admin: http://localhost:8080/web/admin

## Mod commands (`Manage Server`)

`/site menu` · `/site info @user` · `/site list` · `/site suspend @user <reason>` ·
`/site unsuspend @user` · `/site delete @user` · `/site reserve add|remove|list`

Baseline reserved names live in `bot/reserved.txt`.

## Hub page

`bot/templates/hub.html` is the front page at `/`. Static bits live in
`bot/templates/hub/` and get copied to `sites/_hub/` on every regenerate.
Drop PNGs/GIFs into `bot/templates/hub/bg/` and they're scattered behind the
panel (up to 8 fixed spots, then it wraps). 88x31 buttons dropped into
`bot/templates/hub/buttons/` line up under the badge. No restart needed beyond the next
regenerate (any register/rename/suspend, or bot startup).

## VPS

DigitalOcean droplet `45.55.222.209`, Ubuntu 24.04. ssh alias `unixcore`
(root, port **2222** — SFTPGo owns port 22).

- `scripts/vps-setup.sh` — one-time provisioning (swap, sshd → 2222, Caddy,
  SFTPGo, Bun). Already applied.
- `scripts/deploy.sh` — rsync the repo to `/srv/unixcore`, install the configs
  from `infra/`, restart services. Run after every change.
- Secrets live only on the server: `/srv/unixcore/bot/.env` and
  `/etc/sftpgo/sftpgo.env` (same SFTPGo admin password in both).

On the box: repo at `/srv/unixcore` (owned by `sftpgo`, the bot runs as that
user), SFTPGo DB at `/var/lib/sftpgo/sftpgo.db`, units `sftpgo`, `caddy`,
`unixcore-bot`. Logs: `journalctl -u unixcore-bot -f`.

Caddy serves `sites/` on 80/443 with Let's Encrypt and proxies only the SFTPGo
web client (`/web/client`, `/api/v2/user`, `/static`). The admin UI is not
exposed: `ssh -L 8080:127.0.0.1:8080 unixcore` then http://localhost:8080/web/admin.

**DNS:** the A record must be DNS-only (grey cloud) in Cloudflare — SFTP on 22
can't go through the proxy and Let's Encrypt's HTTP challenge needs port 80 to
reach the box directly.

**Changing the domain** (beta.unixcore.sh → unixcore.sh): edit the hostname
block at the bottom of `infra/Caddyfile` (`unixcore.sh, beta.unixcore.sh {`),
update `PUBLIC_URL`, `SFTP_HOST`, `WEBCLIENT_URL` in the server's `bot/.env`,
run `scripts/deploy.sh`.
