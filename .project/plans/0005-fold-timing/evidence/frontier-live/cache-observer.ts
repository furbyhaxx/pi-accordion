import { createHash } from "node:crypto";
import { appendFile } from "node:fs/promises";
import type { FetchFunction } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value);
const objects = (value: unknown): ObjectValue[] => Array.isArray(value) ? value.filter(object) : [];

function withoutControls(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(withoutControls);
	if (!object(value)) return value;
	return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "cache_control")
		.map(([key, item]) => [key, withoutControls(item)]));
}

/** Load before pi-auth-plus; capture only final marker locations and material hashes, never headers or bodies. */
export default function cacheObserver(pi: ExtensionAPI): void {
	const log = process.env["FRONTIER_FETCH_LOG"];
	if (!log) throw new Error("FRONTIER_FETCH_LOG is required");
	const original = globalThis.fetch as FetchFunction;
	let sequence = 0;
	const wrapped: FetchFunction = async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		let request: number | undefined;
		if (url.pathname === "/v1/messages" && typeof init?.body === "string") {
			const payload: unknown = JSON.parse(init.body);
			if (object(payload) && objects(payload.tools).some((tool) => String(tool.name).toLowerCase().endsWith("tasks"))) {
				request = ++sequence;
				if (request > 45) throw new Error("Frontier replay capped at 45 main requests");
				const markers: { path: string; control: unknown }[] = [];
				const mark = (node: ObjectValue, path: string) => {
					if (node.cache_control !== undefined) markers.push({ path, control: node.cache_control });
				};
				mark(payload, "");
				const tools = objects(payload.tools), system = objects(payload.system);
				tools.forEach((tool, i) => mark(tool, `/tools/${i}`));
				system.forEach((block, i) => mark(block, `/system/${i}`));
				const stableSystem = system.filter((block) => !String(block.text).startsWith("x-anthropic-billing-header:"));
				const hash = createHash("sha256").update(JSON.stringify(withoutControls({ tools, system: stableSystem })));
				const prefixes: { path: string; type: unknown; hash: string }[] = [];
				objects(payload.messages).forEach((message, i) => {
					hash.update(`\0role:${String(message.role)}\0`);
					const content = typeof message.content === "string" ? [{ type: "text", text: message.content }] : objects(message.content);
					content.forEach((block, j) => {
						const path = `/messages/${i}/content/${j}`;
						mark(block, path);
						hash.update("\0block\0").update(JSON.stringify(withoutControls(block)));
						prefixes.push({ path, type: block.type, hash: hash.copy().digest("hex") });
					});
				});
				if (markers.length > 4) throw new Error("Final OAuth request exceeds four cache markers");
				await appendFile(log, JSON.stringify({ type: "final-request", request, model: payload.model, markers, prefixes }) + "\n", { mode: 0o600 });
			}
		}
		const response = await original(input, init);
		if (request !== undefined) await appendFile(log, JSON.stringify({ type: "http", request, status: response.status }) + "\n", { mode: 0o600 });
		return response;
	};
	globalThis.fetch = Object.assign(wrapped, { preconnect: original.preconnect });
	pi.on("message_end", async ({ message }) => {
		if (message.role !== "assistant") return;
		const { input, output, cacheRead, cacheWrite, totalTokens } = message.usage;
		await appendFile(log, JSON.stringify({ type: "receipt", request: sequence, stopReason: message.stopReason,
			usage: { input, output, cacheRead, cacheWrite, totalTokens } }) + "\n", { mode: 0o600 });
	});
	pi.on("session_shutdown", () => { if (globalThis.fetch === wrapped) globalThis.fetch = original; });
}
