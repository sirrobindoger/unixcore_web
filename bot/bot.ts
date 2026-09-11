// Loader in the same spirit as bnuuybot: cmds/*.ts export a DiscordCommand,
// menus/*.ts export a DiscordMenu (a persistent message + button/modal handlers).
import fs from "node:fs";
import {
	ChatInputCommandInteraction, Client, Events, GatewayIntentBits, type Interaction,
	MessageFlags, type ButtonInteraction, type ModalSubmitInteraction, type SlashCommandOptionsOnlyBuilder,
	type SlashCommandSubcommandsOnlyBuilder, type BaseMessageOptions, TextChannel,
} from "discord.js";
import { config } from "./config";
import { Menus } from "./db";
import { sftpgo } from "./sftpgo";
import { SiteError, regenerateHub } from "./sites";

export type DiscordCommand = {
	data: SlashCommandOptionsOnlyBuilder | SlashCommandSubcommandsOnlyBuilder;
	execute: (i: ChatInputCommandInteraction) => Promise<void>;
};

export type ComponentInteraction = ButtonInteraction | ModalSubmitInteraction;
export type DiscordMenu = {
	name: string;
	/** The persistent message posted with `/site menu`. */
	build: () => BaseMessageOptions;
	/** customId → handler, for buttons and modal submits. */
	handlers: Record<string, (i: ComponentInteraction) => Promise<void>>;
};

const commands = new Map<string, DiscordCommand>();
export const menus = new Map<string, DiscordMenu>();

export const Bot = new Client({ intents: [GatewayIntentBits.Guilds] });

async function loadDir<T>(dir: string): Promise<T[]> {
	const files = fs.readdirSync(new URL(dir, import.meta.url)).filter(f => f.endsWith(".ts"));
	return Promise.all(files.map(async f => (await import(`${dir}/${f}`)).default as T));
}

/** Post (or refresh) a menu's persistent message in a channel. */
export async function publishMenu(menu: DiscordMenu, channel: TextChannel) {
	const saved = Menus.get(menu.name);
	if (saved && saved.channel_id === channel.id) {
		const msg = await channel.messages.fetch(saved.message_id).catch(() => null);
		if (msg) {
			await msg.edit(menu.build());
			return msg;
		}
	}
	const msg = await channel.send(menu.build());
	Menus.set(menu.name, channel.id, msg.id);
	return msg;
}

async function onInteraction(interaction: Interaction) {
	try {
		if (interaction.isChatInputCommand()) {
			await commands.get(interaction.commandName)?.execute(interaction);
		} else if (interaction.isButton() || interaction.isModalSubmit()) {
			for (const menu of menus.values()) {
				const h = menu.handlers[interaction.customId];
				if (h) return await h(interaction);
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

	// Refresh any menus we've already posted so button labels/embeds pick up code changes.
	for (const menu of menus.values()) {
		const saved = Menus.get(menu.name);
		if (!saved) continue;
		const ch = await client.channels.fetch(saved.channel_id).catch(() => null);
		if (ch instanceof TextChannel) await publishMenu(menu, ch);
	}

	await regenerateHub();
});

Bot.on(Events.InteractionCreate, onInteraction);

// SFTPGo usually comes up a beat after us under dev.sh.
for (let i = 0; i < 30 && !(await sftpgo.healthy()); i++) await Bun.sleep(1000);
if (!(await sftpgo.healthy())) console.warn(`SFTPGo not reachable at ${config.sftpgo.url} — site actions will fail`);

Bot.login(config.token);
