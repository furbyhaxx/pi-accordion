import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { configPathForHome } from "./settings";
import { SettingsStore, type SettingsFlags } from "./settingsStore";

let home: string;
let file: string;
beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "accordion-settings-store-"));
	file = configPathForHome(home);
	fs.mkdirSync(path.dirname(file));
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));
const write = (data: unknown) => fs.writeFileSync(file, JSON.stringify(data));
const read = () => JSON.parse(fs.readFileSync(file, "utf8"));

describe("revisioned settings store", () => {
	test("invalid isolation ports stay disabled while native flags still take precedence", () => {
		const env = { ACCORDION_DOOR_PORT: "invalid" };
		const isolated = new SettingsStore(home, env);
		expect(isolated.current().settings.doorPort).toBe(0);
		expect(isolated.current().sources.doorPort).toBe("env");
		const flagged = new SettingsStore(home, env, () => ({ doorPort: "23456" }));
		expect(flagged.current().settings.doorPort).toBe(23456);
		expect(flagged.current().sources.doorPort).toBe("flag");
	});
	test("saves only explicit edits, never persisting runtime overrides or defaults", async () => {
		const store = new SettingsStore(home, { ACCORDION_PORT: "1234", ACCORDION_TOKEN: "private-token" });
		const base = store.current();
		expect(base.rev).toBe("");
		expect(base.sources.doorPort).toBe("env");
		expect(base.sources.autoArm).toBe("default");
		const result = await store.save({ autoArm: false }, base.rev);
		expect(result.ok).toBe(true);
		expect(read()).toEqual({ autoArm: false });
		expect(store.current().settings.doorPort).toBe(1234);
		expect(store.current().sources.autoArm).toBe("file");
		expect(store.current().rev).toBe(crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"));
		if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
		expect(fs.readdirSync(path.dirname(file)).filter(name => name.endsWith(".tmp"))).toEqual([]);
	});

	test("merges stale disjoint edits while preserving unrelated and unknown file content", async () => {
		write({ autoArm: true, future: { key: "keep" }, taskWidget: { maxRows: 12, future: "also keep" } });
		const first = new SettingsStore(home, {});
		const second = new SettingsStore(home, {});
		const base = first.current().rev;
		expect((await first.save({ autoArm: false }, base)).ok).toBe(true);
		expect((await second.save({ "taskWidget.maxRows": 20 }, base)).ok).toBe(true);
		expect(read()).toEqual({ autoArm: false, future: { key: "keep" }, taskWidget: { maxRows: 20, future: "also keep" } });
		expect(first.poll()).toEqual(["taskWidget.maxRows"]);
		expect(first.poll()).toEqual([]);
		expect(first.current()).toEqual(second.current());
	});

	test("conflicting multi-field saves are atomic and do not advance the local cache", async () => {
		write({ taskWidget: { maxRows: 12 } });
		const first = new SettingsStore(home, {});
		const second = new SettingsStore(home, {});
		const base = first.current();
		expect((await first.save({ "taskWidget.maxRows": 20 }, base.rev)).ok).toBe(true);
		const bytes = fs.readFileSync(file, "utf8");
		const conflict = await second.save({ autoArm: false, "taskWidget.maxRows": 25 }, base.rev);
		expect(conflict).toEqual({ ok: false, error: "taskWidget.maxRows: changed on disk; reload before saving", conflict: true });
		expect(fs.readFileSync(file, "utf8")).toBe(bytes);
		expect(second.current()).toEqual(base);
		expect(second.poll()).toEqual(["taskWidget.maxRows"]);
		const unknown = await second.save({ autoArm: false }, "unknown-revision");
		expect(unknown.ok).toBe(false);
		if (!unknown.ok) expect(unknown.conflict).toBe(true);
	});

	test("preserves older baselines through polls and isolates staged snapshot mutation", async () => {
		write({ autoArm: true, taskWidget: { maxRows: 12 } });
		const store = new SettingsStore(home, {});
		const draft = store.current();
		draft.settings.taskWidget.maxRows = 99;
		expect(store.current().settings.taskWidget.maxRows).toBe(12);
		write({ autoArm: false, taskWidget: { maxRows: 12 } });
		store.poll();
		write({ autoArm: false, debug: true, taskWidget: { maxRows: 12 } });
		store.poll();
		expect((await store.save({ "taskWidget.maxRows": 20 }, draft.rev)).ok).toBe(true);
		expect(read()).toEqual({ autoArm: false, debug: true, taskWidget: { maxRows: 20 } });
	});

	test("reports flag over env over file provenance and rejects locked edits", async () => {
		write({ bindHost: "localhost", doorPort: 1234, customToken: "file-token", autoArm: true });
		let flags: SettingsFlags = { doorPort: "4567" };
		const store = new SettingsStore(home, { ACCORDION_DOOR_PORT: "2345", ACCORDION_PORT: "3456", ACCORDION_AUTO_ARM: "false" }, () => flags);
		expect(store.current().settings.doorPort).toBe(4567);
		expect(store.current().sources).toMatchObject({ autoArm: "env", doorPort: "flag", bindHost: "file", customToken: "file", debug: "default" });
		const result = await store.save({ doorPort: 5678 }, store.current().rev);
		expect(result).toEqual({ ok: false, error: "doorPort: controlled by an active flag; remove that override before editing" });
		expect(read().doorPort).toBe(1234);
		flags = {};
		expect(store.poll()).toEqual(["doorPort"]);
		expect(store.current().settings.doorPort).toBe(2345);
		expect(store.current().sources.doorPort).toBe("env");
		expect((await store.save({ autoArm: true }, store.current().rev)).ok).toBe(false);
	});

	test("migrates the legacy policy without persisting an env override", async () => {
		write({ compactMode: "suppress", future: true });
		const store = new SettingsStore(home, { ACCORDION_COMPACT_MODE: "native" });
		expect(store.current().settings.compact).toEqual({ manual: "native", threshold: "native", onSaturated: "native" });
		expect(store.current().sources["compact.threshold"]).toBe("env");
		expect((await store.save({ "compact.manual": "pass" }, store.current().rev)).ok).toBe(false);
		expect((await store.save({ debug: true }, store.current().rev)).ok).toBe(true);
		expect(read()).toEqual({ compact: { manual: "pass", threshold: "pass", onSaturated: "warn" }, future: true, debug: true });
	});

	test("validates against the latest file and never rewrites invalid input", async () => {
		write({ taskfold: { high: 0.8, low: 0.6 } });
		const store = new SettingsStore(home, {});
		const base = store.current().rev;
		write({ taskfold: { high: 0.5, low: 0.4 } });
		const bytes = fs.readFileSync(file, "utf8");
		expect(await store.save({ "taskfold.low": 0.6 }, base)).toEqual({ ok: false, error: "taskfold.low: must be less than taskfold.high" });
		expect(await store.save({ doorPort: -1 }, base)).toEqual({ ok: false, error: "doorPort: must be an integer between 0 and 65535" });
		expect(fs.readFileSync(file, "utf8")).toBe(bytes);
	});

	test("edits and removes opaque model keys and consent without splitting dots", async () => {
		const store = new SettingsStore(home, {});
		const saved = await store.save({ "modelDefaults.openai/gpt-6.1.budget": "85%", "models.conductors.taskfold.chat": "current", "privacyConsent.taskfold-chat-v1": "2026-11-12T03:00:00+01:00" }, store.current().rev);
		expect(saved.ok).toBe(true);
		expect(read()).toEqual({ modelDefaults: { "openai/gpt-6.1": { budget: "85%" } }, models: { conductors: { taskfold: { chat: "current" } } }, privacyConsent: { "taskfold-chat-v1": "2026-11-12T03:00:00+01:00" } });
		const observer = new SettingsStore(home, {});
		expect((await store.save({ "modelDefaults.openai/gpt-6.1.budget": undefined, "models.conductors.taskfold.chat": undefined, "privacyConsent.taskfold-chat-v1": undefined }, store.current().rev)).ok).toBe(true);
		expect(read()).toEqual({});
		expect(observer.poll().sort()).toEqual(["modelDefaults.openai/gpt-6.1.budget", "models.conductors.taskfold.chat", "privacyConsent.taskfold-chat-v1"].sort());
	});

	test("refuses broken files without leaking their content or resetting the valid cache", async () => {
		write({ autoArm: false });
		const store = new SettingsStore(home, {});
		const base = store.current();
		fs.writeFileSync(file, '{"customToken":"do-not-echo-this-token"');
		expect(() => store.poll()).toThrow("config.json is not valid JSON");
		expect(store.current()).toEqual(base);
		const result = await store.save({ autoArm: true }, base.rev);
		expect(result).toEqual({ ok: false, error: "config.json is not valid JSON; repair it before saving" });
		expect(() => new SettingsStore(home, {})).toThrow("config.json is not valid JSON");
		expect(fs.readFileSync(file, "utf8")).toContain("do-not-echo-this-token");
	});

	test("waits for a real lock holder and rereads its committed changes", async () => {
		const store = new SettingsStore(home, {});
		const holder = new DatabaseSync(`${file}.lock.sqlite`);
		holder.exec("BEGIN IMMEDIATE");
		let held = true;
		const timer = setTimeout(() => { write({ debug: true }); holder.close(); held = false; }, 40);
		try {
			expect((await store.save({ autoArm: false }, store.current().rev)).ok).toBe(true);
			expect(read()).toEqual({ debug: true, autoArm: false });
		} finally { clearTimeout(timer); if (held) holder.close(); }
	});

	test("independent processes merge concurrent saves from the same revision", async () => {
		write({ future: "retain" });
		const go = path.join(home, "go");
		const processes = [{ autoArm: false }, { "taskWidget.maxRows": 20 }].map((patch, index) => {
			const script = `import { SettingsStore } from ${JSON.stringify(new URL("./settingsStore.ts", import.meta.url).href)};
const store = new SettingsStore(${JSON.stringify(home)}, {});
const rev = store.current().rev;
await Bun.write(${JSON.stringify(path.join(home, `ready-${index}`))}, "ready");
while (!(await Bun.file(${JSON.stringify(go)}).exists())) await Bun.sleep(2);
console.log(JSON.stringify(await store.save(${JSON.stringify(patch)}, rev)));`;
			return Bun.spawn([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe" });
		});
		try {
			const deadline = Date.now() + 3000;
			while (![0, 1].every(index => fs.existsSync(path.join(home, `ready-${index}`)))) {
				if (Date.now() >= deadline) throw new Error("Settings writers did not reach the shared baseline");
				await Bun.sleep(5);
			}
			fs.writeFileSync(go, "go");
			for (const process of processes) {
				expect(await process.exited).toBe(0);
				expect(JSON.parse(await new Response(process.stdout).text()).ok).toBe(true);
			}
			expect(read()).toEqual({ future: "retain", autoArm: false, taskWidget: { maxRows: 20 } });
		} finally {
			for (const process of processes) { process.kill(); await process.exited; }
		}
	});
});
