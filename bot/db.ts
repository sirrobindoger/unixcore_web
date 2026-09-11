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
`);

export type SiteStatus = "active" | "suspended";
export type SiteRow = {
	discord_id: string;
	slug: string;
	status: SiteStatus;
	suspended_reason: string | null;
	created_at: number;
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
	remove: (discordId: string) =>
		db.query("DELETE FROM sites WHERE discord_id = ?").run(discordId),
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

export const Menus = {
	get: (name: string) =>
		db.query<{ channel_id: string; message_id: string }, [string]>(
			"SELECT channel_id, message_id FROM menus WHERE name = ?").get(name),
	set: (name: string, channelId: string, messageId: string) =>
		db.query("INSERT OR REPLACE INTO menus (name, channel_id, message_id) VALUES (?, ?, ?)")
			.run(name, channelId, messageId),
};
