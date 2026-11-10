// Loader in the same spirit as bnuuybot: cmds/*.ts export a DiscordCommand,
// menus/*.ts export a DiscordMenu (a persistent message + button/modal handlers).
import fs from "node:fs";
import {
	ActivityType, ChatInputCommandInteraction, Client, Events, GatewayIntentBits, type Interaction,
	MessageFlags, type ButtonInteraction, type ModalSubmitInteraction, type StringSelectMenuInteraction,
	type SlashCommandOptionsOnlyBuilder,
	type SlashCommandSubcommandsOnlyBuilder, type BaseMessageOptions, TextChannel,
} from "discord.js";
import { config } from "./config";
import { Menus } from "./db";
import { startGuestbook } from "./guestbook";
import { startIrcBridge } from "./irc";
import { sftpgo } from "./sftpgo";
import { SiteError, onSiteCount, regenerateHub } from "./sites";

export type DiscordCommand = {
	data: SlashCommandOptionsOnlyBuilder | SlashCommandSubcommandsOnlyBuilder;
	execute: (i: ChatInputCommandInteraction) => Promise<void>;
};

export type ComponentInteraction = ButtonInteraction | ModalSubmitInteraction | StringSelectMenuInteraction;
export type DiscordMenu = {
	name: string;
	/** Where to post on startup if it hasn't been posted anywhere yet. */
	defaultChannel?: string;
	/** The persistent message posted with `/site menu` or `/site directory`. */
	build: () => BaseMessageOptions | Promise<BaseMessageOptions>;
	/**
	 * customId → handler, for buttons, selects and modal submits. A customId of
	 * "key|arg" goes to the "key" handler with `arg` (for things like page numbers).
	 */
	handlers: Record<string, (i: ComponentInteraction, arg?: string) => Promise<void>>;
	/** Called once logged in, with a function that re-renders the posted message. */
	onReady?: (refresh: () => Promise<void>) => void;
};

const commands = new Map<string, DiscordCommand>();
export const menus = new Map<string, DiscordMenu>();

// The IRC bridge reads message text, which needs the privileged Message Content
// intent. Asking for it without the portal toggle makes login fail outright, so
// check the app's flags first and run without the bridge if it's off.
async function bridgeIntentsOk(): Promise<boolean> {
	if (!config.irc.discordChannel) return false;
	const r = await fetch("https://discord.com/api/v10/applications/@me", { headers: { authorization: `Bot ${config.token}` } })
		.catch(() => null);
	const flags = r?.ok ? ((await r.json()) as { flags?: number }).flags ?? 0 : 0;
	const MESSAGE_CONTENT = (1 << 18) | (1 << 19); // GATEWAY_MESSAGE_CONTENT and its _LIMITED variant
	if (flags & MESSAGE_CONTENT) return true;
	console.warn("[irc] IRC_DISCORD_CHANNEL is set but the Message Content intent is off for this bot " +
		"(Developer Portal > Bot > Privileged Gateway Intents). Bridge disabled.");
	return false;
}
const ircBridge = await bridgeIntentsOk();

export const Bot = new Client({
	intents: ircBridge
		? [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
		: [GatewayIntentBits.Guilds],
});
if (ircBridge) startIrcBridge(Bot);

async function loadDir<T>(dir: string): Promise<T[]> {
	const files = fs.readdirSync(new URL(dir, import.meta.url)).filter(f => f.endsWith(".ts"));
	return Promise.all(files.map(async f => (await import(`${dir}/${f}`)).default as T));
}

// menu name → last payload sent, so refreshes that change nothing skip the edit
const lastPosted = new Map<string, string>();

/** Post (or refresh) a menu's persistent message in a channel. */
export async function publishMenu(menu: DiscordMenu, channel: TextChannel) {
	const payload = await menu.build();
	const json = JSON.stringify(payload);
	const saved = Menus.get(menu.name);
	if (saved && saved.channel_id === channel.id) {
		const msg = await channel.messages.fetch(saved.message_id).catch(() => null);
		if (msg) {
			if (lastPosted.get(menu.name) !== json) await msg.edit(payload);
			lastPosted.set(menu.name, json);
			return msg;
		}
	}
	const msg = await channel.send(payload);
	Menus.set(menu.name, channel.id, msg.id);
	lastPosted.set(menu.name, json);
	return msg;
}

async function onInteraction(interaction: Interaction) {
	try {
		if (interaction.isChatInputCommand()) {
			await commands.get(interaction.commandName)?.execute(interaction);
		} else if (interaction.isButton() || interaction.isModalSubmit() || interaction.isStringSelectMenu()) {
			const [key, ...rest] = interaction.customId.split("|");
			for (const menu of menus.values()) {
				const h = menu.handlers[key!];
				if (h) return await h(interaction, rest.length ? rest.join("|") : undefined);
			}
		}
	} catch (e) {
		const content = e instanceof SiteError
			? `❌ ${e.message}`
			: "❌ Something went wrong on our end — poke a mod.";
		if (!(e instanceof SiteError)) console.error(e);
		if (!interaction.isRepliable()) return;
		const payload = { content, embeds: [], components: [], flags: MessageFlags.Ephemeral } as const;
		if (interaction.deferred || interaction.replied) await interaction.followUp(payload).catch(() => {});
		else await interaction.reply(payload).catch(() => {});
	}
}

Bot.once(Events.ClientReady, async client => {
	console.log(`Logged in as ${client.user.tag}`);

	for (const c of await loadDir<DiscordCommand>("./cmds")) commands.set(c.data.name, c);
	for (const m of await loadDir<DiscordMenu>("./menus")) menus.set(m.name, m);

	const guild = await client.guilds.fetch(config.guildId);
	await guild.commands.set([...commands.values()].map(c => c.data.toJSON()));
	console.log(`Registered commands: ${[...commands.keys()].join(", ")}`);

	// Presence: "Hosting N sites", refreshed whenever the hub is regenerated.
	onSiteCount(n =>
		client.user.setActivity({ type: ActivityType.Custom, name: "status", state: `Hosting ${n} site${n === 1 ? "" : "s"}` }),
	);

	// Post menus into their default channel if configured, and refresh any
	// already posted so button labels/embeds pick up code changes.
	for (const menu of menus.values()) {
		menu.onReady?.(async () => {
			const saved = Menus.get(menu.name);
			const ch = saved && await client.channels.fetch(saved.channel_id).catch(() => null);
			if (ch instanceof TextChannel) await publishMenu(menu, ch).catch(e => console.error(`Refreshing menu "${menu.name}":`, e));
		});
		const channelId = Menus.get(menu.name)?.channel_id || menu.defaultChannel;
		if (!channelId) continue;
		const ch = await client.channels.fetch(channelId).catch(() => null);
		if (ch instanceof TextChannel) {
			const msg = await publishMenu(menu, ch);
			console.log(`Menu "${menu.name}" live in #${ch.name} (${msg.id})`);
		} else console.warn(`Menu "${menu.name}": channel ${channelId} not found or not a text channel`);
	}

	await regenerateHub();
});

Bot.on(Events.InteractionCreate, onInteraction);

// The guestbook doesn't need Discord, so it comes up before we log in.
startGuestbook();

// SFTPGo usually comes up a beat after us under dev.sh.
for (let i = 0; i < 30 && !(await sftpgo.healthy()); i++) await Bun.sleep(1000);
if (!(await sftpgo.healthy())) console.warn(`SFTPGo not reachable at ${config.sftpgo.url} — site actions will fail`);

Bot.login(config.token);
