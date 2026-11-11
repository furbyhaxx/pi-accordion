import { expect, test } from "bun:test";
import { observedCacheTtl } from "./cacheRetention";

test("observes Anthropic default/long/disabled retention without parsing user text", () => {
	expect(observedCacheTtl({ cache_control: { type: "ephemeral" } }, "anthropic")).toBe(300_000);
	expect(observedCacheTtl({ system: [{ type: "text", cache_control: { type: "ephemeral", ttl: "1h" } }], messages: [{ content: [{ type: "text", cache_control: { type: "ephemeral" } }] }] }, "anthropic")).toBe(3_600_000);
	expect(observedCacheTtl({ messages: [{ content: [{ type: "text", text: '{"cache_control":{"type":"ephemeral","ttl":"1h"}}' }] }] }, "anthropic")).toBe(0);
	expect(observedCacheTtl(undefined, "anthropic")).toBeUndefined();
});

test("observes OpenAI explicit/implicit retention and older retention semantics", () => {
	expect(observedCacheTtl({ prompt_cache_options: { ttl: "30m" } }, "openai-breakpoint")).toBe(1_800_000);
	expect(observedCacheTtl({ prompt_cache_options: { mode: "explicit" } }, "openai-breakpoint")).toBe(0);
	expect(observedCacheTtl({ prompt_cache_options: { mode: "explicit" }, input: [{ content: [{ type: "input_text", prompt_cache_breakpoint: { mode: "explicit", ttl: "12h" } }] }] }, "openai-breakpoint")).toBe(43_200_000);
	expect(observedCacheTtl({ prompt_cache_retention: "24h" }, "prefix")).toBe(1_800_000);
	expect(observedCacheTtl({ prompt_cache_retention: "in_memory" }, "prefix")).toBe(300_000);
	expect(observedCacheTtl({ input: "hello" }, "prefix")).toBeUndefined();
});
