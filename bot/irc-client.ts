// A deliberately small IRC client: just what the Discord bridge needs to talk to
// our own Ergo over loopback. Handles CAP/SASL PLAIN, PING, reconnect with backoff,
// and tracks whether we hold ops in the bridged channel (RELAYMSG needs it).
import net from "node:net";
import tls from "node:tls";
import { EventEmitter } from "node:events";

export type IrcLine = { tags: Record<string, string>; nick: string; command: string; params: string[] };

export function parseLine(raw: string): IrcLine {
	let s = raw;
	const tags: Record<string, string> = {};
	if (s.startsWith("@")) {
		const sp = s.indexOf(" ");
		for (const kv of s.slice(1, sp).split(";")) {
			const eq = kv.indexOf("=");
			if (eq === -1) tags[kv] = "";
			else tags[kv.slice(0, eq)] = kv.slice(eq + 1);
		}
		s = s.slice(sp + 1).trimStart();
	}
	let nick = "";
	if (s.startsWith(":")) {
		const sp = s.indexOf(" ");
		nick = s.slice(1, sp).split("!")[0]!;
		s = s.slice(sp + 1).trimStart();
	}
	const params: string[] = [];
	while (s.length) {
		if (s.startsWith(":")) { params.push(s.slice(1)); break; }
		const sp = s.indexOf(" ");
		if (sp === -1) { params.push(s); break; }
		params.push(s.slice(0, sp));
		s = s.slice(sp + 1).trimStart();
	}
	const command = (params.shift() ?? "").toUpperCase();
	return { tags, nick, command, params };
}

export type IrcOptions = {
	host: string;
	port: number;
	tls: boolean;
	nick: string;
	/** SASL/NickServ password. With one set, the client registers its account on first connect. */
	password: string;
	channel: string;
};

/**
 * Events:
 *  - "message" (nick, target, text, isAction) for PRIVMSG/CTCP ACTION
 *  - "ready" once joined to the channel
 *  - "line" (IrcLine) for everything, for debugging
 */
export class IrcClient extends EventEmitter {
	sock: net.Socket | null = null;
	nick: string;
	registered = false;
	loggedIn = false;
	/** Do we have +o (or higher) in the channel? */
	isOp = false;
	/** Server offers draft/relaymsg; value is the separator list (e.g. "/"). */
	relaySeparators = "";
	private buf = "";
	private backoff = 5_000;
	private stopped = false;
	private lastSeen = Date.now();
	private pinger: ReturnType<typeof setInterval> | null = null;
	private joined = false;
	private claimedChannel = false;

	constructor(public opts: IrcOptions) {
		super();
		this.nick = opts.nick;
	}

	get connected() { return this.registered && !!this.sock && !this.sock.destroyed; }
	get canRelay() { return this.connected && this.isOp && this.relaySeparators.includes("/"); }

	start() {
		this.stopped = false;
		this.connect();
	}

	stop() {
		this.stopped = true;
		this.send("QUIT :bridge shutting down");
		this.sock?.end();
	}

	/** Send one raw line. CR/LF in any argument is stripped so nothing can inject a second command. */
	send(line: string) {
		if (!this.sock || this.sock.destroyed) return;
		this.sock.write(line.replace(/[\r\n\0]/g, " ") + "\r\n");
	}

	privmsg(target: string, text: string) { this.send(`PRIVMSG ${target} :${text}`); }
	relaymsg(target: string, asNick: string, text: string) { this.send(`RELAYMSG ${target} ${asNick} :${text}`); }

	private connect() {
		const { host, port } = this.opts;
		this.registered = this.loggedIn = this.isOp = this.joined = this.claimedChannel = false;
		this.relaySeparators = "";
		this.nick = this.opts.nick;
		this.buf = "";
		const sock = this.opts.tls ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
		this.sock = sock;
		sock.setEncoding("utf8");
		sock.on(this.opts.tls ? "secureConnect" : "connect", () => {
			this.lastSeen = Date.now();
			this.send("CAP LS 302");
			this.send(`NICK ${this.nick}`);
			this.send(`USER ${this.opts.nick} 0 * :unixcore discord bridge`);
		});
		sock.on("data", (chunk: string) => {
			this.lastSeen = Date.now();
			this.buf += chunk;
			let i;
			while ((i = this.buf.indexOf("\n")) !== -1) {
				const raw = this.buf.slice(0, i).replace(/\r$/, "");
				this.buf = this.buf.slice(i + 1);
				if (raw) this.handle(parseLine(raw));
			}
		});
		sock.on("error", (e: Error) => console.warn(`[irc] socket error: ${e.message}`));
		sock.on("close", () => {
			if (this.pinger) clearInterval(this.pinger);
			this.pinger = null;
			const wasUp = this.registered;
			this.registered = false;
			if (this.stopped) return;
			if (wasUp) this.backoff = 5_000;
			console.warn(`[irc] disconnected, retrying in ${this.backoff / 1000}s`);
			setTimeout(() => this.connect(), this.backoff);
			this.backoff = Math.min(this.backoff * 2, 120_000);
		});
		// Notice a dead link even when the kernel doesn't.
		this.pinger = setInterval(() => {
			if (Date.now() - this.lastSeen > 180_000) { console.warn("[irc] ping timeout"); sock.destroy(); }
			else if (this.registered) this.send(`PING :${Date.now()}`);
		}, 60_000);
	}

	/**
	 * Once logged in and in the channel: register it to our account. Harmless if it's
	 * already ours; makes us founder (and so op) if nobody owns it. Then ask for ops
	 * in case we joined a channel that already had people in it.
	 */
	private claimChannel() {
		if (!this.joined || !this.loggedIn || this.claimedChannel) return;
		this.claimedChannel = true;
		this.privmsg("ChanServ", `REGISTER ${this.opts.channel}`);
		this.privmsg("ChanServ", `OP ${this.opts.channel}`);
	}

	private handle(m: IrcLine) {
		this.emit("line", m);
		const p = m.params;
		switch (m.command) {
			case "PING": this.send(`PONG :${p[0] ?? ""}`); break;

			case "CAP": {
				const sub = p[1];
				if (sub === "LS") {
					const more = p[2] === "*";
					const caps = (more ? p[3] : p[2]) ?? "";
					for (const c of caps.split(" ")) {
						const [name, val = ""] = c.split("=");
						if (name === "draft/relaymsg") this.relaySeparators = val || "/";
					}
					if (more) break;
					const want = ["message-tags", "server-time"];
					if (this.relaySeparators) want.push("draft/relaymsg");
					if (this.opts.password && /(^| )sasl(=| |$)/.test(caps + " ")) want.push("sasl");
					this.send(`CAP REQ :${want.join(" ")}`);
				} else if (sub === "ACK") {
					if (p[2]?.split(" ").includes("sasl")) this.send("AUTHENTICATE PLAIN");
					else this.send("CAP END");
				} else if (sub === "NAK") this.send("CAP END");
				break;
			}
			case "AUTHENTICATE":
				if (p[0] === "+") {
					const { nick, password } = this.opts;
					this.send(`AUTHENTICATE ${Buffer.from(`${nick}\0${nick}\0${password}`).toString("base64")}`);
				}
				break;
			case "900": this.loggedIn = true; this.claimChannel(); break; // RPL_LOGGEDIN (SASL or after NickServ REGISTER)
			case "903": this.send("CAP END"); break;            // SASL success
			case "904": case "905": case "906":                 // SASL failed: account probably doesn't exist yet
				this.send("CAP END"); break;

			case "001":
				this.registered = true;
				this.nick = p[0] ?? this.nick;
				console.log(`[irc] connected to ${this.opts.host}:${this.opts.port} as ${this.nick}${this.loggedIn ? " (logged in)" : ""}`);
				if (this.opts.password && !this.loggedIn) {
					// First run: create the bridge's account so it can found the channel.
					this.privmsg("NickServ", `REGISTER ${this.opts.password}`);
				}
				this.send(`JOIN ${this.opts.channel}`);
				break;
			case "433": // nick in use (only before registration completes)
				if (!this.registered) { this.nick += "_"; this.send(`NICK ${this.nick}`); }
				break;
			case "NICK":
				if (m.nick === this.nick) this.nick = p[0]!;
				break;

			case "JOIN":
				if (m.nick === this.nick && eq(p[0], this.opts.channel)) {
					this.joined = true;
					this.claimChannel();
					this.emit("ready");
				}
				break;
			case "353": { // NAMES: "= #chan :~nick @other"
				if (!eq(p[2], this.opts.channel)) break;
				for (const n of (p[3] ?? "").split(" ")) {
					const bare = n.replace(/^[~&@%+]+/, "");
					if (bare === this.nick) this.isOp = /^[~&@]/.test(n);
				}
				break;
			}
			case "MODE":
				// Something changed modes involving us: re-read NAMES rather than parse mode strings.
				if (eq(p[0], this.opts.channel) && p.slice(2).includes(this.nick)) this.send(`NAMES ${this.opts.channel}`);
				break;
			case "KICK":
				if (eq(p[0], this.opts.channel) && p[1] === this.nick) {
					this.isOp = false;
					setTimeout(() => this.send(`JOIN ${this.opts.channel}`), 10_000);
				}
				break;
			case "NOTICE":
				if (m.nick === "NickServ" || m.nick === "ChanServ") {
					console.log(`[irc] ${m.nick}: ${p[1]}`);
					// Ergo confirms a fresh NickServ REGISTER with this notice, not RPL_LOGGEDIN.
					if (m.nick === "NickServ" && /now logged in/i.test(p[1] ?? "")) {
						this.loggedIn = true;
						this.claimChannel();
					}
					// ChanServ REGISTER/OP answered: re-check whether we hold ops.
					if (m.nick === "ChanServ") this.send(`NAMES ${this.opts.channel}`);
				}
				break;
			case "FAIL":
				console.warn(`[irc] FAIL ${p.join(" ")}`);
				if (p[0] === "RELAYMSG") { this.isOp = false; this.send(`NAMES ${this.opts.channel}`); }
				break;

			case "PRIVMSG": {
				const [target, text = ""] = p;
				if (!target) break;
				const action = text.match(/^\x01ACTION (.*?)\x01?$/);
				if (text.startsWith("\x01") && !action) break; // other CTCP: ignore
				this.emit("message", m.nick, target, action ? action[1]! : text, !!action);
				break;
			}
			case "ERROR":
				console.warn(`[irc] server error: ${p.join(" ")}`);
				break;
		}
	}
}

const eq = (a: string | undefined, b: string) => a?.toLowerCase() === b.toLowerCase();
