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
  as a drag-and-drop uploader. Besides the password, users can add up to 5 SSH
  public keys from the menu (🗝️ SSH keys) to log in without one.
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

`/site menu` · `/site directory` · `/site info @user` · `/site list` · `/site suspend @user <reason>` ·
`/site unsuspend @user` · `/site delete @user` · `/site reserve add|remove|list`

Baseline reserved names live in `bot/reserved.txt`.

## Hub page

`bot/templates/hub.html` is the front page at `/`. Static bits live in
`bot/templates/hub/` and get copied to `sites/_hub/` on every regenerate.
The site list puts sites that have replaced the starter page first (bold) and
untouched ones after (grey). The logo uses the badge's type (bold Verdana) and sits
in a box tiled with `hub/velvet.png`, with `hub/asya.png` beside it. The Discord button's online count is fetched
in the browser from Discord's public invite endpoint (no bot involved). 88x31 buttons dropped into
`bot/templates/hub/buttons/` line up next to the badge in the footer. No restart
needed beyond the next regenerate (any register/rename/suspend, or bot startup).

`bot/templates/hub/terms.html` is the rules page. Caddy rewrites `/terms` to it, and
the hub links to it from the footer.

`bot/templates/hub/404.html` is the not-found page. Caddy's `handle_errors` serves it
(with a 404 status) for any missing path, unless the site has its own `404.html` in
its folder, which wins for paths under that site.

## Directory

`/site directory` posts the phone book into the current channel (or set
`DIRECTORY_CHANNEL` and it posts itself on startup). The shared message shows
the site count and a site of the day, picked at midnight UTC from sites that
aren't still the starter page, skipping anyone featured in the last 14 days.
**Browse** opens a private pager for whoever clicked, 10 sites per page with
prev/next and a go-to-page menu, so people never fight over it. **Random** shows
one site up close (with join date, and its 88x31 if it has one).

Each entry shows the owner's tagline (the **Directory tagline** button in the site
menu) or else the page `<title>`, plus size and last update. A
`88x31.png`/`.gif` (or `button.png`/`.gif`) in the site root shows up as its picture.
Code: `bot/menus/directory.ts`; the pick is stored per day in the `featured` table.

## Guestbook

`/guestbook` is the one dynamic page. `bot/guestbook.ts` runs a small HTTP
server inside the bot process on `127.0.0.1:8090`; Caddy proxies just that path
to it. Entries live in the `guestbook` table of the bot's SQLite DB. Spam
control is a Cloudflare Turnstile widget (verified server-side), a hidden
honeypot field, and a one-post-per-minute cooldown per IP (stored as a salted
hash, never the raw address). Names, messages and links are HTML-escaped and
links are limited to http(s).

Set `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET` in `bot/.env` (Cloudflare
dashboard → Turnstile → Add widget, hostname `unixcore.sh`). Unset, the bot
falls back to Cloudflare's always-pass test keys and logs a warning, which is
what you want locally and not what you want in production.

Mods: `/site guestbook list` · `/site guestbook delete <id>` ·
`/site guestbook purge <id>` (drops every entry from that entry's IP).

## IRC

An Ergo IRC server runs on the VPS at **irc.unixcore.sh:6697** (also reachable as
unixcore.sh:6697), TLS only, using Caddy's Let's Encrypt certs (picked by SNI). The
`irc` DNS record is an A record to the VPS, DNS-only like the others. `#unixcore` there is bridged to one
Discord channel by the bot (`bot/irc.ts`, with a small client in
`bot/irc-client.ts`):

- Discord to IRC: each person shows up as `name/d` via Ergo's RELAYMSG. Replies
  become `name: text`; attachments become links; long messages are cut to 5 lines;
  edits within 10 minutes are sent as `(edit) ...`.
- IRC to Discord: posted through a webhook named `unixcore irc`, one "user" per
  nick (`nick (irc)`). Mentions from IRC never ping. Joins and parts are not relayed.
  Each nick gets a character avatar (Bocchi the Rock, Girls' Last Tour, Touhou) from
  `bot/templates/hub/irc/`, picked by a hash of the nick so it never changes. Drop
  more square images in there to grow the set.

Turning it on:

1. Developer Portal > the bot > Bot > enable **Message Content Intent**. Without
   it the bot logs a warning and runs without the bridge (it does not crash).
2. The bot needs **Manage Webhooks** in the bridged channel (otherwise it posts
   IRC messages itself as `**<nick>** text`).
3. In the server's `bot/.env`: `IRC_DISCORD_CHANNEL=<channel id>` and a random
   `IRC_PASSWORD`. On first connect the bridge registers the `unixcore` nick with
   that password and founds `#unixcore`, which makes it a chanop (RELAYMSG needs
   that). Keep the password: changing it later locks the bridge out of its account.
4. `scripts/deploy.sh`.

On the box: binary `/usr/local/bin/ergo` (pinned in `scripts/install-ergo.sh`),
config `/etc/ergo/ircd.yaml` (from `infra/ergo.yaml`), data and MOTD in
`/var/lib/ergo`, unit `ergo`. `scripts/ergo-certs.sh` copies Caddy's cert in
before Ergo starts and daily (`ergo-certs.timer`). A deploy rehashes Ergo instead
of restarting it, so nobody gets disconnected. Logs: `journalctl -u ergo -f`.
There are no IRC operators configured yet (see the comment in `infra/ergo.yaml`).

Locally, `scripts/dev.sh` also starts Ergo if `ergo` is on your PATH (plain on
127.0.0.1:6667).

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

**Domain:** live on unixcore.sh (plus www and the beta alias) since 2026-09-11.
To change it, edit the hostname block at the bottom of `infra/Caddyfile`,
update `PUBLIC_URL`, `SFTP_HOST`, `WEBCLIENT_URL` in the server's `bot/.env`,
run `scripts/deploy.sh`.

**Heart-rate API:** milk's pages call `/api/heartbeat`, which Caddy proxies to
the Express server still running on box.sprojects.org:2096. Caddy also listens
on `unixcore.sh:2096` and passes it through, so the Android app that uploads
readings to that port keeps working unchanged.
