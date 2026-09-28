// Orchestrates a site's lifecycle across the three places it lives:
// the bot DB (discord_id ↔ slug), SFTPGo (login + quota) and the filesystem.
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config";
import { Guestbook, Sites, type SiteRow } from "./db";
import { SFTPGoError, sftpgo } from "./sftpgo";
import { validatePassword, validateSlug } from "./slug";

export class SiteError extends Error {}

const siteDir = (slug: string) => path.join(config.sitesDir, slug);
const suspendedPath = (slug: string) => path.join(config.suspendedDir, slug);
const exists = (p: string) => fs.access(p).then(() => true, () => false);

const render = (tpl: string, vars: Record<string, string | number>) =>
	tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars[k] ?? ""));

const tplDir = path.join(import.meta.dir, "templates");
const starterTpl = await fs.readFile(path.join(tplDir, "starter.html"), "utf8");
const hubTpl = await fs.readFile(path.join(tplDir, "hub.html"), "utf8");

export const siteUrl = (slug: string) => `${config.publicUrl}/${slug}/`;

// Static bits for the hub page. Copied to <sites>/_hub/ (an underscore can't be
// a slug, so no user can claim it). Anything in hub/bg/ is scattered behind the panel.
const hubAssets = path.join(tplDir, "hub");
const IMG_RE = /\.(png|gif|jpe?g)$/i;

/** Called with the active-site count after every hub regenerate (bot.ts uses it for the presence). */
export let onSiteCount: (count: number) => void = () => {};
export const setSiteCountListener = (fn: typeof onSiteCount) => { onSiteCount = fn; };

/** Rewrites <sites>/index.html listing every active site. */
export async function regenerateHub() {
	const rows = Sites.all().filter(r => r.status === "active");
	onSiteCount(rows.length);
	const sites = rows.map(r => `\t<li><a href="/${r.slug}/">${r.slug}</a></li>`).join("\n");
	await fs.mkdir(config.sitesDir, { recursive: true });
	await fs.cp(hubAssets, path.join(config.sitesDir, "_hub"), { recursive: true });
	const imagesIn = async (sub: string) =>
		(await fs.readdir(path.join(hubAssets, sub)).catch(() => [] as string[])).filter(f => IMG_RE.test(f)).sort();
	// hub/bg/ is scattered behind the panel; hub/buttons/ is a row of buttons (usually 88x31) under the badge
	const decor = (await imagesIn("bg")).map(f => `\t<img src="/_hub/bg/${f}" alt="">`).join("\n");
	const buttons = (await imagesIn("buttons")).map(f => `<img src="/_hub/buttons/${f}" alt="">`).join("\n");
	const guestbookCount = Guestbook.count();
	await fs.writeFile(
		path.join(config.sitesDir, "index.html"),
		render(hubTpl, {
			count: rows.length, sites, decor, buttons,
			guestbookCount, guestbookPlural: guestbookCount === 1 ? "" : "s",
			generated: new Date().toISOString(),
		}),
	);
}

async function ensureSlugFree(slug: string) {
	const err = validateSlug(slug);
	if (err) throw new SiteError(err);
	if (Sites.bySlug(slug) || (await sftpgo.exists(slug)) || (await exists(siteDir(slug))) || (await exists(suspendedPath(slug))))
		throw new SiteError(`\`${slug}\` is already taken.`);
}

export async function register(discordId: string, slug: string, password: string): Promise<SiteRow> {
	if (Sites.byDiscord(discordId)) throw new SiteError("You already have a site.");
	const pwErr = validatePassword(password);
	if (pwErr) throw new SiteError(pwErr);
	await ensureSlugFree(slug);

	const dir = siteDir(slug);
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(path.join(dir, "index.html"), render(starterTpl, {
		slug,
		publicUrl: config.publicUrl,
		quotaMb: Math.round(config.quotaBytes / 1024 / 1024),
		sftpHost: config.sftpHost,
		sftpPort: config.sftpPort,
		webClientUrl: config.webClientUrl,
	}));

	try {
		await sftpgo.createUser({ username: slug, password, homeDir: dir, discordId });
	} catch (e) {
		await fs.rm(dir, { recursive: true, force: true });
		throw e;
	}
	await sftpgo.scanQuota(slug).catch(() => {});

	Sites.insert(discordId, slug);
	await regenerateHub();
	return Sites.byDiscord(discordId)!;
}

function requireSite(discordId: string): SiteRow {
	const row = Sites.byDiscord(discordId);
	if (!row) throw new SiteError("You don't have a site yet.");
	return row;
}

export async function changePassword(discordId: string, password: string) {
	const row = requireSite(discordId);
	const pwErr = validatePassword(password);
	if (pwErr) throw new SiteError(pwErr);
	await sftpgo.setPassword(row.slug, password);
	return row;
}

export const MAX_KEYS = 5;
const KEY_TYPES = new Set([
	"ssh-ed25519", "ssh-rsa", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521",
	"sk-ssh-ed25519@openssh.com", "sk-ecdsa-sha2-nistp256@openssh.com",
]);

// A key blob is a run of length-prefixed fields, the first being the type name
// again. Checking that the fields add up exactly catches truncated/mangled pastes.
function wellFormed(bytes: Buffer, type: string) {
	let off = 0, fields = 0;
	while (off < bytes.length) {
		if (off + 4 > bytes.length) return false;
		const len = bytes.readUInt32BE(off);
		if (fields++ === 0 && bytes.toString("latin1", off + 4, off + 4 + len) !== type) return false;
		off += 4 + len;
	}
	return off === bytes.length && fields >= 2;
}

/** One OpenSSH public key per line → normalized "type base64 [comment]" list. Throws on anything else. */
function parsePublicKeys(text: string): string[] {
	if (/PRIVATE KEY/.test(text))
		throw new SiteError("That's your **private** key!! Never paste that anywhere. Use the `.pub` file instead.");
	const keys = new Map<string, string>(); // base64 → line, so pasting a key twice is harmless
	for (const [n, raw] of text.split(/\r?\n/).entries()) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const [type, blob, ...comment] = line.split(/\s+/);
		const bad = new SiteError(`Line ${n + 1} isn't an SSH public key. It should look like \`ssh-ed25519 AAAA… you@laptop\`.`);
		if (!KEY_TYPES.has(type!) || !blob || !/^[A-Za-z0-9+/]+={0,2}$/.test(blob)) throw bad;
		if (!wellFormed(Buffer.from(blob, "base64"), type!)) throw bad;
		keys.set(blob, [type, blob, ...comment].join(" "));
	}
	if (keys.size > MAX_KEYS) throw new SiteError(`That's ${keys.size} keys; the limit is ${MAX_KEYS}.`);
	return [...keys.values()];
}

/** Replaces the site's SSH keys (empty text removes them all). Returns how many are set now. */
export async function setPublicKeys(discordId: string, text: string) {
	const row = requireSite(discordId);
	const keys = parsePublicKeys(text);
	try {
		await sftpgo.setPublicKeys(row.slug, keys);
	} catch (e) {
		// SFTPGo parses the keys itself too (e.g. rejects weak RSA); pass its reason on.
		if (e instanceof SFTPGoError && e.status === 400) throw new SiteError(`SFTPGo rejected that key: ${e.message.split(": ").slice(1).join(": ")}`);
		throw e;
	}
	return { ...row, keyCount: keys.length };
}

/**
 * The slug is also the SFTP username, and SFTPGo can't rename users, so we
 * create a fresh login (needs a password we can't recover from the hash),
 * move the directory, then drop the old login.
 */
export async function changeSlug(discordId: string, newSlug: string, password: string): Promise<SiteRow> {
	const row = requireSite(discordId);
	if (row.status !== "active") throw new SiteError("Your site is suspended; contact a mod.");
	if (newSlug === row.slug) throw new SiteError("That's already your slug.");
	const pwErr = validatePassword(password);
	if (pwErr) throw new SiteError(pwErr);
	await ensureSlugFree(newSlug);

	const oldDir = siteDir(row.slug), newDir = siteDir(newSlug);
	const { public_keys: publicKeys } = await sftpgo.getUser(row.slug);
	await sftpgo.disconnect(row.slug);
	await sftpgo.createUser({ username: newSlug, password, homeDir: newDir, discordId, publicKeys });
	try {
		await fs.rename(oldDir, newDir);
	} catch (e) {
		await sftpgo.deleteUser(newSlug).catch(() => {});
		throw e;
	}
	await sftpgo.deleteUser(row.slug);
	await sftpgo.scanQuota(newSlug).catch(() => {});

	Sites.setSlug(discordId, newSlug);
	await regenerateHub();
	return Sites.byDiscord(discordId)!;
}

export async function suspend(discordId: string, reason: string) {
	const row = requireSite(discordId);
	if (row.status === "suspended") throw new SiteError("Already suspended.");
	await fs.mkdir(config.suspendedDir, { recursive: true });
	await sftpgo.disconnect(row.slug);
	await sftpgo.setStatus(row.slug, 0);
	await fs.rename(siteDir(row.slug), suspendedPath(row.slug));
	Sites.setStatus(discordId, "suspended", reason);
	await regenerateHub();
	return row;
}

export async function unsuspend(discordId: string) {
	const row = requireSite(discordId);
	if (row.status !== "suspended") throw new SiteError("Not suspended.");
	await fs.rename(suspendedPath(row.slug), siteDir(row.slug));
	await sftpgo.setStatus(row.slug, 1);
	Sites.setStatus(discordId, "active");
	await regenerateHub();
	return row;
}

/** Removes the login and moves the files to trash/<slug>-<timestamp> (never hard-deletes). */
export async function remove(discordId: string) {
	const row = requireSite(discordId);
	await fs.mkdir(config.trashDir, { recursive: true });
	await sftpgo.disconnect(row.slug);
	await sftpgo.deleteUser(row.slug).catch(e => { if (e.status !== 404) throw e; });
	const src = row.status === "suspended" ? suspendedPath(row.slug) : siteDir(row.slug);
	if (await exists(src)) await fs.rename(src, path.join(config.trashDir, `${row.slug}-${Date.now()}`));
	Sites.remove(discordId);
	await regenerateHub();
	return row;
}

export type SiteInfo = SiteRow & { usedBytes: number; usedFiles: number; quotaBytes: number; publicKeys: string[] };

export async function info(discordId: string): Promise<SiteInfo | null> {
	const row = Sites.byDiscord(discordId);
	if (!row) return null;
	let usedBytes = 0, usedFiles = 0, publicKeys: string[] = [];
	try {
		const u = await sftpgo.getUser(row.slug);
		usedBytes = u.used_quota_size ?? 0;
		usedFiles = u.used_quota_files ?? 0;
		publicKeys = u.public_keys ?? [];
	} catch {}
	return { ...row, usedBytes, usedFiles, quotaBytes: config.quotaBytes, publicKeys };
}

export const fmtBytes = (n: number) =>
	n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(2)} MB`;

export const usageBar = (used: number, total: number, width = 20) => {
	const filled = Math.min(width, Math.round((used / total) * width));
	return "█".repeat(filled) + "░".repeat(width - filled);
};
