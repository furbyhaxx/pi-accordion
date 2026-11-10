import { describe, expect, test } from "bun:test";
import { nativeCompletion } from "./nativeCompletion";

describe("nativeCompletion", () => {
	test("routes through the registered native provider with a transcript context", async () => {
		const calls: any[] = [];
		const registry = {
			getRegisteredNativeProvider: (id: string) =>
				id === "antigravity"
					? { stream: (model: any, context: any, options: any) => (calls.push({ model, context, options }), { result: async () => ({ content: [{ type: "text", text: "ok" }] }) }) }
					: undefined,
		};
		const complete = nativeCompletion(registry, "antigravity");
		expect(complete).toBeDefined();
		const message = { role: "user" as const, content: "hi", timestamp: 1 };
		const result = await complete!({ id: "gemini-3.8-flash" }, { systemPrompt: "sys", messages: [message] }, { apiKey: "k", maxTokens: 9 });
		expect(result.content[0].text).toBe("ok");
		expect(calls[0].context.messages).toEqual([{ role: "system", content: "sys", timestamp: 0 }, message]);
		expect(calls[0].options).toEqual({ apiKey: "k", maxTokens: 9 });
	});

	test("is undefined without a native provider, so pi-ai's complete stays in charge", () => {
		expect(nativeCompletion({ getRegisteredNativeProvider: () => undefined }, "openai-codex")).toBeUndefined();
		expect(nativeCompletion({}, "openai-codex")).toBeUndefined();
		expect(nativeCompletion(undefined, "openai-codex")).toBeUndefined();
	});
});
