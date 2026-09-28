// The phone book: one shared message (site count + site of the day) whose
// Browse button hands each person their own ephemeral pager, one site a page.
import {
	ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, StringSelectMenuBuilder,
	escapeMarkdown, userMention, type BaseMessageOptions, type ButtonInteraction, type StringSelectMenuInteraction,
} from "discord.js";
import type { DiscordMenu } from "../bot";
import { config } from "../config";
import { Featured, Sites, type SiteRow } from "../db";
import * as sites from "../sites";

// Button args (see "key|arg" in bot.ts). Slugs can't contain these.
const RANDOM = "?", NONE_BEFORE = "^", NONE_AFTER = "$";
// Don't re-feature anyone from the last two weeks while there are others to pick.
const FEATURE_GAP_DAYS = 14;

const btn = (id: string, label: string, style = ButtonStyle.Secondary) =>
	new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
const link = (url: string, label: string) =>
	new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(url).setLabel(label);
const row = <T extends ButtonBuilder | StringSelectMenuBuilder>(...c: T[]) => new ActionRowBuilder<T>().addComponents(...c);

const today = () => new Date().toISOString().slice(0, 10);
const ts = (ms: number, style: "R" | "D") => `<t:${Math.floor(ms / 1000)}:${style}>`;
const sample = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];

/** Everyone listed in the book, alphabetical. */
const listed = () => Sites.all().filter(r => r.status === "active").sort((a, b) => (a.slug < b.slug ? -1 : 1));

// User text goes into embeds, where masked links render; escapeMarkdown leaves those alone.
const clean = (s: string) => escapeMarkdown(s).replace(/[[\]<>]/g, "\\$&");

/** Tagline if they set one, else the page <title> when it says more than the name. */
function blurb(r: SiteRow, c: sites.SiteCard) {
	if (r.tagline) return clean(r.tagline);
	if (c.isStarter) return "*nothing here yet*";
	if (c.title && c.title.toLowerCase() !== r.slug) return clean(c.title);
	return null;
}

/** Today's pick, choosing one if there isn't one yet or the pick went away (deleted, suspended). */
async function siteOfTheDay(list: SiteRow[]) {
	const day = today();
	const current = list.find(r => r.discord_id === Featured.get(day));
	if (current) return current;
	const touched = (await Promise.all(list.map(async r => ((await sites.isStarter(r.slug)) ? null : r)))).filter(r => r !== null);
	const recent = new Set(Featured.before(day, FEATURE_GAP_DAYS));
	const fresh = touched.filter(r => !recent.has(r.discord_id));
	const pick = sample(fresh.length ? fresh : touched.length ? touched : list);
	if (pick) Featured.set(day, pick.discord_id);
	return pick ?? null;
}

// Letters to jump to. Up to 25 options (Discord's cap), merging neighbours into ranges if needed.
function jumpMenu(list: SiteRow[], current: SiteRow) {
	const groups: { key: string; first: string; count: number }[] = [];
	for (const r of list) {
		const key = /[0-9]/.test(r.slug[0]!) ? "0-9" : r.slug[0]!;
		const last = groups.at(-1);
		if (last?.key === key) last.count++;
		else groups.push({ key, first: r.slug, count: 1 });
	}
	if (groups.length < 2) return null;
	const per = Math.ceil(groups.length / 25);
	const options = [];
	for (let g = 0; g < groups.length; g += per) {
		const chunk = groups.slice(g, g + per);
		const count = chunk.reduce((n, x) => n + x.count, 0);
		const label = chunk.length === 1 ? chunk[0]!.key : `${chunk[0]!.key}–${chunk.at(-1)!.key}`;
		const here = chunk.some(x => x.key === (/[0-9]/.test(current.slug[0]!) ? "0-9" : current.slug[0]));
		options.push({ label, value: chunk[0]!.first, description: `${count} site${count === 1 ? "" : "s"}`, default: here });
	}
	return new StringSelectMenuBuilder().setCustomId("uc:dir:jump").setPlaceholder("jump to...").addOptions(options);
}

/** One page of the book. `target` is a slug (or the nearest spot to one that's gone), RANDOM, or nothing for the start. */
async function page(target?: string): Promise<BaseMessageOptions> {
	const list = listed();
	if (!list.length) return { content: "no sites yet.", embeds: [], components: [] };
	let n = 0;
	if (target === RANDOM) n = Math.floor(Math.random() * list.length);
	else if (target) {
		n = list.findIndex(r => r.slug >= target);
		if (n < 0) n = list.length - 1;
	}
	const r = list[n]!, c = await sites.card(r.slug), url = sites.siteUrl(r.slug);
	const meta = [
		`by ${userMention(r.discord_id)}`,
		sites.fmtBytes(c.bytes),
		c.updatedAt && `updated ${ts(c.updatedAt, "R")}`,
		`here since ${ts(r.created_at, "D")}`,
	].filter(Boolean).join(" · ");
	const embed = new EmbedBuilder()
		.setColor(0x5865f2)
		.setTitle(`~${r.slug}`)
		.setURL(url)
		.setDescription([blurb(r, c), meta].filter(Boolean).join("\n\n"))
		.setFooter({ text: `${n + 1} of ${list.length}` });
	if (c.button) embed.setThumbnail(c.button);
	const jump = jumpMenu(list, r);
	return {
		embeds: [embed],
		components: [
			row(
				btn(`uc:dir:go|${list[n - 1]?.slug ?? NONE_BEFORE}`, "← prev").setDisabled(n === 0),
				btn(`uc:dir:go|${list[n + 1]?.slug ?? NONE_AFTER}`, "next →").setDisabled(n === list.length - 1),
				btn(`uc:dir:go|${RANDOM}`, "Random"),
				link(url, "Visit"),
			),
			...(jump ? [row(jump)] : []),
		],
	};
}

const Directory: DiscordMenu = {
	name: "directory",
	defaultChannel: config.directoryChannel,

	build: async () => {
		const list = listed();
		const embed = new EmbedBuilder()
			.setColor(0x5865f2)
			.setTitle("unixcore.sh directory")
			.setURL(config.publicUrl)
			.setDescription(
				`${list.length} site${list.length === 1 ? "" : "s"} and counting. hit **Browse** to flip through them like a phone book, ` +
				"you get your own copy so nobody else's clicking gets in the way.",
			);
		const buttons = [btn("uc:dir:open", "Browse", ButtonStyle.Primary), btn(`uc:dir:open|${RANDOM}`, "Random site")];
		const pick = await siteOfTheDay(list);
		if (pick) {
			const c = await sites.card(pick.slug), url = sites.siteUrl(pick.slug);
			embed.addFields({
				name: "site of the day",
				value: [`**[~${pick.slug}](${url})**`, blurb(pick, c), `by ${userMention(pick.discord_id)}`].filter(Boolean).join("\n"),
			});
			if (c.button) embed.setThumbnail(c.button);
			embed.setFooter({ text: "new site of the day every midnight UTC · set your tagline from the site menu" });
			buttons.push(link(url, `Visit ~${pick.slug}`));
		}
		return { embeds: [embed], components: [row(...buttons)] };
	},

	handlers: {
		"uc:dir:open": async (i, arg) => { await i.reply({ ...await page(arg), flags: MessageFlags.Ephemeral }); },
		"uc:dir:go": async (i, arg) => { await (i as ButtonInteraction).update(await page(arg)); },
		"uc:dir:jump": async i => {
			const s = i as StringSelectMenuInteraction;
			await s.update(await page(s.values[0]));
		},
	},

	onReady: refresh => {
		// Site count / featured site follow register, rename, suspend, delete, taglines.
		sites.onSiteCount(() => void refresh());
		// Roll the site of the day over shortly after midnight UTC.
		setInterval(() => { if (!Featured.get(today())) void refresh(); }, 5 * 60_000);
	},
};

export default Directory;
