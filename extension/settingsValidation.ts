import { isIP } from "node:net";
import * as path from "node:path";
import { ENTRIES, entryById } from "../core/conductor/registry";
import { FOLD_TIMINGS } from "../core/conductor/contract";
import { isModelPattern, parseTokens } from "./dials";
import { sanitizeBindHost, sanitizeCustomToken, sanitizeModelSpec, type AccordionSettings } from "./settings";

type Rule = (value: unknown) => string | undefined;
const boolean: Rule = value => typeof value === "boolean" ? undefined : "must be a boolean";
const choice = (...values: readonly string[]): Rule => value => typeof value === "string" && values.includes(value) ? undefined : `must be one of ${values.join(", ")}`;
const number = (min: number, max: number, integer = true): Rule => value =>
	typeof value === "number" && Number.isFinite(value) && value >= min && value <= max && (!integer || Number.isInteger(value))
		? undefined : `must be ${integer ? "an integer" : "a number"} between ${min} and ${max}`;
const timing = choice(...FOLD_TIMINGS);
const model = (type: "chat" | "classifier"): Rule => value => value === undefined || typeof value === "string" && sanitizeModelSpec(value, type) === value
	? undefined : `must be provider/model-id${type === "chat" ? " or current" : " (current is only valid for chat)"}`;
const amount: Rule = value => value === undefined || typeof value === "string" && typeof parseTokens(value, 1_000_000) === "number"
	? undefined : "must be a token amount such as 200k, 1M or 85%";

const RULES = {
	debug: boolean,
	autoArm: boolean,
	defaultConductor: (value => typeof value === "string" && entryById(value) ? undefined : "must name a registered conductor or none") satisfies Rule,
	"compact.manual": choice("pass", "aggressive", "bake", "native"),
	"compact.threshold": choice("pass", "native"),
	"compact.onSaturated": choice("native", "bake", "warn"),
	bindHost: (value => typeof value === "string" && sanitizeBindHost(value) === value && (isIP(value) !== 0 || !/^[\d.]+$/.test(value) && value.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) ? undefined : "must be an IP address or hostname, without a scheme or port (at most 253 characters)") satisfies Rule,
	doorPort: number(0, 65535),
	customToken: (value => value === null || typeof value === "string" && sanitizeCustomToken(value) === value ? undefined : "must be null for a generated token or 3–64 URL-safe characters [A-Za-z0-9._~-]") satisfies Rule,
	"models.defaults.chat": model("chat"),
	"models.defaults.classifier": model("classifier"),
	"taskWidget.mode": choice("auto", "off"),
	"taskWidget.expanded": boolean,
	"taskWidget.maxRows": number(1, 100),
	"taskWidget.toggleKey": (value => typeof value === "string" && /^((ctrl|alt|shift|super)\+)*[a-z0-9]$/.test(value) ? undefined : "must be a lowercase key id such as alt+t or ctrl+alt+t") satisfies Rule,
	"tasks.attachments.render": choice("inline", "reference"),
	"tasks.attachments.maxLines": number(1, 1000),
	"tasks.attachments.roots": (value => Array.isArray(value) && value.every(root => typeof root === "string" && root === root.trim() && (path.isAbsolute(root) || root === "~" || root.startsWith("~/"))) ? undefined : "must be an array of absolute directories (~/ is allowed)") satisfies Rule,
	"tasks.pins.listTokens": number(1, 100000),
	"tasks.pins.taskTokens": number(1, 100000),
	"tasks.adopt": choice("auto", "ask", "off"),
	"taskfold.timing": timing,
	"taskfold.leafForm": choice("record", "bracket"),
	"taskfold.recordTokens": number(100, 100000),
	"taskfold.floor": boolean,
	"taskfold.untracked.enabled": boolean,
	"taskfold.untracked.minSteps": number(1, 10000),
	"taskfold.steps.enabled": boolean,
	"taskfold.steps.minSteps": number(1, 10000),
} satisfies Record<string, Rule>;

/** A scalar or list-valued configuration field; dynamic map keys remain opaque. */
export type SettingPath = keyof typeof RULES
	| `models.conductors.${string}.${"chat" | "classifier"}`
	| `conductorOptions.${string}.${string}`
	| `privacyConsent.${string}`
	| `modelDefaults.${string}.${"budget" | "protect" | "timing"}`;

/** Flat field edits; undefined removes an optional map entry or model override. */
export type SettingsPatch = Partial<Record<SettingPath, unknown>>;

/** An actionable invalid-save result, or confirmation that the supplied patch is valid. */
export type SettingsValidation = { ok: true } | { ok: false; error: string };

interface Field { parts: string[]; rule: Rule }
const safeKey = (key: string) => key.length > 0 && key === key.trim() && !["__proto__", "constructor", "prototype"].includes(key);

function field(name: string): Field | undefined {
	if (Object.hasOwn(RULES, name)) return { parts: name.split("."), rule: RULES[name as keyof typeof RULES] };
	for (const entry of ENTRIES) for (const spec of entry.options ?? []) {
		if (name !== `conductorOptions.${entry.id}.${spec.key}`) continue;
		const rule: Rule = value => {
			if (value === undefined) return undefined;
			if (spec.type === "boolean") return boolean(value);
			return number(spec.min ?? -Infinity, spec.max ?? Infinity, spec.integer ?? false)(value);
		};
		return { parts: ["conductorOptions", entry.id, spec.key], rule };
	}
	const conductor = /^models\.conductors\.(.+)\.(chat|classifier)$/.exec(name);
	if (conductor && safeKey(conductor[1])) return { parts: ["models", "conductors", conductor[1], conductor[2]], rule: model(conductor[2] as "chat" | "classifier") };
	const consent = /^privacyConsent\.(.+)$/.exec(name);
	if (consent && safeKey(consent[1])) return {
		parts: ["privacyConsent", consent[1]],
		rule: value => value === undefined || typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value))
			? undefined : "must be an ISO timestamp or removed to revoke consent",
	};
	const defaults = /^modelDefaults\.(.+)\.(budget|protect|timing)$/.exec(name);
	if (defaults && safeKey(defaults[1]) && isModelPattern(defaults[1])) return {
		parts: ["modelDefaults", defaults[1], defaults[2]],
		rule: defaults[2] === "timing" ? value => value === undefined ? undefined : timing(value) : amount,
	};
	return undefined;
}

/** Resolve a recognized field to object keys without splitting dots inside model ids. */
export function settingParts(name: string): readonly string[] | undefined {
	return field(name)?.parts;
}

/** Enumerate configured fields, including dynamic routing, consent and model defaults. */
export function settingPaths(settings: AccordionSettings): SettingPath[] {
	const names: SettingPath[] = Object.keys(RULES) as (keyof typeof RULES)[];
	for (const entry of ENTRIES) for (const spec of entry.options ?? []) names.push(`conductorOptions.${entry.id}.${spec.key}`);
	for (const [id, specs] of Object.entries(settings.models.conductors)) {
		for (const type of ["chat", "classifier"] as const) if (specs[type] !== undefined) names.push(`models.conductors.${id}.${type}`);
	}
	for (const id of Object.keys(settings.privacyConsent)) names.push(`privacyConsent.${id}`);
	for (const [pattern, dials] of Object.entries(settings.modelDefaults)) {
		for (const key of ["budget", "protect", "timing"] as const) if (dials[key] !== undefined) names.push(`modelDefaults.${pattern}.${key}`);
	}
	return names;
}

/** Reject unknown fields and malformed values without replacing them with defaults. */
export function validateSetting(name: string, value: unknown): SettingsValidation {
	const descriptor = field(name);
	if (!descriptor) return { ok: false, error: `${name}: unknown setting` };
	const error = descriptor.rule(value);
	return error ? { ok: false, error: `${name}: ${error}` } : { ok: true };
}

/** Validate a save boundary, including interdependent watermarks against the current settings. */
export function validateSettingsPatch(patch: unknown, current: AccordionSettings): SettingsValidation {
	if (!patch || typeof patch !== "object" || Array.isArray(patch)) return { ok: false, error: "settings patch must be an object of field edits" };
	for (const [name, value] of Object.entries(patch)) {
		const result = validateSetting(name, value);
		if (!result.ok) return result;
	}
	const highKey = "conductorOptions.taskfold.high";
	const lowKey = "conductorOptions.taskfold.low";
	if (highKey in patch || lowKey in patch) {
		const edits = patch as SettingsPatch;
		const opts = current.conductorOptions.taskfold ?? {};
		const defaults = entryById("taskfold")!.options!;
		const effective = (key: "high" | "low"): unknown => {
			const path: SettingPath = `conductorOptions.taskfold.${key}`;
			const fallback = defaults.find(spec => spec.key === key)!.default;
			return path in edits ? edits[path] ?? fallback : opts[key] ?? fallback;
		};
		const high = effective("high"), low = effective("low");
		if (typeof high === "number" && typeof low === "number" && low >= high) return { ok: false, error: `${lowKey}: must be less than ${highKey}` };
	}
	return { ok: true };
}
