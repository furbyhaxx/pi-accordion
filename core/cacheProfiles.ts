/** Provider cache behavior; weights are multiples of ordinary input cost, not invoice amounts. */
export interface CacheProfile {
	family: "anthropic" | "openai-breakpoint" | "prefix";
	ttlMs: number;
	readWeight: number;
	writeWeight: number;
}

const MINUTE = 60_000;
const PREFIX: CacheProfile = { family: "prefix", ttlMs: 5 * MINUTE, readWeight: 1, writeWeight: 1 };
const ANTHROPIC: CacheProfile = { family: "anthropic", ttlMs: 5 * MINUTE, readWeight: 0.1, writeWeight: 1.25 };
const OPENAI: CacheProfile = { family: "openai-breakpoint", ttlMs: 30 * MINUTE, readWeight: 0.1, writeWeight: 1.25 };

// Verified 2026-11-11 against the vendors' prompt-caching guides; unverified backends use PREFIX.
const PROFILES: Readonly<Record<string, CacheProfile>> = {
	"*": PREFIX,
	...Object.fromEntries(["anthropic", "claude"].flatMap((provider) => [
		[`${provider}/*`, ANTHROPIC],
		...["sonnet-5-5", "opus-5-5", "fable-5-1", "fable-5-2", "mythos-5-1", "mythos-5-2"].map((model) =>
			[`${provider}/claude-${model}`, { ...ANTHROPIC, readWeight: /^(fable|mythos)/.test(model) ? 0.025 : 0.05 }]),
	])),
	...Object.fromEntries(["gpt-5.6", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-6", "gpt-6-luna", "gpt-6-sol", "gpt-6.1-sol", "gpt-6.1-terra"].map((model) =>
		[`openai/${model}`, { ...OPENAI, readWeight: model === "gpt-6.1-sol" || model === "gpt-6.1-terra" ? 0.05 : 0.1 }])),
};

/** Resolve exact model, provider wildcard, then fallback; a host-observed TTL overrides the table. */
export function cacheProfileFor(model: string, ttlMs?: number): CacheProfile {
	const provider = model.slice(0, model.indexOf("/"));
	const profile = PROFILES[model] ?? PROFILES[`${provider}/*`] ?? PROFILES["*"];
	if (ttlMs === undefined) return { ...profile };
	if (!Number.isFinite(ttlMs) || ttlMs < 0) throw new RangeError("cache TTL must be nonnegative and finite");
	if (!ttlMs) return { ...profile, ttlMs, readWeight: 1, writeWeight: 1 };
	const writeWeight = profile.family === "anthropic" && ttlMs > 5 * MINUTE ? 2
		: profile.family === "openai-breakpoint" && ttlMs > 30 * MINUTE ? 2.5 : profile.writeWeight;
	return { ...profile, ttlMs, writeWeight };
}
