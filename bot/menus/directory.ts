// The phone book: one shared message (site count + site of the day) whose
// Browse button hands each person their own ephemeral pager, 10 sites a page.
// Random shows one site up close instead.
import {
	ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, StringSelectMenuBuilder,
	escapeMarkdown, userMention, type BaseMessageOptions, type ButtonInteraction, type StringSelectMenuInteraction,
} from "discord.js";
import type { DiscordMenu } from "../bot";
import { config } from "../config";
import { Featured, Sites, type SiteRow } from "../db";
import * as sites from "../sites";

// Button arg for a random site (see "key|arg" in bot.ts). Slugs can't contain it.
const RANDOM = "?";
const PER_PAGE = 10;
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

const cut = (s: string, max: number) => (s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s);

/** Tagline if they set one, else the page <title> when it says more than the name. */
function blurb(r: SiteRow, c: sites.SiteCard, max = 200) {
	if (r.tagline) return clean(cut(r.tagline, max));
	if (c.isStarter) return "*nothing here yet*";
	if (c.title && c.title.toLowerCase() !== r.slug) return clean(cut(c.title, max));
	return null;
}

const meta = (r: SiteRow, c: sites.SiteCard) => [
	`by ${userMention(r.discord_id)}`,
	sites.fmtBytes(c.bytes),
	c.updatedAt && `updated ${ts(c.updatedAt, "R")}`,
];

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

// "go to page" menu, labelled by the first and last name on each page like
// the top of a phone book page. Discord allows 25 options, so it's a window around `p`.
function pageMenu(list: SiteRow[], p: number, pages: number) {
	if (pages < 2) return null;
	const from = Math.max(0, Math.min(p - 12, pages - 25));
	const options = [];
	for (let k = from; k < Math.min(pages, from + 25); k++) {
		const chunk = list.slice(k * PER_PAGE, (k + 1) * PER_PAGE);
		const label = chunk.length === 1 ? chunk[0]!.slug : `${chunk[0]!.slug} – ${chunk.at(-1)!.slug}`;
		options.push({ label, value: String(k), description: `page ${k + 1}`, default: k === p });
	}
	return new StringSelectMenuBuilder().setCustomId("uc:dir:page").setPlaceholder("go to page...").addOptions(options);
}

/** Page `p` of the book (clamped), 10 sites each. */
async function listPage(p: number): Promise<BaseMessageOptions> {
	const list = listed();
	if (!list.length) return { content: "no sites yet.", embeds: [], components: [] };
	const pages = Math.ceil(list.length / PER_PAGE);
	p = Math.min(Math.max(Number.isFinite(p) ? p : 0, 0), pages - 1);
	const onPage = list.slice(p * PER_PAGE, (p + 1) * PER_PAGE);
	const cards = await Promise.all(onPage.map(r => sites.card(r.slug)));
	const entries = onPage.map((r, k) => {
		const c = cards[k]!, b = blurb(r, c, 80);
		return `**[~${r.slug}](${sites.siteUrl(r.slug)})**${b ? ` · ${b}` : ""}\n${meta(r, c).filter(Boolean).join(" · ")}`;
	});
	const embed = new EmbedBuilder()
		.setColor(0x5865f2)
		.setTitle("unixcore.sh directory")
		.setURL(config.publicUrl)
		.setDescription(entries.join("\n\n"))
		.setFooter({ text: `page ${p + 1} of ${pages} · ${list.length} site${list.length === 1 ? "" : "s"}` });
	const jump = pageMenu(list, p, pages);
	return {
		embeds: [embed],
		components: [
			row(
				btn(`uc:dir:list|${p - 1}`, "← prev").setDisabled(p === 0),
				btn(`uc:dir:list|${p + 1}`, "next →").setDisabled(p === pages - 1),
				btn(`uc:dir:go|${RANDOM}`, "Random"),
			),
			...(jump ? [row(jump)] : []),
		],
	};
}

/** One site up close. `target` is a slug (or the nearest spot to one that's gone) or RANDOM. */
async function sitePage(target: string): Promise<BaseMessageOptions> {
	const list = listed();
	if (!list.length) return { content: "no sites yet.", embeds: [], components: [] };
	let n = target === RANDOM ? Math.floor(Math.random() * list.length) : list.findIndex(r => r.slug >= target);
	if (n < 0) n = list.length - 1;
	const r = list[n]!, c = await sites.card(r.slug), url = sites.siteUrl(r.slug);
	const embed = new EmbedBuilder()
		.setColor(0x5865f2)
		.setTitle(`~${r.slug}`)
		.setURL(url)
		.setDescription([blurb(r, c), [...meta(r, c), `here since ${ts(r.created_at, "D")}`].filter(Boolean).join(" · ")].filter(Boolean).join("\n\n"));
	if (c.button) embed.setThumbnail(c.button);
	return {
		embeds: [embed],
		components: [row(
			btn(`uc:dir:list|${Math.floor(n / PER_PAGE)}`, "← back to list"),
			btn(`uc:dir:go|${RANDOM}`, "Random"),
			link(url, "Visit"),
		)],
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
				`${list.length} site${list.length === 1 ? "" : "s"} and counting. hit **Browse** to flip through them.`,
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
		// From the shared message: Browse (page 1) or Random site, as your own copy.
		"uc:dir:open": async (i, arg) => {
			await i.reply({ ...await (arg === RANDOM ? sitePage(RANDOM) : listPage(0)), flags: MessageFlags.Ephemeral });
		},
		// From inside your copy.
		"uc:dir:list": async (i, arg) => { await (i as ButtonInteraction).update(await listPage(Number(arg))); },
		"uc:dir:page": async i => {
			const s = i as StringSelectMenuInteraction;
			await s.update(await listPage(Number(s.values[0])));
		},
		"uc:dir:go": async (i, arg) => { await (i as ButtonInteraction).update(await sitePage(arg ?? RANDOM)); },
	},

	onReady: refresh => {
		// Site count / featured site follow register, rename, suspend, delete, taglines.
		sites.onSiteCount(() => void refresh());
		// Roll the site of the day over shortly after midnight UTC.
		setInterval(() => { if (!Featured.get(today())) void refresh(); }, 5 * 60_000);
	},
};

export default Directory;
