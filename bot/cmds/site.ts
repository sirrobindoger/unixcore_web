// Mod tooling. Everything here needs Manage Server.
import {
	EmbedBuilder, MessageFlags, PermissionFlagsBits, SlashCommandBuilder, TextChannel, userMention,
} from "discord.js";
import { menus, publishMenu, type DiscordCommand } from "../bot";
import { Reserved, Sites } from "../db";
import { SLUG_RE, allReserved } from "../slug";
import * as sites from "../sites";

const eph = { flags: MessageFlags.Ephemeral } as const;

const Site: DiscordCommand = {
	data: new SlashCommandBuilder()
		.setName("site")
		.setDescription("unixcore.sh moderation")
		.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
		.addSubcommand(s => s.setName("menu").setDescription("Post (or refresh) the site menu in this channel"))
		.addSubcommand(s => s.setName("info").setDescription("Look up a user's site")
			.addUserOption(o => o.setName("user").setDescription("Member").setRequired(true)))
		.addSubcommand(s => s.setName("list").setDescription("List all registered sites"))
		.addSubcommand(s => s.setName("suspend").setDescription("Take a site offline and lock SFTP")
			.addUserOption(o => o.setName("user").setDescription("Member").setRequired(true))
			.addStringOption(o => o.setName("reason").setDescription("Shown to the user").setRequired(true)))
		.addSubcommand(s => s.setName("unsuspend").setDescription("Restore a suspended site")
			.addUserOption(o => o.setName("user").setDescription("Member").setRequired(true)))
		.addSubcommand(s => s.setName("delete").setDescription("Delete a user's site (files go to trash)")
			.addUserOption(o => o.setName("user").setDescription("Member").setRequired(true)))
		.addSubcommandGroup(g => g.setName("reserve").setDescription("Manage reserved site names")
			.addSubcommand(s => s.setName("add").setDescription("Reserve a name")
				.addStringOption(o => o.setName("slug").setDescription("Name").setRequired(true)))
			.addSubcommand(s => s.setName("remove").setDescription("Un-reserve a name added at runtime")
				.addStringOption(o => o.setName("slug").setDescription("Name").setRequired(true)))
			.addSubcommand(s => s.setName("list").setDescription("Show all reserved names"))),

	execute: async i => {
		const sub = i.options.getSubcommand();
		const group = i.options.getSubcommandGroup(false);

		if (group === "reserve") {
			const slug = i.options.getString("slug")?.toLowerCase().trim() ?? "";
			if (sub === "add") {
				if (!SLUG_RE.test(slug)) return void i.reply({ content: "Not a valid slug.", ...eph });
				Reserved.add(slug, i.user.id);
				return void i.reply({ content: `Reserved \`${slug}\`.`, ...eph });
			}
			if (sub === "remove") {
				const ok = Reserved.remove(slug);
				return void i.reply({ content: ok ? `Un-reserved \`${slug}\`.` : `\`${slug}\` isn't a runtime reservation (names in reserved.txt are edited in the file).`, ...eph });
			}
			return void i.reply({ content: "Reserved: " + allReserved().map(s => `\`${s}\``).join(", "), ...eph });
		}

		if (sub === "menu") {
			if (!(i.channel instanceof TextChannel)) return void i.reply({ content: "Run this in a text channel.", ...eph });
			const menu = menus.get("sitemenu")!;
			await publishMenu(menu, i.channel);
			return void i.reply({ content: "Menu posted.", ...eph });
		}

		if (sub === "list") {
			const rows = Sites.all();
			const lines = rows.map(r => `${r.status === "suspended" ? "⛔" : "🟢"} \`${r.slug}\` — ${userMention(r.discord_id)}`);
			return void i.reply({ content: lines.length ? lines.join("\n") : "No sites yet.", ...eph, allowedMentions: { parse: [] } });
		}

		const user = i.options.getUser("user", true);

		if (sub === "info") {
			const s = await sites.info(user.id);
			if (!s) return void i.reply({ content: `${user.tag} has no site.`, ...eph });
			const embed = new EmbedBuilder()
				.setColor(s.status === "active" ? 0x57f287 : 0xed4245)
				.setTitle(`~${s.slug}`).setURL(sites.siteUrl(s.slug))
				.addFields(
					{ name: "Owner", value: `${userMention(s.discord_id)} (\`${s.discord_id}\`)` },
					{ name: "Status", value: s.status + (s.suspended_reason ? ` — ${s.suspended_reason}` : "") },
					{ name: "Storage", value: `${sites.fmtBytes(s.usedBytes)} / ${sites.fmtBytes(s.quotaBytes)} · ${s.usedFiles} files` },
					{ name: "Created", value: `<t:${Math.floor(s.created_at / 1000)}:R>` },
				);
			return void i.reply({ embeds: [embed], ...eph, allowedMentions: { parse: [] } });
		}

		await i.deferReply(eph);
		if (sub === "suspend") {
			const r = await sites.suspend(user.id, i.options.getString("reason", true));
			await i.editReply(`⛔ Suspended \`${r.slug}\`.`);
		} else if (sub === "unsuspend") {
			const r = await sites.unsuspend(user.id);
			await i.editReply(`🟢 Restored \`${r.slug}\` → ${sites.siteUrl(r.slug)}`);
		} else if (sub === "delete") {
			const r = await sites.remove(user.id);
			await i.editReply(`🗑️ Deleted \`${r.slug}\` (files moved to trash).`);
		}
	},
};

export default Site;
