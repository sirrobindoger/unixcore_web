// /irc on|off|status: lets the unix team switch the IRC server off and back on.
// The bot can't touch systemd itself (it runs unprivileged), so it writes the
// switch file and infra/ergo-toggle.path (root) starts or stops Ergo to match.
import fs from "node:fs/promises";
import path from "node:path";
import {
	type ChatInputCommandInteraction, type GuildMember, MessageFlags, PermissionFlagsBits, SlashCommandBuilder,
} from "discord.js";
import type { DiscordCommand } from "../bot";
import { config } from "../config";
import { bridgeIrc } from "../irc";

const eph = { flags: MessageFlags.Ephemeral } as const;

/** "active" | "inactive" | "failed" | ..., or "unknown" where there's no systemd (local dev). */
function ergoState(): string {
	try {
		const r = Bun.spawnSync(["systemctl", "is-active", "ergo"]);
		return r.stdout.toString().trim() || "unknown";
	} catch {
		return "unknown";
	}
}

async function readSwitch(): Promise<"on" | "off"> {
	const s = await fs.readFile(config.irc.stateFile, "utf8").catch(() => "on");
	return s.trim() === "off" ? "off" : "on";
}

async function writeSwitch(v: "on" | "off") {
	await fs.mkdir(path.dirname(config.irc.stateFile), { recursive: true });
	await fs.writeFile(config.irc.stateFile, v + "\n");
}

/** Wait (up to ~15s) for systemd to bring Ergo to the wanted state. */
async function waitFor(want: "active" | "inactive"): Promise<string> {
	let s = ergoState();
	for (let n = 0; n < 30 && s !== want && s !== "unknown"; n++) {
		await Bun.sleep(500);
		s = ergoState();
	}
	return s;
}

function allowed(i: ChatInputCommandInteraction): boolean {
	const m = i.member as GuildMember | null;
	if (!m) return false;
	if (m.permissions.has(PermissionFlagsBits.Administrator)) return true;
	return !!config.irc.adminRole && m.roles.cache.has(config.irc.adminRole);
}

const Irc: DiscordCommand = {
	data: new SlashCommandBuilder()
		.setName("irc")
		.setDescription("The unixcore IRC server (irc.unixcore.sh)")
		.addSubcommand(s => s.setName("status").setDescription("Is the IRC server running?"))
		.addSubcommand(s => s.setName("off").setDescription("Shut the IRC server off (unix team)"))
		.addSubcommand(s => s.setName("on").setDescription("Turn the IRC server back on (unix team)")),

	execute: async i => {
		const sub = i.options.getSubcommand();
		const state = ergoState();
		const sw = await readSwitch();

		if (sub === "status") {
			const running = state === "active" ? "running" : state === "unknown" ? "in an unknown state" : "off";
			const note = sw === "off" ? " It was switched off with `/irc off`." : "";
			return void i.reply({ content: `The IRC server is ${running}.${note}`, ...eph });
		}

		if (!allowed(i)) return void i.reply({ content: "Only the unix team can switch IRC on or off.", ...eph });

		if (sub === "off") {
			if (sw === "off" && state !== "active") return void i.reply({ content: "IRC is already off.", ...eph });
			await i.deferReply();
			// Tell IRC people before the server goes away.
			if (bridgeIrc?.connected)
				for (const ch of config.irc.links.map(l => l.ircChannel))
					bridgeIrc.privmsg(ch, `the irc server is being switched off by the unix team (${i.user.username}).`);
			await Bun.sleep(500);
			await writeSwitch("off");
			const now = await waitFor("inactive");
			return void i.editReply({ allowedMentions: { parse: [] }, content: now === "inactive" || now === "unknown"
				? `IRC server switched off by ${i.user}. \`/irc on\` brings it back.`
				: `Asked the IRC server to stop, but it still reports \`${now}\`. Check \`journalctl -u ergo-toggle\` on the box.` });
		}

		// on
		if (sw === "on" && state === "active") return void i.reply({ content: "IRC is already on.", ...eph });
		await i.deferReply();
		await writeSwitch("on");
		const now = await waitFor("active");
		bridgeIrc?.reconnectNow();
		return void i.editReply({ allowedMentions: { parse: [] }, content: now === "active" || now === "unknown"
			? `IRC server switched on by ${i.user}: irc.unixcore.sh, port 6697 (tls).`
			: `Asked the IRC server to start, but it reports \`${now}\`. Check \`journalctl -u ergo\` on the box.` });
	},
};

export default Irc;
