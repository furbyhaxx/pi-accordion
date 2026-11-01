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
			expect(defaults.autoArm).toBe(true);
			expect(defaults.defaultConductor).toBe("keel-lite");
			expect(defaults.compactMode).toBe("accordion");
			expect(defaults.bindHost).toBe("127.0.0.1");

			saveSettings(tmp, {
				autoArm: false,
				defaultConductor: "keel-note",
				compactMode: "suppress",
				bindHost: "0.0.0.0",
				doorPort: 25000,
				customToken: "my-custom-8",
			});

			const loaded = loadSettings(tmp, {});
			expect(loaded).toEqual({
				autoArm: false,
				defaultConductor: "keel-note",
				compactMode: "suppress",
				bindHost: "0.0.0.0",
				doorPort: 25000,
				customToken: "my-custom-8",
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
