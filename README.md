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
  each jailed to `sites/<slug>` with a 25 MB byte quota. Its web client doubles
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

## VPS

Same three processes on Ubuntu: SFTPGo from its apt repo listening on :22
(move admin `sshd` to another port), Caddy with the site block under
`unixcore.sh {`, the bot as a systemd unit running as the `sftpgo` user so it
can write `sites/`. `PUBLIC_URL`, `SFTP_HOST`, `SFTP_PORT`, `WEBCLIENT_URL` in
`.env` are the only bot-side changes.
