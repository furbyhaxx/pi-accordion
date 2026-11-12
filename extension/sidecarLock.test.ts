import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { withSidecarLock, withSidecarLockRetry } from "./sidecarLock";

let directory: string;
let target: string;
beforeEach(() => {
	directory = fs.mkdtempSync(path.join(os.tmpdir(), "accordion-sidecar-"));
	target = path.join(directory, "config.json");
});
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

describe("permanent sidecar mutex", () => {
	test("serializes writers and preserves the mutex inode across actions", () => {
		const first = withSidecarLock(target, () => {
			fs.writeFileSync(target, "first");
			const concurrent = withSidecarLock(target, () => fs.writeFileSync(target, "overwritten"));
			expect(concurrent.status).toBe("busy");
			return fs.readFileSync(target, "utf8");
		});
		expect(first).toEqual({ status: "done", value: "first" });
		const inode = fs.statSync(`${target}.lock.sqlite`).ino;
		const second = withSidecarLock(target, () => fs.appendFileSync(target, "+second"));
		expect(second.status).toBe("done");
		expect(fs.readFileSync(target, "utf8")).toBe("first+second");
		expect(fs.statSync(`${target}.lock.sqlite`).ino).toBe(inode);
	});

	test("returns the action's failure and releases the lock without retrying that action", async () => {
		const error = Object.assign(new Error("action failed"), { errcode: 5 });
		let calls = 0;
		const failed = await withSidecarLockRetry(target, () => { calls++; throw error; });
		expect(failed).toEqual({ status: "failed", error });
		expect(calls).toBe(1);
		expect(withSidecarLock(target, () => fs.writeFileSync(target, "recovered")).status).toBe("done");
		expect(fs.readFileSync(target, "utf8")).toBe("recovered");
	});

	test("preserves acquisition errors without executing the action", () => {
		fs.writeFileSync(target, "not a directory");
		let called = false;
		const result = withSidecarLock(path.join(target, "child"), () => { called = true; });
		expect(result.status).toBe("failed");
		if (result.status === "failed") expect(result.error).toBeInstanceOf(Error);
		expect(called).toBe(false);
	});

	test("waits for a competing writer and then performs the action once", async () => {
		const holder = new DatabaseSync(`${target}.lock.sqlite`);
		holder.exec("BEGIN IMMEDIATE");
		let held = true;
		const timer = setTimeout(() => { holder.close(); held = false; }, 40);
		let calls = 0;
		try {
			const result = await withSidecarLockRetry(target, () => {
				calls++;
				fs.writeFileSync(target, "after release");
				return fs.readFileSync(target, "utf8");
			}, { timeoutMs: 1000 });
			expect(result).toEqual({ status: "done", value: "after release" });
			expect(calls).toBe(1);
		} finally {
			clearTimeout(timer);
			if (held) holder.close();
		}
	});

	test("bounds contention and cancels inactive callers without writing", async () => {
		const holder = new DatabaseSync(`${target}.lock.sqlite`);
		holder.exec("BEGIN IMMEDIATE");
		let calls = 0;
		try {
			const action = () => { calls++; fs.writeFileSync(target, "unexpected"); };
			expect(await withSidecarLockRetry(target, action, { timeoutMs: 30 })).toEqual({ status: "busy" });
			expect(await withSidecarLockRetry(target, action, { active: () => false })).toEqual({ status: "cancelled" });
			expect(calls).toBe(0);
			expect(fs.existsSync(target)).toBe(false);
		} finally {
			holder.close();
		}
	});
});
