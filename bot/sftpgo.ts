// Minimal client for the SFTPGo REST API (v2). Admin token is fetched with
// basic auth and cached until shortly before it expires.
import { config } from "./config";

export class SFTPGoError extends Error {
	constructor(public status: number, message: string) {
		super(message);
	}
}

export type SFTPGoUser = {
	id?: number;
	username: string;
	password?: string;
	public_keys?: string[];
	status: 0 | 1;
	home_dir: string;
	quota_size: number;
	quota_files: number;
	used_quota_size?: number;
	used_quota_files?: number;
	permissions: Record<string, string[]>;
	filters?: Record<string, unknown>;
	description?: string;
	[k: string]: unknown;
};

// SFTP-only, no symlinks (Caddy follows them) and no chmod/chown games.
const PERMS = ["list", "download", "upload", "overwrite", "delete", "rename", "create_dirs"];

let token: { value: string; expires: number } | null = null;

async function getToken(force = false): Promise<string> {
	if (!force && token && Date.now() < token.expires) return token.value;
	const res = await fetch(`${config.sftpgo.url}/api/v2/token`, {
		headers: { Authorization: "Basic " + btoa(`${config.sftpgo.admin}:${config.sftpgo.password}`) },
	});
	if (!res.ok) throw new SFTPGoError(res.status, `SFTPGo admin login failed (${res.status})`);
	const body = (await res.json()) as { access_token: string; expires_at: string };
	token = { value: body.access_token, expires: new Date(body.expires_at).getTime() - 60_000 };
	return token.value;
}

async function api<T = unknown>(method: string, path: string, body?: unknown, retry = true): Promise<T> {
	const res = await fetch(`${config.sftpgo.url}/api/v2${path}`, {
		method,
		headers: {
			Authorization: `Bearer ${await getToken()}`,
			"Content-Type": "application/json",
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	if (res.status === 401 && retry) {
		await getToken(true);
		return api<T>(method, path, body, false);
	}
	if (!res.ok) {
		let msg = `${method} ${path} → ${res.status}`;
		try {
			const j = (await res.json()) as { message?: string; error?: string };
			msg += `: ${j.message ?? j.error ?? ""}`;
		} catch {}
		throw new SFTPGoError(res.status, msg);
	}
	if (res.status === 204) return undefined as T;
	return (await res.json()) as T;
}

export const sftpgo = {
	async healthy(): Promise<boolean> {
		try {
			const r = await fetch(`${config.sftpgo.url}/healthz`);
			return r.ok;
		} catch {
			return false;
		}
	},

	async exists(username: string): Promise<boolean> {
		try {
			await api("GET", `/users/${encodeURIComponent(username)}`);
			return true;
		} catch (e) {
			if (e instanceof SFTPGoError && e.status === 404) return false;
			throw e;
		}
	},

	getUser: (username: string) =>
		api<SFTPGoUser>("GET", `/users/${encodeURIComponent(username)}`),

	createUser(opts: { username: string; password: string; homeDir: string; discordId: string; publicKeys?: string[] }) {
		const user: SFTPGoUser = {
			username: opts.username,
			password: opts.password,
			public_keys: opts.publicKeys ?? [],
			status: 1,
			home_dir: opts.homeDir,
			quota_size: config.quotaBytes,
			quota_files: 0,
			permissions: { "/": PERMS },
			filters: { max_upload_file_size: config.quotaBytes },
			description: `discord:${opts.discordId}`,
		};
		return api<SFTPGoUser>("POST", "/users", user);
	},

	// PUT replaces; permissions are reset server-side if omitted, so always
	// send the full object we just fetched.
	async updateUser(username: string, patch: Partial<SFTPGoUser>) {
		const current = await sftpgo.getUser(username);
		delete current.password; // GET returns it redacted; only send when changing
		await api("PUT", `/users/${encodeURIComponent(username)}`, { ...current, ...patch });
	},

	setPassword: (username: string, password: string) =>
		sftpgo.updateUser(username, { password }),

	// An empty list removes key login; the password keeps working either way.
	setPublicKeys: (username: string, keys: string[]) =>
		sftpgo.updateUser(username, { public_keys: keys }),

	setStatus: (username: string, status: 0 | 1) =>
		sftpgo.updateUser(username, { status }),

	deleteUser: (username: string) =>
		api("DELETE", `/users/${encodeURIComponent(username)}`),

	// Re-count disk usage (needed after the bot writes files outside SFTP).
	scanQuota: (username: string) =>
		api("POST", `/quotas/users/${encodeURIComponent(username)}/scan`),

	// Kick any open SFTP sessions for a user (used on suspend/delete).
	async disconnect(username: string) {
		const conns = await api<{ connection_id: string; username: string }[]>("GET", "/connections");
		await Promise.all(
			conns.filter(c => c.username === username)
				.map(c => api("DELETE", `/connections/${c.connection_id}`).catch(() => {})),
		);
	},
};
