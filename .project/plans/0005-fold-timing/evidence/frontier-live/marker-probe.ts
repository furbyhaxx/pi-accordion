import { createHash } from "node:crypto";
import { appendFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ObjectValue = Record<string, unknown>;

function object(value: unknown): value is ObjectValue {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function withoutMarkers(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(withoutMarkers);
	if (!object(value)) return value;
	return Object.fromEntries(Object.entries(value)
		.filter(([key]) => key !== "cache_control")
		.map(([key, item]) => [key, withoutMarkers(item)]));
}

/** Three fixed requests: original markers, moved marker, then changed content as a negative control. */
export default function markerProbe(pi: ExtensionAPI): void {
	const log = process.env["CACHE_MARKER_LOG"];
	if (!log) throw new Error("CACHE_MARKER_LOG is required");
	let phase = 0;
	let frozen: ObjectValue | undefined;
	pi.on("before_provider_request", async (event, ctx) => {
		if (ctx.model?.provider !== "claude") return;
		if (!object(event.payload)) throw new Error("Expected a Messages payload");
		phase++;
		if (phase > 3) throw new Error("Marker probe is limited to three requests");
		const payload = structuredClone(frozen ?? event.payload);
		if (!Array.isArray(payload["system"])) throw new Error("Expected system blocks");
		const system: unknown[] = payload["system"];
		const identityText = "You are Claude Code, Anthropic's official CLI for Claude.";
		let identity = system.find((block): block is ObjectValue => object(block) && block["text"] === identityText);
		const identityAtHook = !!identity;
		if (!identity) {
			const cachedSystem = system.find((block): block is ObjectValue => object(block) && object(block["cache_control"]));
			if (!cachedSystem) throw new Error("Expected a cached system prompt");
			identity = { type: "text", text: identityText, cache_control: structuredClone(cachedSystem["cache_control"]) };
			system.unshift(identity);
		}
		if (!frozen) {
			payload["messages"] = [
				{ role: "user", content: [{ type: "text", text: "Marker relocation trial B. ".repeat(2000) }] },
				{ role: "assistant", content: [{ type: "text", text: "OK" }] },
				{ role: "user", content: [{ type: "text", text: "Reply only OK.", cache_control: { type: "ephemeral", ttl: "1h" } }] },
			];
			frozen = structuredClone(payload);
		}
		const messages = payload["messages"] as { content: ObjectValue[] }[];
		if (phase >= 2) {
			if (!object(identity) || !object(identity["cache_control"])) {
				throw new Error("Identity marker is not visible at this hook; inspect phase 1 before proceeding");
			}
			messages[0]!.content[0]!["cache_control"] = identity["cache_control"];
			delete identity["cache_control"];
		}
		if (phase === 3) messages[0]!.content[0]!["text"] = String(messages[0]!.content[0]!["text"]) + " Negative control: changed content.";
		const material = { system: payload["system"], tools: payload["tools"], messages };
		const markers: { path: string; control: unknown }[] = [];
		function visit(value: unknown, path: string): void {
			if (Array.isArray(value)) value.forEach((item, i) => visit(item, `${path}/${i}`));
			else if (object(value)) for (const [key, item] of Object.entries(value)) {
				if (key === "cache_control") markers.push({ path, control: item });
				else visit(item, `${path}/${key}`);
			}
		}
		visit(payload, "");
		await appendFile(log, JSON.stringify({ type: "request", phase, identityAtHook,
			materialHash: createHash("sha256").update(JSON.stringify(withoutMarkers(material))).digest("hex"), markers }) + "\n", { mode: 0o600 });
		return payload;
	});
	pi.on("message_end", async ({ message }) => {
		if (message.role !== "assistant") return;
		await appendFile(log, JSON.stringify({ type: "receipt", phase, usage: message.usage,
			stopReason: message.stopReason }) + "\n", { mode: 0o600 });
	});
}
