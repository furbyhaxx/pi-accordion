import { describe, expect, it } from "vitest";
import { cacheProfileFor } from "./cacheProfiles";

describe("provider cache profiles", () => {
	it("resolves known model discounts before provider defaults and keeps unknown backends conservative", () => {
		expect(cacheProfileFor("claude/claude-sonnet-5-5")).toEqual({ family: "anthropic", ttlMs: 300_000, readWeight: 0.05, writeWeight: 1.25 });
		expect(cacheProfileFor("anthropic/claude-fable-5-2").readWeight).toBe(0.025);
		expect(cacheProfileFor("anthropic/claude-haiku-4-5").readWeight).toBe(0.1);
		expect(cacheProfileFor("openai/gpt-6.1-sol")).toEqual({ family: "openai-breakpoint", ttlMs: 1_800_000, readWeight: 0.05, writeWeight: 1.25 });
		expect(cacheProfileFor("openai/gpt-6-luna").readWeight).toBe(0.1);
		for (const model of ["unknown/model", "openai/gpt-4o", "openai-codex/gpt-6.1-sol"]) {
			expect(cacheProfileFor(model)).toEqual({ family: "prefix", ttlMs: 300_000, readWeight: 1, writeWeight: 1 });
		}
	});

	it("honors observed retention without confusing disabled caching with a missing TTL", () => {
		expect(cacheProfileFor("claude/claude-sonnet-5-5", 3_600_000)).toMatchObject({ ttlMs: 3_600_000, writeWeight: 2 });
		expect(cacheProfileFor("openai/gpt-6.1-sol", 43_200_000)).toMatchObject({ ttlMs: 43_200_000, writeWeight: 2.5 });
		expect(cacheProfileFor("claude/claude-sonnet-5-5", 0)).toMatchObject({ ttlMs: 0, readWeight: 1, writeWeight: 1 });
		expect(() => cacheProfileFor("unknown/model", -1)).toThrow(RangeError);
	});
});
