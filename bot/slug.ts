import fs from "node:fs";
import path from "node:path";
import { Reserved } from "./db";

// Subdomain-safe on purpose so /<slug> can become <slug>.unixcore.sh later:
// lowercase letters, digits, hyphens; no leading/trailing hyphen; 1–32 chars.
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
export const SLUG_RULES = "1–32 characters: lowercase letters, numbers and hyphens (no leading/trailing hyphen)";

// Baseline list ships in reserved.txt; mods add more at runtime via /site reserve.
const fileReserved = new Set(
	fs.readFileSync(path.join(import.meta.dir, "reserved.txt"), "utf8")
		.split("\n")
		.map(l => l.trim().toLowerCase())
		.filter(l => l && !l.startsWith("#")),
);

export const isReserved = (slug: string) => fileReserved.has(slug) || Reserved.has(slug);
export const allReserved = () => [...new Set([...fileReserved, ...Reserved.list()])].sort();

/** Turn a Discord handle (a-z 0-9 _ .) into a valid default slug. */
export function slugFromHandle(handle: string): string {
	const s = handle
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 32)
		.replace(/-+$/g, "");
	return s || "user";
}

/** Returns an error message, or null if the slug is acceptable. */
export function validateSlug(slug: string): string | null {
	if (!SLUG_RE.test(slug)) return `Invalid slug. Rules: ${SLUG_RULES}.`;
	if (isReserved(slug)) return `\`${slug}\` is reserved.`;
	return null;
}

export function validatePassword(pw: string): string | null {
	if (pw.length < 8) return "Password must be at least 8 characters.";
	if (pw.length > 128) return "Password must be 128 characters or fewer.";
	return null;
}
