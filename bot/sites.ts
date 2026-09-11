// Orchestrates a site's lifecycle across the three places it lives:
// the bot DB (discord_id ↔ slug), SFTPGo (login + quota) and the filesystem.
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config";
import { Sites, type SiteRow } from "./db";
import { sftpgo } from "./sftpgo";
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

/** Rewrites <sites>/index.html listing every active site. */
export async function regenerateHub() {
	const rows = Sites.all().filter(r => r.status === "active");
	const sites = rows.map(r => `\t<li><a href="/${r.slug}/">${r.slug}</a></li>`).join("\n");
	await fs.mkdir(config.sitesDir, { recursive: true });
	await fs.cp(hubAssets, path.join(config.sitesDir, "_hub"), { recursive: true });
	const imagesIn = async (sub: string) =>
		(await fs.readdir(path.join(hubAssets, sub)).catch(() => [] as string[])).filter(f => IMG_RE.test(f)).sort();
	// hub/bg/ is scattered behind the panel; hub/buttons/ is a row of buttons (usually 88x31) under the badge
	const decor = (await imagesIn("bg")).map(f => `\t<img src="/_hub/bg/${f}" alt="">`).join("\n");
	const buttons = (await imagesIn("buttons")).map(f => `<img src="/_hub/buttons/${f}" alt="">`).join("\n");
	await fs.writeFile(
		path.join(config.sitesDir, "index.html"),
		render(hubTpl, { count: rows.length, sites, decor, buttons, generated: new Date().toISOString() }),
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
	await sftpgo.disconnect(row.slug);
	await sftpgo.createUser({ username: newSlug, password, homeDir: newDir, discordId });
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

export type SiteInfo = SiteRow & { usedBytes: number; usedFiles: number; quotaBytes: number };

export async function info(discordId: string): Promise<SiteInfo | null> {
	const row = Sites.byDiscord(discordId);
	if (!row) return null;
	let usedBytes = 0, usedFiles = 0;
	try {
		const u = await sftpgo.getUser(row.slug);
		usedBytes = u.used_quota_size ?? 0;
		usedFiles = u.used_quota_files ?? 0;
	} catch {}
	return { ...row, usedBytes, usedFiles, quotaBytes: config.quotaBytes };
}

export const fmtBytes = (n: number) =>
	n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(2)} MB`;

export const usageBar = (used: number, total: number, width = 20) => {
	const filled = Math.min(width, Math.round((used / total) * width));
	return "█".repeat(filled) + "░".repeat(width - filled);
};
