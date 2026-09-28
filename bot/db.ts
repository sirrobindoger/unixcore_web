import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config";

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
const db = new Database(config.dbPath, { create: true });
db.exec("PRAGMA journal_mode = WAL");
db.exec(`
	CREATE TABLE IF NOT EXISTS sites (
		discord_id       TEXT PRIMARY KEY,
		slug             TEXT UNIQUE NOT NULL,
		status           TEXT NOT NULL DEFAULT 'active',
		suspended_reason TEXT,
		created_at       INTEGER NOT NULL
	);
	CREATE TABLE IF NOT EXISTS reserved (
		slug     TEXT PRIMARY KEY,
		added_by TEXT,
		added_at INTEGER NOT NULL
	);
	CREATE TABLE IF NOT EXISTS menus (
		name       TEXT PRIMARY KEY,
		channel_id TEXT NOT NULL,
		message_id TEXT NOT NULL
	);
	CREATE TABLE IF NOT EXISTS featured (
		day        TEXT PRIMARY KEY, -- YYYY-MM-DD, UTC
		discord_id TEXT NOT NULL
	);
	CREATE TABLE IF NOT EXISTS guestbook (
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		name       TEXT NOT NULL,
		url        TEXT,
		message    TEXT NOT NULL,
		ip_hash    TEXT NOT NULL,
		created_at INTEGER NOT NULL
	);
`);
// Columns added after launch.
const siteCols = db.query<{ name: string }, []>("PRAGMA table_info(sites)").all().map(c => c.name);
if (!siteCols.includes("tagline")) db.exec("ALTER TABLE sites ADD COLUMN tagline TEXT");

export type SiteStatus = "active" | "suspended";
export type SiteRow = {
	discord_id: string;
	slug: string;
	status: SiteStatus;
	suspended_reason: string | null;
	created_at: number;
	/** One-liner shown in the Discord directory. */
	tagline: string | null;
};

export const Sites = {
	byDiscord: (id: string) =>
		db.query<SiteRow, [string]>("SELECT * FROM sites WHERE discord_id = ?").get(id),
	bySlug: (slug: string) =>
		db.query<SiteRow, [string]>("SELECT * FROM sites WHERE slug = ?").get(slug),
	all: () =>
		db.query<SiteRow, []>("SELECT * FROM sites ORDER BY created_at ASC").all(),
	insert: (discordId: string, slug: string) =>
		db.query("INSERT INTO sites (discord_id, slug, created_at) VALUES (?, ?, ?)")
			.run(discordId, slug, Date.now()),
	setSlug: (discordId: string, slug: string) =>
		db.query("UPDATE sites SET slug = ? WHERE discord_id = ?").run(slug, discordId),
	setStatus: (discordId: string, status: SiteStatus, reason: string | null = null) =>
		db.query("UPDATE sites SET status = ?, suspended_reason = ? WHERE discord_id = ?")
			.run(status, reason, discordId),
	setTagline: (discordId: string, tagline: string | null) =>
		db.query("UPDATE sites SET tagline = ? WHERE discord_id = ?").run(tagline, discordId),
	remove: (discordId: string) =>
		db.query("DELETE FROM sites WHERE discord_id = ?").run(discordId),
};

/** Site of the day, one row per UTC date. Keyed by Discord ID so renames carry over. */
export const Featured = {
	get: (day: string) =>
		db.query<{ discord_id: string }, [string]>("SELECT discord_id FROM featured WHERE day = ?").get(day)?.discord_id,
	set: (day: string, discordId: string) =>
		db.query("INSERT OR REPLACE INTO featured (day, discord_id) VALUES (?, ?)").run(day, discordId),
	/** Who was featured on the `n` days before `day`. */
	before: (day: string, n: number) =>
		db.query<{ discord_id: string }, [string, number]>("SELECT discord_id FROM featured WHERE day < ? ORDER BY day DESC LIMIT ?")
			.all(day, n).map(r => r.discord_id),
};

export const Reserved = {
	list: () =>
		db.query<{ slug: string }, []>("SELECT slug FROM reserved ORDER BY slug").all().map(r => r.slug),
	has: (slug: string) =>
		!!db.query("SELECT 1 FROM reserved WHERE slug = ?").get(slug),
	add: (slug: string, by: string) =>
		db.query("INSERT OR IGNORE INTO reserved (slug, added_by, added_at) VALUES (?, ?, ?)")
			.run(slug, by, Date.now()),
	remove: (slug: string) =>
		db.query("DELETE FROM reserved WHERE slug = ?").run(slug).changes > 0,
};

export type GuestbookRow = {
	id: number;
	name: string;
	url: string | null;
	message: string;
	ip_hash: string;
	created_at: number;
};

export const Guestbook = {
	recent: (limit: number) =>
		db.query<GuestbookRow, [number]>("SELECT * FROM guestbook ORDER BY id DESC LIMIT ?").all(limit),
	count: () =>
		db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM guestbook").get()!.n,
	get: (id: number) =>
		db.query<GuestbookRow, [number]>("SELECT * FROM guestbook WHERE id = ?").get(id),
	insert: (name: string, url: string | null, message: string, ipHash: string) =>
		db.query("INSERT INTO guestbook (name, url, message, ip_hash, created_at) VALUES (?, ?, ?, ?, ?)")
			.run(name, url, message, ipHash, Date.now()),
	remove: (id: number) =>
		db.query("DELETE FROM guestbook WHERE id = ?").run(id).changes > 0,
	/** Delete every entry sharing an IP hash (for cleaning up after one spammer). */
	removeByIpHash: (ipHash: string) =>
		db.query("DELETE FROM guestbook WHERE ip_hash = ?").run(ipHash).changes,
};

export const Menus = {
	get: (name: string) =>
		db.query<{ channel_id: string; message_id: string }, [string]>(
			"SELECT channel_id, message_id FROM menus WHERE name = ?").get(name),
	set: (name: string, channelId: string, messageId: string) =>
		db.query("INSERT OR REPLACE INTO menus (name, channel_id, message_id) VALUES (?, ?, ?)")
			.run(name, channelId, messageId),
};
