// The user-facing flow: one pinned "Open menu" message → ephemeral dashboard →
// modals for register / password / slug, and a confirm step for delete.
import {
	ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, LabelBuilder, MessageFlags,
	ModalBuilder, TextInputBuilder, TextInputStyle, type User, type ButtonInteraction,
	type ModalSubmitInteraction, type BaseMessageOptions,
} from "discord.js";
import type { ComponentInteraction, DiscordMenu } from "../bot";
import { config } from "../config";
import { SLUG_RULES, slugFromHandle } from "../slug";
import * as sites from "../sites";

const quotaMb = Math.round(config.quotaBytes / 1024 / 1024);
const host = new URL(config.publicUrl).host;
const btn = (id: string, label: string, style = ButtonStyle.Secondary, emoji?: string) => {
	const b = new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
	return emoji ? b.setEmoji(emoji) : b;
};
const link = (url: string, label: string, emoji: string) =>
	new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(url).setLabel(label).setEmoji(emoji);
const row = (...buttons: ButtonBuilder[]) => new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons);

// ---- dashboard -------------------------------------------------------------

async function dashboard(user: User): Promise<BaseMessageOptions> {
	const s = await sites.info(user.id);
	if (!s) {
		const embed = new EmbedBuilder()
			.setColor(0x5865f2)
			.setTitle("You don't have a site yet!!!!")
			.setDescription(
				`Register to get **${host}/<name>/**!! (${quotaMb} MB of storage)\n\n` +
				`Your Discord handle is the default name but u can like change it if u want.`,
			);
		return { embeds: [embed], components: [row(btn("uc:register", "Register site", ButtonStyle.Success, "✨"))] };
	}

	const url = sites.siteUrl(s.slug);
	const embed = new EmbedBuilder()
		.setColor(s.status === "active" ? 0x57f287 : 0xed4245)
		.setTitle(`~${s.slug}`)
		.setURL(url)
		.addFields(
			{ name: "Site", value: url },
			{ name: "SFTP", value: `FileZilla/WinSCP host: \`sftp://${s.slug}@${config.sftpHost}:${config.sftpPort}\`\n(host \`${config.sftpHost}\` · port \`${config.sftpPort}\` · user \`${s.slug}\`)\n[web file manager](${config.webClientUrl}) (if you really wanna)` +
				(s.publicKeys.length ? `\n🗝️ ${s.publicKeys.length} SSH key${s.publicKeys.length === 1 ? "" : "s"} set, so no password needed from those machines` : "") },
			{ name: "Storage", value: `\`${sites.usageBar(s.usedBytes, s.quotaBytes)}\` ${sites.fmtBytes(s.usedBytes)} / ${quotaMb} MB · ${s.usedFiles} files` },
		);
	if (s.status === "suspended") {
		embed.addFields({ name: "⛔ Suspended", value: s.suspended_reason || "Contact a mod." });
		return { embeds: [embed], components: [row(btn("uc:refresh", "Refresh", ButtonStyle.Secondary, "🔄"))] };
	}
	return {
		embeds: [embed],
		components: [
			row(
				btn("uc:password", "Change password", ButtonStyle.Primary, "🔑"),
				btn("uc:keys", "SSH keys", ButtonStyle.Secondary, "🗝️"),
				btn("uc:slug", "Change name", ButtonStyle.Secondary, "✏️"),
				btn("uc:refresh", "Refresh", ButtonStyle.Secondary, "🔄"),
			),
			row(btn("uc:delete", "Delete site", ButtonStyle.Danger, "🗑️")),
		],
	};
}

// ---- modals ----------------------------------------------------------------

const textInput = (id: string, label: string, opts: { value?: string; min?: number; max?: number; description?: string; placeholder?: string } = {}) => {
	const input = new TextInputBuilder().setCustomId(id).setStyle(TextInputStyle.Short).setRequired(true);
	if (opts.value) input.setValue(opts.value);
	if (opts.min) input.setMinLength(opts.min);
	if (opts.max) input.setMaxLength(opts.max);
	if (opts.placeholder) input.setPlaceholder(opts.placeholder);
	const l = new LabelBuilder().setLabel(label).setTextInputComponent(input);
	return opts.description ? l.setDescription(opts.description) : l;
};
const slugInput = (value?: string) =>
	textInput("slug", `Site name — ${host}/<name>/`, { value, min: 1, max: 32, description: SLUG_RULES });
const passwordInput = (label = "SFTP password") =>
	textInput("password", label, { min: 8, max: 128, description: "8+ characters. Password!! Yay!" });

// Paragraph input; optional because clearing it is how you remove your keys.
const keysInput = (current: string[]) => {
	const input = new TextInputBuilder().setCustomId("keys").setStyle(TextInputStyle.Paragraph).setRequired(false)
		.setMaxLength(4000).setPlaceholder("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA... you@laptop");
	const value = current.join("\n");
	if (value && value.length <= 4000) input.setValue(value);
	return new LabelBuilder().setLabel("Public SSH keys").setTextInputComponent(input)
		.setDescription(`Paste your .pub file, one key per line (max ${sites.MAX_KEYS}). Leave empty to remove them.`);
};

const modals = {
	register: (user: User) => new ModalBuilder().setCustomId("uc:m:register").setTitle("Register your site")
		.addLabelComponents(slugInput(slugFromHandle(user.username)), passwordInput()),
	password: () => new ModalBuilder().setCustomId("uc:m:password").setTitle("Change SFTP password")
		.addLabelComponents(passwordInput("New SFTP password")),
	keys: (current: string[]) => new ModalBuilder().setCustomId("uc:m:keys").setTitle("SSH key login")
		.addLabelComponents(keysInput(current)),
	slug: (current: string) => new ModalBuilder().setCustomId("uc:m:slug").setTitle("Change site name")
		.addLabelComponents(slugInput(current), passwordInput("SFTP password (re-enter or pick a new one)")),
};

// ---- handlers --------------------------------------------------------------

const asButton = (i: ComponentInteraction) => i as ButtonInteraction;
const asModal = (i: ComponentInteraction) => i as ModalSubmitInteraction;
const field = (i: ModalSubmitInteraction, id: string) => i.fields.getTextInputValue(id).trim();

const SiteMenu: DiscordMenu = {
	name: "sitemenu",

	build: () => ({
		embeds: [
			new EmbedBuilder()
				.setColor(0x5865f2)
				.setTitle("unixcore.sh")
				.setDescription(
					`You can make your own website at **${host}/<name>/**!!!\n` +
					`${quotaMb} MB of static files (HTML, CSS, JS, images), uploaded over SFTP or the web file manager.\nDont know what that is? Just ask someone!\n` +
					"Hit **Open menu** to register, change your password or name, or check your storage.",
				),
		],
		components: [row(
			btn("uc:open", "Open menu", ButtonStyle.Primary, "📋"),
			link(config.publicUrl, "Open website", "🌐"),
			link(config.webClientUrl, "Open web panel", "🔧"),
		)],
	}),

	handlers: {
		"uc:open": async i => { await i.reply({ ...await dashboard(i.user), flags: MessageFlags.Ephemeral }); },
		"uc:refresh": async i => { await asButton(i).update(await dashboard(i.user)); },

		"uc:register": async i => { await asButton(i).showModal(modals.register(i.user)); },
		"uc:m:register": async i => {
			const m = asModal(i);
			await m.deferReply({ flags: MessageFlags.Ephemeral });
			const site = await sites.register(i.user.id, field(m, "slug").toLowerCase(), field(m, "password"));
			await m.editReply({ content: `✅ Registered **${site.slug}** → ${sites.siteUrl(site.slug)}`, ...await dashboard(i.user) });
		},

		"uc:password": async i => { await asButton(i).showModal(modals.password()); },
		"uc:m:password": async i => {
			const m = asModal(i);
			await m.deferReply({ flags: MessageFlags.Ephemeral });
			const site = await sites.changePassword(i.user.id, field(m, "password"));
			await m.editReply({ content: `🔑 Password updated for **${site.slug}**.` });
		},

		"uc:keys": async i => {
			await asButton(i).showModal(modals.keys((await sites.info(i.user.id))?.publicKeys ?? []));
		},
		"uc:m:keys": async i => {
			const m = asModal(i);
			await m.deferReply({ flags: MessageFlags.Ephemeral });
			const site = await sites.setPublicKeys(i.user.id, field(m, "keys"));
			const content = site.keyCount
				? `🗝️ Saved ${site.keyCount} key${site.keyCount === 1 ? "" : "s"} for **${site.slug}**. \`sftp -P ${config.sftpPort} ${site.slug}@${config.sftpHost}\` now logs in without a password (the password still works too).`
				: `🗝️ Removed all SSH keys from **${site.slug}**; it's password only again.`;
			await m.editReply({ content, ...await dashboard(i.user) });
		},

		"uc:slug": async i => {
			const current = (await sites.info(i.user.id))?.slug ?? slugFromHandle(i.user.username);
			await asButton(i).showModal(modals.slug(current));
		},
		"uc:m:slug": async i => {
			const m = asModal(i);
			await m.deferReply({ flags: MessageFlags.Ephemeral });
			const site = await sites.changeSlug(i.user.id, field(m, "slug").toLowerCase(), field(m, "password"));
			await m.editReply({ content: `✏️ Your site is now **${site.slug}** → ${sites.siteUrl(site.slug)} (SFTP username changed too).`, ...await dashboard(i.user) });
		},

		"uc:delete": async i => {
			await asButton(i).update({
				embeds: [new EmbedBuilder().setColor(0xed4245).setTitle("Delete your site?")
					.setDescription("This removes your SFTP login and takes the site offline. A mod can recover the files for a while if you change your mind.")],
				components: [row(btn("uc:delete:confirm", "Yes, delete it", ButtonStyle.Danger), btn("uc:delete:cancel", "Cancel"))],
			});
		},
		"uc:delete:confirm": async i => {
			const b = asButton(i);
			await b.deferUpdate();
			const site = await sites.remove(i.user.id);
			await b.editReply({ content: `🗑️ **${site.slug}** deleted.`, ...await dashboard(i.user) });
		},
		"uc:delete:cancel": async i => { await asButton(i).update(await dashboard(i.user)); },
	},
};

export default SiteMenu;
