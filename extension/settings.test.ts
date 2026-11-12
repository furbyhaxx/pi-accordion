import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	generateMemorableToken,
	loadSettings,
	saveSettings,
	sanitizeCustomToken,
	VALID_DOOR_SECRET_RE,
	isLoopbackHost,
	isLoopbackUrl,
	resolveModelSpec,
	sanitizeModelSettings,
	sanitizeTaskfoldSettings,
} from "./settings";

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

	test("persists and reloads settings with env overrides", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "accordion-settings-"));
		try {
			const defaults = loadSettings(tmp, {});
			expect(defaults.debug).toBe(false);
			expect(defaults.autoArm).toBe(true);
			expect(defaults.defaultConductor).toBe("keel-lite");
			expect(defaults.compactMode).toBe("accordion");
			expect(defaults.bindHost).toBe("127.0.0.1");

			saveSettings(tmp, {
				debug: true,
				taskfold: { timing: "lazy", leafForm: "bracket", high: 0.9, low: 0.7, keepRecentTasks: 2, recordTokens: 2200, floor: true, untracked: { enabled: false, minSteps: 10 }, steps: { enabled: false, minSteps: 3 } },
				tasks: { attachments: { render: "reference", maxLines: 40, roots: ["/srv/kb"] }, pins: { listTokens: 1000, taskTokens: 500 }, adopt: "ask" },
				autoArm: false,
				defaultConductor: "keel-note",
				compactMode: "suppress",
				bindHost: "0.0.0.0",
				doorPort: 25000,
				customToken: "my-custom-8",
				models: { defaults: { classifier: "local/minilm" }, conductors: { taskfold: { chat: "current" } } },
				privacyConsent: { taskfold: "2026-05-01T10:00:00.000Z" },
				taskWidget: { mode: "off", expanded: true, maxRows: 20, toggleKey: "ctrl+alt+t" },
				modelDefaults: { "anthropic/*": { budget: "200k", protect: "20k" } },
			});

			const loaded = loadSettings(tmp, {});
			expect(loaded).toEqual({
				debug: true,
				taskfold: { timing: "lazy", leafForm: "bracket", high: 0.9, low: 0.7, keepRecentTasks: 2, recordTokens: 2200, floor: true, untracked: { enabled: false, minSteps: 10 }, steps: { enabled: false, minSteps: 3 } },
				tasks: { attachments: { render: "reference", maxLines: 40, roots: ["/srv/kb"] }, pins: { listTokens: 1000, taskTokens: 500 }, adopt: "ask" },
				autoArm: false,
				defaultConductor: "keel-note",
				compactMode: "suppress",
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

	test("validates taskfold budget, age and untracked settings", () => {
		expect(sanitizeTaskfoldSettings({ timing: "pressure", leafForm: "bracket", high: 0.9, low: 0.7, keepRecentTasks: 0, recordTokens: 200, floor: true, untracked: { enabled: false, minSteps: 5 }, steps: { enabled: false, minSteps: 2 } })).toEqual({ timing: "pressure", leafForm: "bracket", high: 0.9, low: 0.7, keepRecentTasks: 0, recordTokens: 200, floor: true, untracked: { enabled: false, minSteps: 5 }, steps: { enabled: false, minSteps: 2 } });
		expect(sanitizeTaskfoldSettings({ high: 0.5, low: 0.7, untracked: { minSteps: 0 } })).toMatchObject({ high: 0.8, low: 0.6, untracked: { enabled: true, minSteps: 8 } });
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
