import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

/** A synchronous action's result, or the reason its sidecar mutex could not be used. */
export type SidecarLockResult<T> =
	| { readonly status: "done"; readonly value: T }
	| { readonly status: "busy" }
	| { readonly status: "failed"; readonly error: unknown };

/** Run a synchronous action under `filePath.lock.sqlite`; never replace or unlink that sidecar. */
export function withSidecarLock<T>(filePath: string, action: () => T): SidecarLockResult<T> {
	let db: DatabaseSync | undefined;
	let acquired = false;
	let result: SidecarLockResult<T>;
	try {
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		db = new DatabaseSync(`${filePath}.lock.sqlite`);
		db.exec("BEGIN IMMEDIATE");
		acquired = true;
		result = { status: "done", value: action() };
	} catch (error) {
		result = !acquired && error instanceof Error && "errcode" in error && error.errcode === 5
			? { status: "busy" }
			: { status: "failed", error };
	} finally {
		try { db?.close(); } catch (error) { result = { status: "failed", error }; }
	}
	return result;
}

/** Retry busy locks every 25 ms, for two seconds by default, while the caller remains active. */
export async function withSidecarLockRetry<T>(
	filePath: string,
	action: () => T,
	options: { readonly timeoutMs?: number; readonly active?: () => boolean } = {},
): Promise<SidecarLockResult<T> | { readonly status: "cancelled" }> {
	const deadline = Date.now() + (options.timeoutMs ?? 2000);
	const active = options.active ?? (() => true);
	while (active() && Date.now() < deadline) {
		const result = withSidecarLock(filePath, action);
		if (result.status !== "busy") return result;
		await new Promise<void>((resolve) => setTimeout(resolve, 25));
	}
	return active() ? { status: "busy" } : { status: "cancelled" };
}
