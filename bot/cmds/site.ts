// Mod tooling. Everything here needs Manage Server.
import {
	EmbedBuilder, MessageFlags, PermissionFlagsBits, SlashCommandBuilder, TextChannel, userMention,
} from "discord.js";
import { menus, publishMenu, type DiscordCommand } from "../bot";
import { Guestbook, Reserved, Sites } from "../db";
import { SLUG_RE, allReserved } from "../slug";
import * as sites from "../sites";

const eph = { flags: MessageFlags.Ephemeral } as const;

const Site: DiscordCommand = {
	data: new SlashCommandBuilder()
		.setName("site")
		.setDescription("unixcore.sh moderation")
		.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
		.addSubcommand(s => s.setName("menu").setDescription("Post (or refresh) the site menu in this channel"))
		.addSubcommand(s => s.setName("directory").setDescription("Post (or refresh) the site directory in this channel"))
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
			.addSubcommand(s => s.setName("list").setDescription("Show all reserved names")))
		.addSubcommandGroup(g => g.setName("guestbook").setDescription("Moderate the guestbook")
			.addSubcommand(s => s.setName("list").setDescription("Show the latest guestbook entries with their ids"))
			.addSubcommand(s => s.setName("delete").setDescription("Delete one guestbook entry")
				.addIntegerOption(o => o.setName("id").setDescription("Entry id (shown as #id on the page)").setRequired(true).setMinValue(1)))
			.addSubcommand(s => s.setName("purge").setDescription("Delete every entry posted from the same IP as one entry")
				.addIntegerOption(o => o.setName("id").setDescription("Any entry id from the offender").setRequired(true).setMinValue(1)))),

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

		if (group === "guestbook") {
			if (sub === "list") {
				const rows = Guestbook.recent(15);
				const trim = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
				const lines = rows.map(r =>
					`\`#${r.id}\` **${trim(r.name, 40)}** <t:${Math.floor(r.created_at / 1000)}:d> — ${trim(r.message.replace(/\s+/g, " "), 80)}`);
				return void i.reply({
					content: lines.length ? `${Guestbook.count()} total, newest first:\n${lines.join("\n")}` : "Guestbook is empty.",
					...eph, allowedMentions: { parse: [] },
				});
			}
			const id = i.options.getInteger("id", true);
			const row = Guestbook.get(id);
			if (!row) return void i.reply({ content: `No guestbook entry #${id}.`, ...eph });
			if (sub === "delete") {
				Guestbook.remove(id);
				await sites.regenerateHub();
				return void i.reply({ content: `🗑️ Deleted guestbook entry #${id} by **${row.name}**.`, ...eph, allowedMentions: { parse: [] } });
			}
			const n = Guestbook.removeByIpHash(row.ip_hash);
			await sites.regenerateHub();
			return void i.reply({ content: `🗑️ Purged ${n} entr${n === 1 ? "y" : "ies"} sharing #${id}'s IP.`, ...eph });
		}

		if (sub === "menu" || sub === "directory") {
			if (!(i.channel instanceof TextChannel)) return void i.reply({ content: "Run this in a text channel.", ...eph });
			await i.deferReply(eph);
			await publishMenu(menus.get(sub === "menu" ? "sitemenu" : "directory")!, i.channel);
			return void i.editReply(sub === "menu" ? "Menu posted." : "Directory posted.");
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
