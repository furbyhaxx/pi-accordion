/*
 * calibration.ts — how a provider receipt turns into Truth's calibration multiplier.
 *
 * The engine applies `calibration` to blocks the receipt covered and `calibrationPrior` to the rest
 * (see `core/truth.ts`). This module owns the policy that decides both numbers: which prior a model
 * starts from, whether a receipt is trustworthy, and what to do with one that is not.
 */
/** Multiplier used before any receipt and for every block a receipt did not cover. */
export type CalibrationPriors = Record<string, number>;

export interface CalibrationSettings {
	/** Ratios below this are treated as a bad pairing, not a measurement. */
	minRatio: number;
	/** Optional ceiling; absent means "no ceiling" because CJK and emoji legitimately reach high ratios. */
	maxRatio: number | null;
	/** Anthropic reports a cache write and the same input tokens on the first request of a cache epoch. */
	dedupeCacheWrite: boolean;
	/** Reserved for request-matched recounts; no current source can prove a match, so it is not consumed. */
	preferRecount: boolean;
	priors: CalibrationPriors;
}

/**
 * Family defaults. Anthropic's tokenizer packs more per character than chars/4 assumes; the
 * open-weight families sit close to it. A pattern is a provider (`openrouter`), a family
 * (`moonshotai`, `z-ai`) or `*`; the most specific match wins.
 */
export const DEFAULT_PRIORS: Readonly<CalibrationPriors> = {
	"anthropic": 1.5,
	"claude": 1.5,
	"deepseek": 1.2,
	"deepseek-ai": 1.2,
	"moonshotai": 1.2,
	"kimi": 1.2,
	"z-ai": 1.2,
	"zhipu": 1.2,
	"glm": 1.2,
	"qwen": 1.2,
	"*": 1.15,
};

/** A prior key is a model, model id, family, provider or `*`; no spaces, no separators of its own. */
export function isPriorPattern(key: string): boolean {
	return key.length > 0 && key.length <= 120 && key === key.trim() && !/\s/.test(key);
}

export const CALIBRATION_DEFAULTS: Readonly<CalibrationSettings> = {
	minRatio: 0.7,
	maxRatio: null,
	dedupeCacheWrite: true,
	preferRecount: true,
	priors: { ...DEFAULT_PRIORS },
};

/** The prior a model spec starts from: whole spec, then model id, then provider, then `*`. */
export function priorFor(spec: string | null, priors: CalibrationPriors = DEFAULT_PRIORS): number {
	const wildcard = own(priors, "*");
	const fallback = positive(wildcard) ? wildcard : 1.15;
	if (!spec) return fallback;
	// Local split so this module never depends on `settings.ts` (which imports the defaults below):
	// one direction only, no import cycle to initialize through.
	const slash = spec.indexOf("/");
	const provider = slash > 0 ? spec.slice(0, slash) : "";
	const id = slash > 0 ? spec.slice(slash + 1) : spec;
	for (const pattern of [spec, id, provider, ...id.split("/").map((part) => part.toLowerCase())]) {
		if (!pattern) continue;
		const value = own(priors, pattern);
		if (positive(value)) return value;
	}
	return fallback;
}

/** `Object.hasOwn`-only lookup: a prototype key such as `constructor` must never become a prior. */
function own(priors: CalibrationPriors, key: string): number | undefined {
	return Object.hasOwn(priors, key) ? priors[key] : undefined;
}

function positive(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** A receipt as the extension can read it off a finished assistant message. */
export interface Receipt {
	estimate: number;
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
}

export type ReceiptVerdict =
	| { kind: "measured"; ratio: number; real: number; deduped: boolean }
	| { kind: "unusable"; reason: "no-estimate" | "no-usage" | "no-input" | "below-min" | "above-max" | "not-finite" };

/**
 * Decide whether a receipt may move `k`. Billed usage is only read here — never rewritten.
 *
 * `dedupeCacheWrite` removes Anthropic's first-request double count: on a cache epoch's first
 * request the provider reports the cached prefix as both `input` and `cacheWrite`, and summing both
 * inflates `real` by the whole prefix.
 */
export function judgeReceipt(receipt: Receipt, settings: CalibrationSettings = CALIBRATION_DEFAULTS): ReceiptVerdict {
	if (!positive(receipt.estimate)) return { kind: "unusable", reason: "no-estimate" };
	const input = receipt.input ?? 0;
	const cacheRead = receipt.cacheRead ?? 0;
	const cacheWrite = receipt.cacheWrite ?? 0;
	if (!input && !cacheRead && !cacheWrite) return { kind: "unusable", reason: "no-usage" };
	const deduped = settings.dedupeCacheWrite && input > 0 && cacheWrite === input;
	const real = input + cacheRead + (deduped ? 0 : cacheWrite);
	if (real <= 0) return { kind: "unusable", reason: "no-input" };
	const ratio = real / receipt.estimate;
	if (!Number.isFinite(ratio)) return { kind: "unusable", reason: "not-finite" };
	if (settings.minRatio > 0 && ratio < settings.minRatio) return { kind: "unusable", reason: "below-min" };
	if (settings.maxRatio !== null && settings.maxRatio > 0 && ratio > settings.maxRatio) return { kind: "unusable", reason: "above-max" };
	return { kind: "measured", ratio, real, deduped };
}

/** The conservative multiplier used while no trustworthy receipt has landed for this model. */
export function conservativeRatio(prior: number, lastTrusted: number | null): number {
	const trusted = lastTrusted !== null && positive(lastTrusted) ? lastTrusted : 0;
	return Math.max(positive(prior) ? prior : 1, trusted);
}

export function sanitizeCalibrationSettings(value: unknown): CalibrationSettings {
	const raw = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
	const ratio = (v: unknown, fallback: number | null, { allowNull = false } = {}): number | null => {
		if (allowNull && v === null) return null;
		return typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 10 ? v : fallback;
	};
	const minRatio = ratio(raw.minRatio, CALIBRATION_DEFAULTS.minRatio) ?? CALIBRATION_DEFAULTS.minRatio;
	let maxRatio = ratio(raw.maxRatio, CALIBRATION_DEFAULTS.maxRatio, { allowNull: true });
	if (maxRatio !== null && maxRatio <= minRatio) maxRatio = CALIBRATION_DEFAULTS.maxRatio;
	const priors: CalibrationPriors = { ...DEFAULT_PRIORS };
	if (raw.priors && typeof raw.priors === "object" && !Array.isArray(raw.priors)) {
		for (const [key, v] of Object.entries(raw.priors as Record<string, unknown>)) {
			if (!isPriorPattern(key)) continue;
			if (typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 10) priors[key] = v;
		}
	}
	return {
		minRatio,
		maxRatio,
		dedupeCacheWrite: typeof raw.dedupeCacheWrite === "boolean" ? raw.dedupeCacheWrite : CALIBRATION_DEFAULTS.dedupeCacheWrite,
		preferRecount: typeof raw.preferRecount === "boolean" ? raw.preferRecount : CALIBRATION_DEFAULTS.preferRecount,
		priors,
	};
}
