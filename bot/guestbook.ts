// Guestbook: a tiny HTTP server on localhost that Caddy proxies at /guestbook.
// GET renders the entries + form; POST verifies a Cloudflare Turnstile token,
// applies a per-IP cooldown, escapes everything and inserts the row.
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config";
import { Guestbook } from "./db";

export const LIMITS = { name: 40, url: 200, message: 500 } as const;
const COOLDOWN_MS = 60_000;
const PAGE_SIZE = 200;

const tpl = await fs.readFile(path.join(import.meta.dir, "templates", "guestbook.html"), "utf8");
const render = (vars: Record<string, string | number>) =>
	tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars[k] ?? ""));

export const esc = (s: string) =>
	s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

const fmtDate = (ms: number) =>
	new Date(ms).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });

// Cooldown state lives in memory; a restart just forgets it, which is fine.
const lastPost = new Map<string, number>();
const ipHash = (ip: string) =>
	new Bun.CryptoHasher("sha256").update(`${config.guestbook.ipSalt}:${ip}`).digest("hex").slice(0, 16);

type Form = { name: string; url: string; message: string };

function clientIp(req: Request, server: { requestIP: (r: Request) => { address: string } | null }) {
	// Caddy sets X-Forwarded-For; the socket peer is always Caddy on localhost.
	const xff = req.headers.get("x-forwarded-for");
	if (xff) return xff.split(",")[0]!.trim();
	return server.requestIP(req)?.address ?? "unknown";
}

async function verifyTurnstile(token: string, ip: string): Promise<boolean> {
	if (!token) return false;
	const body = new URLSearchParams({ secret: config.guestbook.turnstileSecret, response: token, remoteip: ip });
	try {
		const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
		const j = (await r.json()) as { success?: boolean };
		return j.success === true;
	} catch (e) {
		console.error("turnstile verify failed", e);
		return false;
	}
}

/** Only http(s) URLs, so nobody can drop javascript: links into the page. */
function cleanUrl(raw: string): string | null {
	const s = raw.trim();
	if (!s) return null;
	const withScheme = /^[a-z]+:\/\//i.test(s) ? s : `https://${s}`;
	try {
		const u = new URL(withScheme);
		if (u.protocol !== "http:" && u.protocol !== "https:") return null;
		return u.href.length > LIMITS.url ? null : u.href;
	} catch {
		return null;
	}
}

/** One entry as HTML. Also used by the mod command for previews. */
export function entryHtml(r: { id: number; name: string; url: string | null; message: string; created_at: number }) {
	const who = r.url
		? `<a href="${esc(r.url)}" rel="nofollow noopener" target="_blank">${esc(r.name)}</a>`
		: esc(r.name);
	return `<div class="entry"><b>${who}</b> <span class="meta">#${r.id} &middot; ${fmtDate(r.created_at)}</span><br>${esc(r.message).replace(/\n/g, "<br>")}</div>`;
}

function page(opts: { notice?: string; form?: Form }, status = 200) {
	const entries = Guestbook.recent(PAGE_SIZE).map(entryHtml).join("\n");
	const f = opts.form ?? { name: "", url: "", message: "" };
	const html = render({
		notice: opts.notice ?? "",
		entries: entries || "<p><i>nobody has signed yet. be the first!</i></p>",
		count: Guestbook.count(),
		siteKey: config.guestbook.turnstileSiteKey,
		name: esc(f.name), url: esc(f.url), message: esc(f.message),
		nameMax: LIMITS.name, urlMax: LIMITS.url, messageMax: LIMITS.message,
	});
	return new Response(html, {
		status,
		headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
	});
}

const bad = (msg: string, form: Form) => page({ notice: `<p class="err">${esc(msg)}</p>`, form }, 400);
const thanks = `<p class="ok">thanks for signing!</p>`;

// Control characters other than newline/tab (the escaped form can't render them anyway).
const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

async function handlePost(req: Request, ip: string): Promise<Response> {
	const fd = await req.formData().catch(() => null);
	if (!fd) return new Response("bad form", { status: 400 });
	const str = (k: string) => { const v = fd.get(k); return typeof v === "string" ? v : ""; };
	const form: Form = {
		name: str("name").trim(),
		url: str("url").trim(),
		message: str("message").replace(/\r\n/g, "\n").trim(),
	};

	// Honeypot: real browsers leave the hidden "email" field empty. Pretend it worked.
	if (str("email")) return page({ notice: thanks });

	if (!form.name) return bad("you need a name.", form);
	if (form.name.length > LIMITS.name) return bad(`name is too long (max ${LIMITS.name}).`, form);
	if (!form.message) return bad("say something!", form);
	if (form.message.length > LIMITS.message) return bad(`message is too long (max ${LIMITS.message}).`, form);
	if (CONTROL_RE.test(form.name + form.message)) return bad("no control characters, please.", form);
	const url = cleanUrl(form.url);
	if (form.url && !url) return bad("that site link doesn't look like an http(s) URL.", form);

	const h = ipHash(ip);
	const last = lastPost.get(h) ?? 0;
	if (Date.now() - last < COOLDOWN_MS) return bad("slow down: one signature a minute.", form);

	if (!(await verifyTurnstile(str("cf-turnstile-response"), ip))) return bad("the spam check didn't pass. try again.", form);

	Guestbook.insert(form.name, url, form.message, h);
	lastPost.set(h, Date.now());
	if (lastPost.size > 5000) for (const [k, t] of lastPost) if (Date.now() - t > COOLDOWN_MS) lastPost.delete(k);

	// Redirect so a refresh doesn't resubmit.
	return new Response(null, { status: 303, headers: { location: "/guestbook?signed=1" } });
}

export function startGuestbook() {
	const server = Bun.serve({
		hostname: config.guestbook.host,
		port: config.guestbook.port,
		maxRequestBodySize: 16 * 1024,
		async fetch(req, srv) {
			const u = new URL(req.url);
			if (u.pathname !== "/guestbook" && u.pathname !== "/guestbook/") return new Response("not found", { status: 404 });
			if (req.method === "GET" || req.method === "HEAD") return page({ notice: u.searchParams.has("signed") ? thanks : "" });
			if (req.method === "POST") return handlePost(req, clientIp(req, srv));
			return new Response("method not allowed", { status: 405, headers: { allow: "GET, HEAD, POST" } });
		},
	});
	console.log(`Guestbook listening on http://${server.hostname}:${server.port}/guestbook`);
	if (config.guestbook.usingTestKeys)
		console.warn("Guestbook: TURNSTILE_SITE_KEY/TURNSTILE_SECRET not set, using Cloudflare's always-pass test keys");
	return server;
}
