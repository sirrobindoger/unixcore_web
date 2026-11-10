// Discord <-> IRC bridge between one Discord channel and one channel on our Ergo.
//
// Discord -> IRC: each message goes out with RELAYMSG as "name/d", so IRC sees one
// nick per Discord person. Without ops (or on a server without RELAYMSG) it falls
// back to "<name> text" from the bridge's own nick.
// IRC -> Discord: posted through a channel webhook with the IRC nick as the
// username. Mentions never ping (allowedMentions: none).
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

// ---------- the bridge ----------

export function startIrcBridge(bot: Client) {
	const cfg = config.irc;
	const irc = new IrcClient({
		host: cfg.host, port: cfg.port, tls: cfg.tls,
		nick: cfg.nick, password: cfg.password, channel: cfg.channel,
	});

	let channel: TextChannel | null = null;
	let webhook: Webhook | null = null;
	// IRC -> Discord sends run one at a time so they arrive in order.
	let queue: Promise<unknown> = Promise.resolve();

	bot.once(Events.ClientReady, async client => {
		const ch = await client.channels.fetch(cfg.discordChannel).catch(() => null);
		if (!ch || ch.type !== ChannelType.GuildText) {
			console.error(`[irc] IRC_DISCORD_CHANNEL ${cfg.discordChannel} isn't a text channel the bot can see; bridge off`);
			return;
		}
		channel = ch;
		try {
			const hooks = await ch.fetchWebhooks();
			webhook = hooks.find(w => w.owner?.id === client.user.id && w.name === WEBHOOK_NAME)
				?? await ch.createWebhook({ name: WEBHOOK_NAME, reason: "IRC bridge" });
		} catch (e) {
			console.warn(`[irc] no webhook in #${ch.name} (bot needs Manage Webhooks); IRC messages will be posted by the bot itself`, (e as Error).message);
		}
		console.log(`[irc] bridging #${ch.name} <-> ${cfg.channel} on ${cfg.host}:${cfg.port}`);
		irc.start();
	});

	// ---- IRC -> Discord
	irc.on("message", (nick: string, target: string, text: string, isAction: boolean) => {
		if (!channel || target.toLowerCase() !== cfg.channel.toLowerCase()) return;
		// Our own nick, and relayed "name/d" nicks (ours or another bridge's): never echo back.
		if (nick === irc.nick || /[\/]/.test(nick)) return;
		const clean = stripIrcFormatting(text).trim();
		if (!clean) return;
		const content = (isAction ? `_${clean}_` : clean).slice(0, 2000);
		const ch = channel, hook = webhook;
		queue = queue.then(() =>
			hook
				? hook.send({ content, username: webhookName(nick), allowedMentions: { parse: [] } })
				: ch.send({ content: `**<${nick}>** ${content}`.slice(0, 2000), allowedMentions: { parse: [] } }),
		).catch(e => console.warn("[irc] posting to discord failed:", (e as Error).message));
	});

	// ---- Discord -> IRC
	const relayable = (m: Message | PartialMessage) =>
		m.channelId === cfg.discordChannel && !m.author?.bot && !m.webhookId && !m.system;

	async function displayName(m: Message) {
		return m.member?.displayName ?? m.author.globalName ?? m.author.username;
	}

	async function sendToIrc(m: Message, prefix = "") {
		if (!irc.connected) return;
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

		for (const line of lines) {
			if (irc.canRelay) irc.relaymsg(cfg.channel, `${name}/d`, line);
			else irc.privmsg(cfg.channel, `<${name}> ${line}`);
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

	return irc;
}
