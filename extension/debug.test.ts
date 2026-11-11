import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DebugLog, debugOverrideOf, writeDebugBundle } from "./debug";
import { gunzipSync } from "node:zlib";

describe("private session diagnostics", () => {
	test("restores only valid overrides and bundles named files without the access token", async () => {
		expect(debugOverrideOf([])).toBeNull();
		expect(debugOverrideOf([
			{ type: "custom", customType: "accordion.debug", data: { enabled: true } },
			{ type: "custom", customType: "accordion.debug", data: { enabled: "false" } },
		])).toBe(true);
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "accordion-debug-"));
		try {
			const log = new DebugLog(dir, "bundle");
			log.record({ type: "truth", rev: 7 });
			const file = path.join(dir, "bundle.json.gz");
			await writeDebugBundle(file, log, "whole transcript", { debug: true, customToken: "private-token" });
			const raw = gunzipSync(fs.readFileSync(file)).toString("utf8");
			expect(raw).not.toContain("private-token");
			const bundle = JSON.parse(raw);
			expect(bundle.files["transcript.txt"]).toBe("whole transcript");
			expect(JSON.parse(bundle.files["debug.jsonl"])).toMatchObject({ rev: 7 });
			expect(fs.statSync(file).mode & 0o777).toBe(0o600);
			await expect(writeDebugBundle(file, log, "replacement", {})).rejects.toThrow();
		} finally { fs.rmSync(dir, { recursive: true, force: true }); }
	});
	test("defers I/O, preserves Unicode JSONL and writes mode 0600", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "accordion-debug-"));
		try {
			const log = new DebugLog(path.join(dir, "debug"), "session/one");
			log.record({ type: "truth", text: "日本語", rev: 3 });
			expect(fs.existsSync(log.file)).toBe(false);
			await log.flush();
			expect(JSON.parse(fs.readFileSync(log.file, "utf8"))).toMatchObject({ type: "truth", text: "日本語", rev: 3 });
			expect(fs.statSync(log.file).mode & 0o777).toBe(0o600);
		} finally { fs.rmSync(dir, { recursive: true, force: true }); }
	});

	test("drops the oldest half at the byte cap without partial JSON records", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "accordion-debug-"));
		try {
			const log = new DebugLog(dir, "cap", 1024);
			for (let i = 0; i < 30; i++) {
				log.record({ type: "epoch", index: i, text: "日本語".repeat(10) });
				await log.flush();
			}
			const bytes = fs.readFileSync(log.file);
			expect(bytes.length).toBeLessThanOrEqual(1024);
			const rows = bytes.toString("utf8").trim().split("\n").map((line) => JSON.parse(line));
			expect(rows.at(-1).index).toBe(29);
			expect(rows[0].index).toBeGreaterThan(0);
		} finally { fs.rmSync(dir, { recursive: true, force: true }); }
	});

	test("surfaces asynchronous write failures through flush", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "accordion-debug-"));
		try {
			fs.writeFileSync(path.join(dir, "not-a-directory"), "occupied");
			const log = new DebugLog(path.join(dir, "not-a-directory"), "error");
			log.record({ type: "truth" });
			await expect(log.flush()).rejects.toThrow();
		} finally { fs.rmSync(dir, { recursive: true, force: true }); }
	});
});
