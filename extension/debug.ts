import * as fs from "node:fs/promises";
import * as path from "node:path";
import { gzip } from "node:zlib";
import { promisify } from "node:util";

/** A session-local diagnostic event; callers must omit credentials. */
export interface DebugRecord {
	type: "request" | "epoch" | "fold" | "complete" | "tasks" | "truth" | "route-retry" | "cache-profile";
	[key: string]: unknown;
}

/** Buffered private JSONL diagnostics, written only after yielding off the calling hook. */
export class DebugLog {
	readonly file: string;
	private pending: string[] = [];
	private pendingBytes = 0;
	private scheduled: Promise<void> | null = null;
	private failure: Error | null = null;

	constructor(directory: string, session: string, private readonly cap = 50 * 1024 * 1024) {
		this.file = path.join(directory, `${encodeURIComponent(session)}.jsonl`);
	}

	/** Queue an event without doing filesystem work on the caller's stack. */
	record(record: DebugRecord): void {
		const line = JSON.stringify({ ...record, time: new Date().toISOString() }) + "\n";
		const bytes = Buffer.byteLength(line);
		if (bytes > this.cap) { this.failure = new Error("Debug record exceeds the session log cap"); return; }
		this.pending.push(line);
		this.pendingBytes += bytes;
		while (this.pendingBytes > this.cap) this.pendingBytes -= Buffer.byteLength(this.pending.shift()!);
		this.schedule();
	}

	private schedule(): void {
		if (this.scheduled) return;
		this.scheduled = new Promise<void>((resolve) => setImmediate(resolve)).then(() => this.drain()).catch((error: unknown) => {
			this.failure = error instanceof Error ? error : new Error(String(error));
			this.pending = [];
			this.pendingBytes = 0;
		}).finally(() => {
			this.scheduled = null;
			if (this.pending.length) this.schedule();
		});
	}

	/** Wait for queued writes and report any write failure to the owner. */
	async flush(): Promise<void> {
		while (this.scheduled) await this.scheduled;
		if (this.failure) throw this.failure;
	}

	private async drain(): Promise<void> {
		await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
		const handle = await fs.open(this.file, "a+", 0o600);
		try {
			await handle.chmod(0o600);
			while (this.pending.length) {
				const batch = this.pending.join("");
				this.pending = [];
				this.pendingBytes = 0;
				await handle.appendFile(batch, "utf8");
				const { size } = await handle.stat();
				if (size > this.cap) {
					const tail = Buffer.alloc(Math.min(size, Math.floor(this.cap / 2)));
					await handle.read(tail, 0, tail.length, size - tail.length);
					const newline = tail.indexOf(10);
					const keep = newline < 0 ? Buffer.alloc(0) : tail.subarray(newline + 1);
					await handle.truncate(0);
					await handle.appendFile(keep);
				}
			}
		} finally { await handle.close(); }
	}
}

/** Restore the latest session override without changing the global default. */
export function debugOverrideOf(entries: readonly { type?: string; customType?: string; data?: unknown }[]): boolean | null {
	let value: boolean | null = null;
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== "accordion.debug") continue;
		const data = entry.data as { enabled?: unknown } | undefined;
		if (typeof data?.enabled === "boolean") value = data.enabled;
	}
	return value;
}

/** Write a gzip JSON archive with named files; never overwrite an existing destination. */
export async function writeDebugBundle(file: string, log: DebugLog, transcript: string, settings: object): Promise<void> {
	await log.flush();
	let jsonl = "";
	try { jsonl = await fs.readFile(log.file, "utf8"); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	const files = {
		"debug.jsonl": jsonl,
		"transcript.txt": transcript,
		"settings.json": JSON.stringify({ ...settings, customToken: "[REDACTED]" }, null, 2),
	};
	const bytes = await promisify(gzip)(JSON.stringify({ format: "accordion-debug-v1", files }));
	await fs.writeFile(file, bytes, { flag: "wx", mode: 0o600 });
}
