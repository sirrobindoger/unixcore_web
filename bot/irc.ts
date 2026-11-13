// Discord <-> IRC bridge: pairs of Discord channel <-> channel on our Ergo
// (IRC_BRIDGES in bot/.env).
//
// Discord -> IRC: each message goes out with RELAYMSG as "name/d", so IRC sees one
// nick per Discord person. Without ops (or on a server without RELAYMSG) it falls
// back to "<name> text" from the bridge's own nick.
// IRC -> Discord: posted through a channel webhook with the IRC nick as the
// username. Mentions never ping (allowedMentions: none).
import fs from "node:fs";
import path from "node:path";
import {
	type Client, type Message, type PartialMessage, type TextChannel, type Webhook,
	ChannelType, Events,
} from "discord.js";
import { config } from "./config";
import { IrcClient } from "./irc-client";

const WEBHOOK_NAME = "unixcore irc";
/** Bytes of text per IRC line. 512 total minus prefix/command overhead, with margin. */
const LINE_BYTES = 360;
/** A long Discord message becomes at most this many IRC lines. */
const MAX_LINES = 5;
/** Edits to messages older than this aren't relayed. */
const EDIT_WINDOW_MS = 10 * 60_000;

// ---------- pure helpers (exported for tests) ----------

/** A Discord display name as an ASCII IRC nick part (before "/d"). */
export function ircNick(name: string, fallbackId: string): string {
	const ascii = name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "") // drop accents
		.replace(/[øØ]/g, "o").replace(/[æÆ]/g, "ae").replace(/ß/g, "ss").replace(/[łŁ]/g, "l").replace(/[đĐ]/g, "d");
	let n = ascii.replace(/\s+/g, "_").replace(/[^A-Za-z0-9_\-\[\]\\^{}|`]/g, "");
	n = n.replace(/^[-0-9]+/, ""); // nicks can't start with a digit or dash
	n = n.slice(0, 24);
	return n || `user${fallbackId.slice(-4)}`;
}

/** Split text into chunks of at most `max` UTF-8 bytes, preferring to break on spaces. */
export function splitBytes(text: string, max = LINE_BYTES): string[] {
	const enc = new TextEncoder();
	const out: string[] = [];
	let rest = text;
	while (enc.encode(rest).length > max) {
		// Longest prefix (by code point) that fits.
		let cut = 0, bytes = 0;
		for (const ch of rest) {
			const b = enc.encode(ch).length;
			if (bytes + b > max) break;
			bytes += b;
			cut += ch.length;
		}
		const space = rest.lastIndexOf(" ", cut);
		if (space > cut * 0.6) cut = space;
		out.push(rest.slice(0, cut).trimEnd());
		rest = rest.slice(cut).trimStart();
	}
	if (rest) out.push(rest);
	return out;
}

/** Discord message text (already cleanContent'd) to IRC lines. */
export function toIrcLines(text: string, extras: string[] = []): string[] {
	const src = text
		.replace(/<a?:(\w+):\d+>/g, ":$1:")   // custom emoji
		.replace(/<t:(\d+)(?::\w)?>/g, (_, t) => new Date(Number(t) * 1000).toUTCString())
		.split("\n")
		.map(l => l.trimEnd())
		.filter(l => l && !/^```\w*$/.test(l)); // drop bare code fences
	const lines = [...src, ...extras].flatMap(l => splitBytes(l));
	if (lines.length <= MAX_LINES) return lines;
	return [...lines.slice(0, MAX_LINES - 1), `... (${lines.length - MAX_LINES + 1} more lines on discord)`];
}

/** Strip mIRC formatting (bold, colors, etc.) from IRC text. */
export function stripIrcFormatting(s: string): string {
	return s.replace(/\x03(\d{1,2}(,\d{1,2})?)?|\x04[0-9a-fA-F]{0,6}(,[0-9a-fA-F]{6})?|[\x02\x0f\x11\x16\x1d\x1e\x1f]/g, "");
}

/** Discord rejects some webhook usernames outright; keep them valid. */
export function webhookName(nick: string): string {
	let n = `${nick} (irc)`
		.replace(/discord/gi, "d1scord")
		.replace(/clyde/gi, "c1yde")
		.replace(/[@#:]|```/g, "");
	if (/^(everyone|here)$/i.test(n.trim())) n = `_${n}`;
	return n.slice(0, 80);
}

/** FNV-1a, so a nick maps to the same avatar on every restart. */
export function nickHash(nick: string): number {
	let h = 0x811c9dc5;
	for (const c of nick.toLowerCase().replace(/[_`|^]+$/, "")) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
	return h;
}

// Character avatars for IRC people in Discord: bot/templates/hub/irc/, served by
// Caddy at /_hub/irc/ once the hub regenerates (it does on every startup).
const AVATAR_DIR = path.join(import.meta.dir, "templates", "hub", "irc");
const avatars = fs.existsSync(AVATAR_DIR)
	? fs.readdirSync(AVATAR_DIR).filter(f => /\.(png|gif|jpe?g)$/i.test(f)).sort()
	: [];
// Nicks that picked their avatar instead of taking the hash's (lowercase, no trailing _`|^).
const PINNED: Record<string, string> = {
	healie: "touhou-patchouli.png",
	sirro: "bocchi-kikuri.png",
	catmaster1010: "touhou-flandre.png",
};
export function avatarFor(nick: string) {
	if (!avatars.length) return undefined;
	const pinned = PINNED[nick.toLowerCase().replace(/[_`|^]+$/, "")];
	const file = pinned && avatars.includes(pinned) ? pinned : avatars[nickHash(nick) % avatars.length];
	return `${config.publicUrl}/_hub/irc/${file}`;
}

// ---------- the bridge ----------

type Link = { discordId: string; ircChannel: string; channel: TextChannel; webhook: Webhook | null };

/** The running bridge's IRC connection, for /toggle_irc. Null when the bridge is off. */
export let bridgeIrc: IrcClient | null = null;

export function startIrcBridge(bot: Client) {
	const cfg = config.irc;
	const irc = new IrcClient({
		host: cfg.host, port: cfg.port, tls: cfg.tls,
		nick: cfg.nick, password: cfg.password, channels: cfg.links.map(l => l.ircChannel),
	});

	// Filled in once Discord is ready; links whose Discord channel can't be found are dropped.
	const byDiscord = new Map<string, Link>();
	const byIrc = new Map<string, Link>(); // lowercased IRC channel
	// IRC -> Discord sends run one at a time so they arrive in order.
	let queue: Promise<unknown> = Promise.resolve();

	bot.once(Events.ClientReady, async client => {
		for (const { discordId, ircChannel } of cfg.links) {
			const ch = await client.channels.fetch(discordId).catch(() => null);
			if (!ch || ch.type !== ChannelType.GuildText) {
				console.error(`[irc] Discord channel ${discordId} isn't a text channel the bot can see; not bridging ${ircChannel}`);
				continue;
			}
			let webhook: Webhook | null = null;
			try {
				const hooks = await ch.fetchWebhooks();
				webhook = hooks.find(w => w.owner?.id === client.user.id && w.name === WEBHOOK_NAME)
					?? await ch.createWebhook({ name: WEBHOOK_NAME, reason: "IRC bridge" });
			} catch (e) {
				console.warn(`[irc] no webhook in #${ch.name} (bot needs Manage Webhooks); IRC messages will be posted by the bot itself`, (e as Error).message);
			}
			const link = { discordId, ircChannel, channel: ch, webhook };
			byDiscord.set(discordId, link);
			byIrc.set(ircChannel.toLowerCase(), link);
			console.log(`[irc] bridging #${ch.name} <-> ${ircChannel}`);
		}
		if (byDiscord.size) irc.start();
	});

	// ---- IRC -> Discord
	irc.on("message", (nick: string, target: string, text: string, isAction: boolean) => {
		const link = byIrc.get(target.toLowerCase());
		if (!link) return;
		// Our own nick, and relayed "name/d" nicks (ours or another bridge's): never echo back.
		if (nick === irc.nick || /[\/]/.test(nick)) return;
		const clean = stripIrcFormatting(text).trim();
		if (!clean) return;
		const content = (isAction ? `_${clean}_` : clean).slice(0, 2000);
		const { channel, webhook } = link;
		queue = queue.then(() =>
			webhook
				? webhook.send({ content, username: webhookName(nick), avatarURL: avatarFor(nick), allowedMentions: { parse: [] } })
				: channel.send({ content: `**<${nick}>** ${content}`.slice(0, 2000), allowedMentions: { parse: [] } }),
		).catch(e => console.warn("[irc] posting to discord failed:", (e as Error).message));
	});

	// ---- Discord -> IRC
	const relayable = (m: Message | PartialMessage) =>
		byDiscord.has(m.channelId) && !m.author?.bot && !m.webhookId && !m.system;

	async function displayName(m: Message) {
		return m.member?.displayName ?? m.author.globalName ?? m.author.username;
	}

	async function sendToIrc(m: Message, prefix = "") {
		const target = byDiscord.get(m.channelId)?.ircChannel;
		if (!target || !irc.connected) return;
		const name = ircNick(await displayName(m), m.author.id);

		// "name: text" for replies, IRC-style addressing.
		if (m.reference?.messageId && !prefix) {
			const ref = await m.fetchReference().catch(() => null);
			if (ref) {
				const who = ref.webhookId ? ref.author.username.replace(/ \(irc\)$/, "") : await displayName(ref);
				prefix = `${who}: `;
			}
		}

		const extras = [
			...m.attachments.map(a => a.url),
			...m.stickers.map(s => `[sticker: ${s.name}]`),
		];
		const lines = toIrcLines(m.cleanContent, extras);
		if (!lines.length) return;
		lines[0] = prefix + lines[0];

		const relay = irc.canRelay(target);
		for (const line of lines) {
			if (relay) irc.relaymsg(target, `${name}/d`, line);
			else irc.privmsg(target, `<${name}> ${line}`);
		}
	}

	bot.on(Events.MessageCreate, m => {
		if (relayable(m)) sendToIrc(m).catch(e => console.warn("[irc] relay failed:", (e as Error).message));
	});

	bot.on(Events.MessageUpdate, (before, after) => {
		if (!relayable(after) || after.partial) return;
		if (before.content === after.content) return; // embed unfurls also fire updates
		if (Date.now() - after.createdTimestamp > EDIT_WINDOW_MS) return;
		sendToIrc(after, "(edit) ").catch(e => console.warn("[irc] relay failed:", (e as Error).message));
	});

	bridgeIrc = irc;
	return irc;
}
