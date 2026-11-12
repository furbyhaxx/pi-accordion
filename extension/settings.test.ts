import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	configPathForHome,
	generateMemorableToken,
	loadSettings,
	sanitizeCustomToken,
	VALID_DOOR_SECRET_RE,
	isLoopbackHost,
	isLoopbackUrl,
	resolveModelSpec,
	sanitizeModelSettings,
	sanitizeTaskfoldSettings,
} from "./settings";
import { settingParts, validateSetting, validateSettingsPatch } from "./settingsValidation";
import { SettingsStore } from "./settingsStore";

describe("accordion settings & memorable tokens", () => {
	test("generates 8-character pronounceable memorable tokens", () => {
		for (let i = 0; i < 20; i++) {
			const token = generateMemorableToken();
			expect(token).toHaveLength(8);
			expect(VALID_DOOR_SECRET_RE.test(token)).toBe(true);
			expect(/[01ilo]/i.test(token)).toBe(false);
		}
	});

	test("accepts both 8-char memorable tokens and legacy 64-hex secrets while rejecting garbage", () => {
		expect(VALID_DOOR_SECRET_RE.test("kave4ton")).toBe(true);
		expect(VALID_DOOR_SECRET_RE.test("ab".repeat(32))).toBe(true);
		expect(VALID_DOOR_SECRET_RE.test("")).toBe(false);
		expect(VALID_DOOR_SECRET_RE.test("deadbeef-not-a-valid-secret")).toBe(false);
	});

	test("loads file settings with env overrides", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "accordion-settings-"));
		try {
			const defaults = loadSettings(tmp, {});
			expect(defaults.debug).toBe(false);
			expect(defaults.autoArm).toBe(true);
			expect(defaults.defaultConductor).toBe("keel-lite");
			expect(defaults.compact).toEqual({ manual: "pass", threshold: "pass", onSaturated: "native" });
			expect(defaults.bindHost).toBe("127.0.0.1");

			const file = configPathForHome(tmp);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, JSON.stringify({
				debug: true,
				taskfold: { timing: "lazy", leafForm: "bracket", high: 0.9, low: 0.7, keepRecentTasks: 2, recordTokens: 2200, floor: true, untracked: { enabled: false, minSteps: 10 }, steps: { enabled: false, minSteps: 3 } },
				tasks: { attachments: { render: "reference", maxLines: 40, roots: ["/srv/kb"] }, pins: { listTokens: 1000, taskTokens: 500 }, adopt: "ask" },
				autoArm: false,
				defaultConductor: "keel-note",
				compact: { manual: "pass", threshold: "pass", onSaturated: "warn" },
				bindHost: "0.0.0.0",
				doorPort: 25000,
				customToken: "my-custom-8",
				models: { defaults: { classifier: "local/minilm" }, conductors: { taskfold: { chat: "current" } } },
				privacyConsent: { taskfold: "2026-05-01T10:00:00.000Z" },
				taskWidget: { mode: "off", expanded: true, maxRows: 20, toggleKey: "ctrl+alt+t" },
				modelDefaults: { "anthropic/*": { budget: "200k", protect: "20k" } },
			}));

			const loaded = loadSettings(tmp, {});
			expect(loaded).toEqual({
				debug: true,
				taskfold: { timing: "lazy", leafForm: "bracket", recordTokens: 2200, floor: true, untracked: { enabled: false, minSteps: 10 }, steps: { enabled: false, minSteps: 3 } },
				conductorOptions: { taskfold: { high: 0.9, low: 0.7, keepRecentTasks: 2 } },
				tasks: { attachments: { render: "reference", maxLines: 40, roots: ["/srv/kb"] }, pins: { listTokens: 1000, taskTokens: 500 }, adopt: "ask" },
				autoArm: false,
				defaultConductor: "keel-note",
				compact: { manual: "pass", threshold: "pass", onSaturated: "warn" },
				bindHost: "0.0.0.0",
				doorPort: 25000,
				customToken: "my-custom-8",
				models: { defaults: { classifier: "local/minilm" }, conductors: { taskfold: { chat: "current" } } },
				privacyConsent: { taskfold: "2026-05-01T10:00:00.000Z" },
				taskWidget: { mode: "off", expanded: true, maxRows: 20, toggleKey: "ctrl+alt+t" },
				modelDefaults: { "anthropic/*": { budget: "200k", protect: "20k" } },
			});

			const envOverridden = loadSettings(tmp, {
				ACCORDION_HOST: "100.64.0.1",
				ACCORDION_PORT: "26000",
				ACCORDION_TOKEN: "tailnet8",
				ACCORDION_AUTO_ARM: "true",
			});
			expect(envOverridden.bindHost).toBe("100.64.0.1");
			expect(envOverridden.doorPort).toBe(26000);
			expect(envOverridden.customToken).toBe("tailnet8");
			expect(envOverridden.autoArm).toBe(true);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	test.each([
		["accordion", { manual: "pass", threshold: "pass", onSaturated: "native" }],
		["suppress", { manual: "pass", threshold: "pass", onSaturated: "warn" }],
		["native", { manual: "native", threshold: "native", onSaturated: "native" }],
	] as const)("migrates legacy compaction %s and drops the old key on save", async (compactMode, compact) => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "accordion-compact-"));
		try {
			const file = configPathForHome(home);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, JSON.stringify({ compactMode }));
			const loaded = loadSettings(home, {});
			expect(loaded.compact).toEqual(compact);
			const store = new SettingsStore(home, {});
			expect((await store.save({ debug: true }, store.current().rev)).ok).toBe(true);
			const written = JSON.parse(fs.readFileSync(file, "utf8"));
			expect(written.compact).toEqual(compact);
			expect(written).not.toHaveProperty("compactMode");
			expect(loadSettings(home, {}).compact).toEqual(compact);
		} finally {
			fs.rmSync(home, { recursive: true, force: true });
		}
	});

	test("prefers compact over the old key and maps the legacy environment override", () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "accordion-compact-"));
		try {
			const file = configPathForHome(home);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			const compact = { manual: "native", threshold: "pass", onSaturated: "warn" };
			fs.writeFileSync(file, JSON.stringify({ compactMode: "suppress", compact }));
			expect(loadSettings(home, {}).compact).toEqual(compact);
			expect(loadSettings(home, { ACCORDION_COMPACT_MODE: "accordion" }).compact).toEqual({ manual: "pass", threshold: "pass", onSaturated: "native" });
			expect(loadSettings(home, { ACCORDION_COMPACT_MODE: "native" }).compact).toEqual({ manual: "native", threshold: "native", onSaturated: "native" });
			fs.writeFileSync(file, JSON.stringify({ compact: { manual: "bake", threshold: "invalid", onSaturated: "warn" } }));
			expect(loadSettings(home, {}).compact).toEqual({ manual: "bake", threshold: "pass", onSaturated: "warn" });
		} finally {
			fs.rmSync(home, { recursive: true, force: true });
		}
	});

	test("validates taskfold budget, age and untracked settings", () => {
		expect(sanitizeTaskfoldSettings({ timing: "pressure", leafForm: "bracket", recordTokens: 200, floor: true, untracked: { enabled: false, minSteps: 5 }, steps: { enabled: false, minSteps: 2 } })).toEqual({ timing: "pressure", leafForm: "bracket", recordTokens: 200, floor: true, untracked: { enabled: false, minSteps: 5 }, steps: { enabled: false, minSteps: 2 } });
		expect(sanitizeTaskfoldSettings({ untracked: { minSteps: 0 } })).toMatchObject({ untracked: { enabled: true, minSteps: 8 } });
		expect(sanitizeTaskfoldSettings({ timing: "fast" }).timing).toBe("eager");
		expect(sanitizeTaskfoldSettings({}).timing).toBe("eager");
		expect(sanitizeTaskfoldSettings({ leafForm: "invalid" }).leafForm).toBe("record");
		expect(sanitizeTaskfoldSettings({}).leafForm).toBe("record");
	});

	test("validates custom tokens and loopback hosts", () => {
		expect(sanitizeCustomToken("ab")).toBeNull();
		expect(sanitizeCustomToken("my-token-8")).toBe("my-token-8");
		expect(sanitizeCustomToken("bad space")).toBeNull();
		expect(isLoopbackHost("127.0.0.1")).toBe(true);
		expect(isLoopbackHost("localhost")).toBe(true);
		expect(isLoopbackHost("0.0.0.0")).toBe(false);
		expect(isLoopbackHost("100.64.1.2")).toBe(false);
	});
});

describe("model routing", () => {
	const models = sanitizeModelSettings({
		defaults: { chat: "openrouter/google/gemini-flash", classifier: "local/minilm" },
		conductors: { taskfold: { classifier: "local/deberta" }, bad: { classifier: "current" } },
	});

	test("request beats conductor override beats default", () => {
		expect(resolveModelSpec(models, "classifier", "taskfold", "x/y")).toBe("x/y");
		expect(resolveModelSpec(models, "classifier", "taskfold")).toBe("local/deberta");
		expect(resolveModelSpec(models, "classifier", "keel-lite")).toBe("local/minilm");
		expect(resolveModelSpec(models, "chat", "taskfold")).toBe("openrouter/google/gemini-flash");
		expect(resolveModelSpec(models, "classifier", "keel-lite", undefined, "tuned/model")).toBe("local/minilm");
	});

	test("a conductor's built-in default applies only when the user configured none", () => {
		const none = sanitizeModelSettings({});
		expect(resolveModelSpec(none, "classifier", "taskfold", undefined, "tuned/model")).toBe("tuned/model");
		expect(resolveModelSpec(none, "classifier", "taskfold", "x/y", "tuned/model")).toBe("x/y");
	});

	test("tries built-in defaults in order without overriding explicit configuration", () => {
		const none = sanitizeModelSettings({});
		const defaults = ["openai/gpt-6-luna", "openai-codex/gpt-6-luna"];
		expect(resolveModelSpec(none, "chat", "taskfold", undefined, defaults, () => true)).toBe(defaults[0]);
		expect(resolveModelSpec(none, "chat", "taskfold", undefined, defaults, (s) => s.startsWith("openai-codex/"))).toBe(defaults[1]);
		expect(resolveModelSpec(none, "chat", "taskfold", undefined, defaults, () => false)).toBe("current");
		expect(resolveModelSpec(models, "chat", "taskfold", undefined, defaults, () => false)).toBe("openrouter/google/gemini-flash");
		expect(resolveModelSpec(none, "chat", "taskfold", "custom/model", defaults, () => false)).toBe("custom/model");
	});

	test("chat falls back to the session model; a classifier has no fallback", () => {
		const none = sanitizeModelSettings({});
		expect(resolveModelSpec(none, "chat", null)).toBe("current");
		expect(resolveModelSpec(none, "classifier", null)).toBeNull();
		expect(models.conductors.bad).toBeUndefined();
		expect(() => resolveModelSpec(none, "chat", null, "no-slash")).toThrow(/invalid chat model spec/);
	});

	test("only loopback base URLs count as local", () => {
		expect(isLoopbackUrl("http://127.0.0.1:8080/v1")).toBe(true);
		expect(isLoopbackUrl("http://localhost:11434")).toBe(true);
		expect(isLoopbackUrl("https://openrouter.ai/api/v1")).toBe(false);
		expect(isLoopbackUrl(undefined)).toBe(false);
	});
});

describe("strict settings save validation", () => {
	test("accepts supported policies, boundary values and removals without coercion", () => {
		for (const [name, value] of Object.entries({
			"compact.manual": "bake", "compact.threshold": "pass", "compact.onSaturated": "warn",
			bindHost: "::", doorPort: 0, customToken: null, defaultConductor: "none",
			"taskWidget.maxRows": 100, "taskWidget.toggleKey": "ctrl+alt+t",
			"tasks.attachments.roots": ["/srv/knowledge", "~/notes"], "tasks.adopt": "ask",
			"models.defaults.chat": "current", "models.defaults.classifier": "local/my/model",
			"models.conductors.taskfold.chat": undefined, "privacyConsent.taskfold-chat-v1": undefined,
			"privacyConsent.taskfold": "2026-11-12T03:00:00+01:00",
			"modelDefaults.openai/gpt-6.1.budget": "85%", "modelDefaults.*.protect": "0",
			"modelDefaults.openai/*.timing": "pressure", "taskfold.timing": "lazy",
			"taskfold.leafForm": "bracket", "taskfold.recordTokens": 100000,
		})) expect(validateSetting(name, value)).toEqual({ ok: true });
	});

	test("invalid saves identify the field and rule instead of silently defaulting", () => {
		for (const [name, value, rule] of [
			["autoArm", "true", "boolean"], ["debug", null, "boolean"],
			["defaultConductor", "not-shipped", "registered conductor"],
			["compact.manual", "suppress", "one of"], ["compact.threshold", "bake", "one of"],
			["doorPort", "1234", "integer"], ["doorPort", 65536, "65535"], ["doorPort", NaN, "integer"],
			["bindHost", "https://host.test", "hostname"], ["bindHost", "host.test:1234", "hostname"],
			["bindHost", "", "hostname"], ["bindHost", "999.1.1.1", "hostname"],
			["customToken", "bad token", "URL-safe"], ["taskWidget.maxRows", 1.5, "integer"],
			["taskWidget.toggleKey", "escape", "key id"],
			["tasks.attachments.roots", ["relative/notes"], "absolute"],
			["tasks.attachments.maxLines", 0, "between"], ["tasks.pins.taskTokens", Infinity, "integer"],
			["models.defaults.chat", null, "provider/model-id"],
			["models.defaults.classifier", "current", "only valid for chat"],
			["models.conductors.taskfold.chat", "no-provider", "provider/model-id"],
			["modelDefaults.*.budget", "101%", "token amount"],
			["modelDefaults.*.protect", 20000, "token amount"],
			["privacyConsent.taskfold", "yesterday", "ISO timestamp"],
			["conductorOptions.taskfold.high", 0, "between"], ["conductorOptions.taskfold.low", 1, "between"],
			["conductorOptions.taskfold.keepRecentTasks", 1.5, "integer"], ["conductorOptions.taskfold.maxLoss", 3.1, "between"],
			["taskfold.untracked.minSteps", 0, "between"], ["taskfold.steps.enabled", 1, "boolean"],
			["taskfold.timing", "aggressive", "pressure"],
		] as const) {
			const result = validateSetting(name, value);
			expect(result.ok).toBe(false);
			if (!result.ok) { expect(result.error).toContain(`${name}:`); expect(result.error).toContain(rule); }
		}
	});

	test("validates coupled fields atomically, including one-field edits", () => {
		const current = structuredClone(loadSettings("/nonexistent/accordion-validation-home", {}));
		expect(validateSettingsPatch({ "conductorOptions.taskfold.high": 0.5 }, current)).toEqual({ ok: false, error: "conductorOptions.taskfold.low: must be less than conductorOptions.taskfold.high" });
		expect(validateSettingsPatch({ "conductorOptions.taskfold.high": 0.5, "conductorOptions.taskfold.low": 0.4 }, current)).toEqual({ ok: true });
		expect(validateSettingsPatch({ "conductorOptions.taskfold.low": 0.8 }, current)).toEqual({ ok: false, error: "conductorOptions.taskfold.low: must be less than conductorOptions.taskfold.high" });
		for (const invalid of [null, [], false]) expect(validateSettingsPatch(invalid, current).ok).toBe(false);
	});

	test("opaque dynamic keys preserve model punctuation and reject unsafe or unknown paths", () => {
		expect(settingParts("modelDefaults.openai/gpt-6.1.budget")).toEqual(["modelDefaults", "openai/gpt-6.1", "budget"]);
		expect(settingParts("models.conductors.example.v2.chat")).toEqual(["models", "conductors", "example.v2", "chat"]);
		for (const name of ["compactMode", "taskWidget.typo", "models.conductors.__proto__.chat", "privacyConsent.constructor", "modelDefaults.invalid.budget", "__proto__.polluted"]) {
			expect(validateSetting(name, true)).toEqual({ ok: false, error: `${name}: unknown setting` });
			expect(settingParts(name)).toBeUndefined();
		}
	});
});
