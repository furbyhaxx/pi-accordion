import type { CacheProfile } from "../core/cacheProfiles";

const object = (v: unknown): Record<string, unknown> | null => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
const objects = (v: unknown): Record<string, unknown>[] => Array.isArray(v) ? v.filter((item): item is Record<string, unknown> => object(item) !== null) : [];
const TTL: Record<string, number> = { "5m": 300_000, "1h": 3_600_000, "30m": 1_800_000, "12h": 43_200_000 };

/** Observe provider retention without reading prompt text; mixed breakpoints use the longest TTL. */
export function observedCacheTtl(payload: unknown, family: CacheProfile["family"]): number | undefined {
	const p = object(payload);
	if (!p) return undefined;
	const messages = [...objects(p.messages), ...objects(p.input)];
	const nodes = [p, ...objects(p.system), ...objects(p.tools), ...messages, ...messages.flatMap((m) => objects(m.content))];
	if (family === "anthropic") {
		const controls = objects(nodes.map((n) => n.cache_control)).filter((c) => c.type === "ephemeral");
		return controls.length ? Math.max(...controls.map((c) => TTL[typeof c.ttl === "string" ? c.ttl : "5m"] ?? 300_000)) : 0;
	}
	const options = object(p.prompt_cache_options);
	if (options) {
		const breaks = objects(nodes.map((n) => n.prompt_cache_breakpoint));
		if (options.mode === "explicit" && !breaks.length) return 0;
		return Math.max(TTL[typeof options.ttl === "string" ? options.ttl : "30m"] ?? 1_800_000,
			...breaks.map((b) => TTL[typeof b.ttl === "string" ? b.ttl : "30m"] ?? 1_800_000));
	}
	// Older OpenAI's 24h is a maximum; documented typical availability is about 30 minutes.
	if (p.prompt_cache_retention === "24h") return 1_800_000;
	if (p.prompt_cache_retention === "in_memory") return 300_000;
	return undefined;
}
