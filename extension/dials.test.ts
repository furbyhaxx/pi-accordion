import { describe, expect, test } from "bun:test";
import { DIALS_ENTRY, dialsRecordsOf, formatTokens, parseTokens, resolveDials, sanitizeModelDefaults } from "./dials";

describe("dials", () => {
	test("parses human token amounts and percentages of the window", () => {
		expect(["200k", "1M", "0.5M", "200000", "272K", "1_000k", " 12.5k "].map((t) => parseTokens(t, null))).toEqual([200_000, 1_000_000, 500_000, 200_000, 272_000, 1_000_000, 12_500]);
		expect(parseTokens("85%", 1_000_000)).toBe(850_000);
		expect(parseTokens("85%", null)).toEqual({ error: '"85%": the model\'s context window is not known yet' });
		expect(parseTokens("lots", 1)).toHaveProperty("error");
		expect(parseTokens("150%", 1)).toHaveProperty("error");
		expect([200_000, 1_000_000, 1_500_000, 272_000, 12_500, 900].map(formatTokens)).toEqual(["200k", "1M", "1.5M", "272k", "12.5k", "900"]);
	});

	test("drops invalid default keys and amounts", () => {
		expect(
			sanitizeModelDefaults({
				"anthropic/claude-opus-5-5": { budget: "200k", protect: 20000 },
				"openai-codex/*": { budget: "272k" },
				"*": { budget: "85%" },
				"bad key": { budget: "1k" },
				"x/*y": { budget: "1k" },
				"openrouter/google/gemini-4-argon": { budget: "nope" },
			}),
		).toEqual({ "anthropic/claude-opus-5-5": { budget: "200k", protect: "20000" }, "openai-codex/*": { budget: "272k" }, "*": { budget: "85%" } });
	});

	test("resolves session value, then the most specific default, then the window", () => {
		const defaults = sanitizeModelDefaults({ "anthropic/claude-opus-5-5": { budget: "200k" }, "anthropic/*": { budget: "300k", protect: "30k" }, "*": { budget: "85%" } });
		const opus = "anthropic/claude-opus-5-5";
		expect(resolveDials(opus, 1_000_000, [], defaults)).toEqual({ budget: 200_000, protect: 30_000, timing: "eager", sources: { budget: { kind: "default", key: opus }, protect: { kind: "default", key: "anthropic/*" }, timing: { kind: "global" } } });
		expect(resolveDials("openai/gpt-x", 400_000, [], defaults).budget).toBe(340_000);
		expect(resolveDials("openai/gpt-x", 400_000, [], {})).toMatchObject({ budget: 400_000, protect: 20_000, sources: { budget: { kind: "window" }, protect: { kind: "builtin" } } });
		const records = [{ model: opus, budget: 150_000 }, { model: "openai/gpt-x", budget: 99 }, { model: opus, protect: 8_000 }];
		expect(resolveDials(opus, 1_000_000, records, defaults)).toMatchObject({ budget: 150_000, protect: 8_000, sources: { budget: { kind: "session" }, protect: { kind: "session" } } });
		expect(resolveDials(opus, 100_000, records, defaults).budget).toBe(100_000);
	});

	test("resolves timing per session/model/provider/wildcard before the global default", () => {
		const defaults = sanitizeModelDefaults({ "a/b": { timing: "pressure" }, "a/*": { timing: "lazy" }, "*": { timing: "eager" }, "bad/*": { timing: "fast" } });
		expect(defaults).toEqual({ "a/b": { timing: "pressure" }, "a/*": { timing: "lazy" }, "*": { timing: "eager" } });
		expect(resolveDials("a/b", null, [{ model: "a/b", timing: "lazy" }], defaults, "pressure")).toMatchObject({ timing: "lazy", sources: { timing: { kind: "session" } } });
		expect(resolveDials("a/b", null, [], defaults).timing).toBe("pressure");
		expect(resolveDials("a/c", null, [], defaults)).toMatchObject({ timing: "lazy", sources: { timing: { kind: "default", key: "a/*" } } });
		expect(resolveDials("x/y", null, [], defaults).timing).toBe("eager");
		expect(resolveDials("x/y", null, [], {}, "pressure")).toMatchObject({ timing: "pressure", sources: { timing: { kind: "global" } } });
		expect(resolveDials("a/c", null, [{ model: "a/b", timing: "pressure" }], defaults).timing).toBe("lazy");
	});

	test("reads its records back from session entries", () => {
		const entries = [
			{ type: "custom", customType: DIALS_ENTRY, data: { model: "a/b", budget: 1 } },
			{ type: "custom", customType: "other", data: { model: "a/b", budget: 2 } },
			{ type: "message" },
			{ type: "custom", customType: DIALS_ENTRY, data: { budget: 3 } },
			{ type: "custom", customType: DIALS_ENTRY, data: { model: "a/b", timing: "lazy" } },
			{ type: "custom", customType: DIALS_ENTRY, data: { model: "a/b", timing: "invalid" } },
		];
		expect(dialsRecordsOf(entries)).toEqual([{ model: "a/b", budget: 1 }, { model: "a/b", timing: "lazy" }, { model: "a/b" }]);
	});
});
