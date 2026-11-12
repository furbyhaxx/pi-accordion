import { describe, expect, test } from "bun:test";
import {
	CALIBRATION_DEFAULTS,
	conservativeRatio,
	judgeReceipt,
	priorFor,
	sanitizeCalibrationSettings,
} from "./calibration";

describe("priors", () => {
	test("family and wildcard defaults apply to real model specs", () => {
		expect(priorFor("anthropic/claude-sonnet-5-5")).toBe(1.5);
		expect(priorFor("claude/claude-sonnet-5-5")).toBe(1.5);
		expect(priorFor("deepseek/deepseek-flash")).toBe(1.2);
		expect(priorFor("openrouter/moonshotai/kimi-latest")).toBe(1.2);
		expect(priorFor("openrouter/z-ai/glm-latest")).toBe(1.2);
		expect(priorFor("openai/gpt-6.1-sol")).toBe(1.15);
		expect(priorFor(null)).toBe(1.15);
	});

	test("whole spec and provider patterns beat families, which beat the wildcard", () => {
		const priors = { "*": 1.05, openai: 1.3, "openai/gpt-6.1-sol": 1.4 };
		expect(priorFor("openai/gpt-6.1-sol", priors)).toBe(1.4);
		expect(priorFor("openai/gpt-5.5", priors)).toBe(1.3);
		expect(priorFor("xai/grok-5", priors)).toBe(1.05);
	});

	test("inherited and junk values never become a prior", () => {
		const inherited = Object.create({ openai: 9 }) as Record<string, number>;
		inherited["*"] = 1.1;
		expect(priorFor("openai/gpt-6.1-sol", inherited)).toBe(1.1);
		const junk = { "*": 0, openai: Number.NaN } as Record<string, number>;
		expect(priorFor("openai/gpt-6.1-sol", junk)).toBe(1.15);
		expect(priorFor("constructor/x", junk)).toBe(1.15);
	});
});

describe("receipts", () => {
	test("billed input + cache read + cache write measures a ratio", () => {
		const verdict = judgeReceipt({ estimate: 1000, input: 800, cacheRead: 300, cacheWrite: 0 });
		expect(verdict).toEqual({ kind: "measured", ratio: 1.1, real: 1100, deduped: false });
	});

	test("Anthropic's duplicated cache write is removed once, without touching other receipts", () => {
		const doubled = judgeReceipt({ estimate: 1000, input: 1000, cacheWrite: 1000, cacheRead: 0 });
		expect(doubled).toEqual({ kind: "measured", ratio: 1, real: 1000, deduped: true });
		const kept = judgeReceipt({ estimate: 1000, input: 500, cacheWrite: 1000 }, { ...CALIBRATION_DEFAULTS, dedupeCacheWrite: false });
		expect(kept).toEqual({ kind: "measured", ratio: 1.5, real: 1500, deduped: false });
		const distinct = judgeReceipt({ estimate: 1000, input: 400, cacheWrite: 900 });
		expect(distinct).toEqual({ kind: "measured", ratio: 1.3, real: 1300, deduped: false });
	});

	test("bad pairings are refused instead of snapping k", () => {
		expect(judgeReceipt({ estimate: 0, input: 100 }).kind).toBe("unusable");
		expect(judgeReceipt({ estimate: 1000 }).kind).toBe("unusable");
		expect(judgeReceipt({ estimate: 1000, input: 0, cacheRead: 0, cacheWrite: 0 }).kind).toBe("unusable");
		expect(judgeReceipt({ estimate: 1000, input: 100 })).toEqual({ kind: "unusable", reason: "below-min" });
		const rejected = judgeReceipt({ estimate: 1000, input: 100 });
		expect("ratio" in rejected).toBe(false); // an unusable verdict never carries a ratio to adopt
		const capped = { ...CALIBRATION_DEFAULTS, maxRatio: 1.6 };
		expect(judgeReceipt({ estimate: 1000, input: 2000 }, capped)).toEqual({ kind: "unusable", reason: "above-max" });
		expect(judgeReceipt({ estimate: 1000, input: 1500 }, capped).kind).toBe("measured");
	});

	test("high Unicode ratios stay measurable because the ceiling is absent by default", () => {
		const verdict = judgeReceipt({ estimate: 1000, input: 2600 });
		expect(verdict.kind).toBe("measured");
		expect(CALIBRATION_DEFAULTS.maxRatio).toBeNull();
	});

	test("the untrusted floor keeps the larger of prior and last trusted ratio", () => {
		expect(conservativeRatio(1.5, null)).toBe(1.5);
		expect(conservativeRatio(1.2, 1.4)).toBe(1.4);
		expect(conservativeRatio(1.2, 0.9)).toBe(1.2);
		expect(conservativeRatio(Number.NaN, 1.1)).toBe(1.1);
	});
});

describe("settings", () => {
	test("sanitize keeps valid values, repairs a crossed ceiling and ignores junk priors", () => {
		const settings = sanitizeCalibrationSettings({
			minRatio: 0.8,
			maxRatio: 0.5,
			dedupeCacheWrite: false,
			preferRecount: false,
			priors: { anthropic: 1.6, bad: "x", "*": 0 },
		});
		expect(settings.minRatio).toBe(0.8);
		expect(settings.maxRatio).toBeNull();
		expect(settings.dedupeCacheWrite).toBe(false);
		expect(settings.preferRecount).toBe(false);
		expect(settings.priors.anthropic).toBe(1.6);
		expect(settings.priors["*"]).toBe(1.15);
		expect("bad" in settings.priors).toBe(false);
	});

	test("an absent block resolves to the documented defaults", () => {
		expect(sanitizeCalibrationSettings(undefined)).toEqual(CALIBRATION_DEFAULTS);
		expect(sanitizeCalibrationSettings("junk").minRatio).toBe(0.7);
	});

	test("a valid ceiling survives and still admits high ratios", () => {
		const settings = sanitizeCalibrationSettings({ minRatio: 0.7, maxRatio: 3 });
		expect(settings.maxRatio).toBe(3);
		expect(judgeReceipt({ estimate: 1000, input: 2600 }, settings).kind).toBe("measured");
	});
});
