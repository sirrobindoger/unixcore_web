import assert from "node:assert";
import path from "node:path";

// Repo root (bot/ lives one level down)
export const ROOT = path.resolve(import.meta.dir, "..");

const req = (name: string): string => {
	const v = process.env[name];
	assert(v, `${name} not set — see bot/.env.example`);
	return v;
};
const opt = (name: string, def: string): string => process.env[name] || def;
const abs = (p: string) => path.resolve(ROOT, p);

export const config = {
	token: req("TOKEN"),
	guildId: req("GUILD_ID"),
	// Optional: channel to auto-post the site menu into on startup (same as running /site menu there).
	siteChannel: opt("SITE_CHANNEL", ""),
	// Optional: same, for the site directory (or run /site directory there).
	directoryChannel: opt("DIRECTORY_CHANNEL", ""),

	sftpgo: {
		url: opt("SFTPGO_URL", "http://127.0.0.1:8080").replace(/\/$/, ""),
		admin: req("SFTPGO_ADMIN_USERNAME"),
		password: req("SFTPGO_ADMIN_PASSWORD"),
	},

	publicUrl: opt("PUBLIC_URL", "http://localhost:8000").replace(/\/$/, ""),
	sftpHost: opt("SFTP_HOST", "localhost"),
	sftpPort: Number(opt("SFTP_PORT", "2022")),
	webClientUrl: opt("WEBCLIENT_URL", "http://localhost:8080/web/client"),

	quotaBytes: Number(opt("QUOTA_MB", "25")) * 1024 * 1024,

	sitesDir: abs(opt("SITES_DIR", "sites")),
	suspendedDir: abs(opt("SUSPENDED_DIR", "suspended")),
	trashDir: abs(opt("TRASH_DIR", "trash")),
	dbPath: abs(opt("DB_PATH", "data/unixcore.db")),

	// Guestbook HTTP server (Caddy proxies /guestbook to it). Without real
	// Turnstile keys we fall back to Cloudflare's documented always-pass test
	// pair so local dev works; guestbook.ts logs a warning in that case.
	guestbook: {
		host: opt("GUESTBOOK_HOST", "127.0.0.1"),
		port: Number(opt("GUESTBOOK_PORT", "8090")),
		turnstileSiteKey: opt("TURNSTILE_SITE_KEY", "1x00000000000000000000AA"),
		turnstileSecret: opt("TURNSTILE_SECRET", "1x0000000000000000000000000000000AA"),
		usingTestKeys: !process.env.TURNSTILE_SITE_KEY || !process.env.TURNSTILE_SECRET,
		// Salts the stored IP hash. Change it and old hashes stop matching new posts.
		ipSalt: opt("GUESTBOOK_IP_SALT", "unixcore"),
	},
};
