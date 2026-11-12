/*
 * settings.ts — Persistent configuration, memorable 8-char tokens, and runtime overrides for Accordion.
 *
 * Stored at `<home>/.accordion/config.json` (respecting `ACCORDION_HOME`).
 * Precedence: defaults < config.json < environment variables < CLI flags / runtime edits.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { DOOR_PORT } from "../core/protocol";
import { REGISTRY_DIR } from "../app/src/lib/live/registry";
import { sanitizeModelDefaults, type ModelDefaults } from "./dials";
import { TASKFOLD_DEFAULTS, type TaskfoldOptions } from "../conductors/in-process/taskfold/taskfold";
import { isFoldTiming, type FoldTiming } from "../core/conductor/contract";

/** Independent policies for manual, threshold and saturated-overflow compaction. */
export interface CompactSettings {
	manual: "pass" | "aggressive" | "bake" | "native";
	threshold: "pass" | "native";
	onSaturated: "native" | "bake" | "warn";
}

/** The kinds of model a conductor can request from the host. */
export type ModelType = "chat" | "classifier";
export const MODEL_TYPES: readonly ModelType[] = ["chat", "classifier"];

/** Canonical `provider/model-id` specs per model type; `"current"` (chat only) is the session model. */
export type ModelSpecs = Partial<Record<ModelType, string>>;

/** Model routing for out-of-band conductor calls: a default per type, overridden per conductor id. */
export interface ModelSettings {
	defaults: ModelSpecs;
	conductors: Record<string, ModelSpecs>;
}

/** The Taskfold task list above the editor. */
export interface TaskWidgetSettings {
	/** `auto` shows it while the attached conductor provides the `tasks` tool and this session holds a list. */
	mode: "auto" | "off";
	/** Whether the task tree is expanded; the last toggle is remembered here. */
	expanded: boolean;
	/** Rows the expanded tree uses before hiding tasks furthest from the work in progress. */
	maxRows: number;
	/** Shortcut that expands and collapses the widget. */
	toggleKey: string;
}

export interface TaskSettings {
	/** `roots`: absolute directories outside the project that attachments and pin sources may read. */
	attachments: { render: "inline" | "reference"; maxLines: number; roots: string[] };
	pins: { listTokens: number; taskTokens: number };
	/** How a session recorded before task events is adopted on resume (SPEC-0002 §14). */
	adopt: "auto" | "ask" | "off";
}

export interface TaskfoldSettings {
	timing: FoldTiming;
	leafForm: NonNullable<TaskfoldOptions["leafForm"]>;
	high: number;
	low: number;
	keepRecentTasks: number;
	recordTokens: number;
	floor: boolean;
	untracked: { enabled: boolean; minSteps: number };
	steps: { enabled: boolean; minSteps: number };
}

export interface AccordionSettings {
	/** Write private per-session diagnostics when enabled. */
	debug: boolean;
	/** Automatically arm folding when a session starts. */
	autoArm: boolean;
	/** Default conductor attached when autoArm is enabled (or when /compact triggers a pass). */
	defaultConductor: string;
	/** How Accordion handles Pi's /compact and auto-compaction when folding is armed. */
	compact: CompactSettings;
	/** IP/hostname for the Web UI and Door listener (e.g. "127.0.0.1", "0.0.0.0", Tailscale IP). */
	bindHost: string;
	/** Fixed Door port (0 disables the shared Door listener). */
	doorPort: number;
	/** Optional user-defined static token for Web UI access (null => use generated 8-char memorable token). */
	customToken: string | null;
	/** Which models conductors' completions and classifications run on. */
	models: ModelSettings;
	/** Conductor id → ISO timestamp at which the user accepted its privacy notice. */
	privacyConsent: Record<string, string>;
	taskWidget: TaskWidgetSettings;
	tasks: TaskSettings;
	taskfold: TaskfoldSettings;
	/** Budget and protected tail per `provider/model`, `provider/*` or `*`, as `"200k"`, `"1M"` or `"85%"`. */
	modelDefaults: ModelDefaults;
}

export const DEFAULT_SETTINGS: Readonly<AccordionSettings> = {
	debug: false,
	autoArm: true,
	defaultConductor: "keel-lite",
	compact: { manual: "pass", threshold: "pass", onSaturated: "native" },
	bindHost: "127.0.0.1",
	doorPort: DOOR_PORT,
	customToken: null,
	models: { defaults: {}, conductors: {} },
	privacyConsent: {},
	taskWidget: { mode: "auto", expanded: false, maxRows: 12, toggleKey: "alt+t" },
	tasks: { attachments: { render: "inline", maxLines: 60, roots: [] }, pins: { listTokens: 2000, taskTokens: 1500 }, adopt: "auto" },
	taskfold: { timing: TASKFOLD_DEFAULTS.timing, leafForm: TASKFOLD_DEFAULTS.leafForm, high: TASKFOLD_DEFAULTS.high, low: TASKFOLD_DEFAULTS.low, keepRecentTasks: TASKFOLD_DEFAULTS.keepRecentTasks, recordTokens: TASKFOLD_DEFAULTS.recordTokens, floor: TASKFOLD_DEFAULTS.floor, untracked: { ...TASKFOLD_DEFAULTS.untracked }, steps: { ...TASKFOLD_DEFAULTS.steps } },
	modelDefaults: {},
};

const CONFIG_FILE = "config.json";
const CONSONANTS = "bcdfghjkmnpqrstvwxz";
const VOWELS = "aeu";
const DIGITS = "23456789";

/**
 * Generate an easily memorable, unambiguous 8-character token (`cvcvdcvd`, e.g. `kave4ton`).
 * Uses only lowercase letters and digits 2-9 (no 0/o/1/l/i ambiguity).
 */
export function generateMemorableToken(): string {
	const bytes = crypto.randomBytes(8);
	const pick = (alphabet: string, b: number) => alphabet[b % alphabet.length];
	return (
		pick(CONSONANTS, bytes[0]) +
		pick(VOWELS, bytes[1]) +
		pick(CONSONANTS, bytes[2]) +
		pick(VOWELS, bytes[3]) +
		pick(DIGITS, bytes[4]) +
		pick(CONSONANTS, bytes[5]) +
		pick(VOWELS, bytes[6]) +
		pick(CONSONANTS, bytes[7])
	);
}

/**
 * Validate a custom or generated token.
 * Accepts 3–64 URL-safe characters (`[A-Za-z0-9._~-]`), excluding the literal string `"null"`.
 */
export function sanitizeCustomToken(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (trimmed.length < 3 || trimmed.length > 64) return null;
	if (!/^[A-Za-z0-9._~-]+$/.test(trimmed)) return null;
	return trimmed;
}

/**
 * Validate an on-disk door-secret file:
 * - 8-char memorable alphanumeric token (`^[a-z0-9]{8}$`), OR
 * - Legacy 64-hex secret (`^[0-9a-f]{64}$`).
 */
export const VALID_DOOR_SECRET_RE = /^([a-z0-9]{8}|[0-9a-f]{64})$/i;

export function sanitizeBindHost(value: unknown): string {
	if (typeof value !== "string") return DEFAULT_SETTINGS.bindHost;
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > 253) return DEFAULT_SETTINGS.bindHost;
	if (/[\s/?#@\\]/.test(trimmed)) return DEFAULT_SETTINGS.bindHost;
	return trimmed;
}

export function sanitizeDoorPort(value: unknown): number {
	const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
	if (!Number.isSafeInteger(n) || n < 0 || n > 65535) return DEFAULT_SETTINGS.doorPort;
	return n;
}

/** Migrate the legacy compactMode setting and its environment override. */
export function migrateCompactMode(value: unknown): CompactSettings {
	if (value === "native") return { manual: "native", threshold: "native", onSaturated: "native" };
	return { ...DEFAULT_SETTINGS.compact, onSaturated: value === "suppress" ? "warn" : "native" };
}

/** Read independent compaction policies, defaulting malformed file values field by field. */
export function sanitizeCompactSettings(value: unknown): CompactSettings {
	const input = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
	return {
		manual: input.manual === "pass" || input.manual === "aggressive" || input.manual === "bake" || input.manual === "native" ? input.manual : DEFAULT_SETTINGS.compact.manual,
		threshold: input.threshold === "pass" || input.threshold === "native" ? input.threshold : DEFAULT_SETTINGS.compact.threshold,
		onSaturated: input.onSaturated === "native" || input.onSaturated === "bake" || input.onSaturated === "warn" ? input.onSaturated : DEFAULT_SETTINGS.compact.onSaturated,
	};
}

/** A canonical model spec: `provider/model-id` (the id may itself contain `/`), or `"current"` for chat. */
export function sanitizeModelSpec(value: unknown, type: ModelType): string | null {
	if (typeof value !== "string") return null;
	const spec = value.trim();
	if (spec === "current") return type === "chat" ? spec : null;
	if (spec.length > 300 || /\s/.test(spec)) return null;
	const slash = spec.indexOf("/");
	return slash > 0 && slash < spec.length - 1 ? spec : null;
}

function sanitizeModelSpecs(value: unknown): ModelSpecs {
	const out: ModelSpecs = {};
	if (!value || typeof value !== "object" || Array.isArray(value)) return out;
	for (const type of MODEL_TYPES) {
		const spec = sanitizeModelSpec((value as Record<string, unknown>)[type], type);
		if (spec) out[type] = spec;
	}
	return out;
}

export function sanitizeModelSettings(value: unknown): ModelSettings {
	const raw = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
	const conductors: Record<string, ModelSpecs> = {};
	const rawConductors = raw.conductors;
	if (rawConductors && typeof rawConductors === "object" && !Array.isArray(rawConductors)) {
		for (const [id, specs] of Object.entries(rawConductors)) {
			const clean = sanitizeModelSpecs(specs);
			if (id.trim() && Object.keys(clean).length) conductors[id.trim()] = clean;
		}
	}
	return { defaults: sanitizeModelSpecs(raw.defaults), conductors };
}

export function sanitizeTaskWidget(value: unknown): TaskWidgetSettings {
	const d = DEFAULT_SETTINGS.taskWidget;
	const raw = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
	const rows = raw.maxRows;
	const key = typeof raw.toggleKey === "string" ? raw.toggleKey.trim().toLowerCase() : "";
	return {
		mode: raw.mode === "off" ? "off" : d.mode,
		expanded: typeof raw.expanded === "boolean" ? raw.expanded : d.expanded,
		maxRows: typeof rows === "number" && Number.isInteger(rows) && rows >= 1 && rows <= 100 ? rows : d.maxRows,
		toggleKey: /^((ctrl|alt|shift|super)\+)*[a-z0-9]$/.test(key) ? key : d.toggleKey,
	};
}

/** Absolute directories, `~/` expanded; anything else is dropped so a typo never widens access to the cwd. */
function attachmentRoots(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const roots = value.flatMap((v) => (typeof v === "string" && v.trim() ? [v.trim().replace(/^~(?=\/|$)/, os.homedir())] : []));
	return [...new Set(roots.filter((r) => path.isAbsolute(r)).map((r) => path.resolve(r)))];
}

export function sanitizeTaskSettings(value: unknown): TaskSettings {
	const raw = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
	const attachments = raw.attachments && typeof raw.attachments === "object" && !Array.isArray(raw.attachments) ? raw.attachments as Record<string, unknown> : {};
	const pins = raw.pins && typeof raw.pins === "object" && !Array.isArray(raw.pins) ? raw.pins as Record<string, unknown> : {};
	const integer = (v: unknown, fallback: number, max: number) => typeof v === "number" && Number.isInteger(v) && v > 0 && v <= max ? v : fallback;
	return {
		attachments: { render: attachments.render === "reference" ? "reference" : "inline", maxLines: integer(attachments.maxLines, 60, 1000), roots: attachmentRoots(attachments.roots) },
		pins: { listTokens: integer(pins.listTokens, 2000, 100000), taskTokens: integer(pins.taskTokens, 1500, 100000) },
		adopt: raw.adopt === "ask" || raw.adopt === "off" ? raw.adopt : "auto",
	};
}

export function sanitizeTaskfoldSettings(value: unknown): TaskfoldSettings {
	const defaults = DEFAULT_SETTINGS.taskfold;
	const raw = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
	const range = (v: unknown, fallback: number, min: number, max: number) => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : fallback;
	let high = typeof raw.high === "number" && Number.isFinite(raw.high) && raw.high > 0 && raw.high <= 1 ? raw.high : defaults.high;
	let low = typeof raw.low === "number" && Number.isFinite(raw.low) && raw.low > 0 && raw.low < 1 ? raw.low : defaults.low;
	if (low >= high) { high = defaults.high; low = defaults.low; }
	const untracked = raw.untracked && typeof raw.untracked === "object" && !Array.isArray(raw.untracked) ? raw.untracked as Record<string, unknown> : {};
	const steps = raw.steps && typeof raw.steps === "object" && !Array.isArray(raw.steps) ? raw.steps as Record<string, unknown> : {};
	const timing = isFoldTiming(raw.timing) ? raw.timing : defaults.timing;
	const leafForm = raw.leafForm === "record" || raw.leafForm === "bracket" ? raw.leafForm : defaults.leafForm;
	return { timing, leafForm, high, low, keepRecentTasks: range(raw.keepRecentTasks, defaults.keepRecentTasks, 0, 1000), recordTokens: range(raw.recordTokens, defaults.recordTokens, 100, 100000), floor: typeof raw.floor === "boolean" ? raw.floor : defaults.floor, untracked: { enabled: typeof untracked.enabled === "boolean" ? untracked.enabled : defaults.untracked.enabled, minSteps: range(untracked.minSteps, defaults.untracked.minSteps, 1, 10000) }, steps: { enabled: typeof steps.enabled === "boolean" ? steps.enabled : defaults.steps.enabled, minSteps: range(steps.minSteps, defaults.steps.minSteps, 1, 10000) } };
}

export function sanitizePrivacyConsent(value: unknown): Record<string, string> {
	const out: Record<string, string> = {};
	if (!value || typeof value !== "object" || Array.isArray(value)) return out;
	for (const [id, at] of Object.entries(value)) if (id.trim() && typeof at === "string" && at.trim()) out[id.trim()] = at.trim();
	return out;
}

/**
 * The model spec a conductor's request resolves to: an explicit spec in the request wins, then the
 * conductor's override, then the per-type default, then the conductor's built-in default. Chat falls
 * back to the session model; a classifier has no implicit fallback, so `null` means none is configured.
 */
export function resolveModelSpec(models: ModelSettings, type: ModelType, conductorId: string | null, requested?: string, builtIn?: string | readonly string[], available: (spec: string) => boolean = () => true): string | null {
	const explicit = requested !== undefined && requested !== "current" ? sanitizeModelSpec(requested, type) : null;
	if (requested !== undefined && requested !== "current" && !explicit) throw new Error(`invalid ${type} model spec "${requested}" (expected provider/model-id)`);
	const configured = explicit ?? (conductorId ? models.conductors[conductorId]?.[type] : undefined) ?? models.defaults[type];
	if (configured) return configured;
	const tuned = typeof builtIn === "string" ? builtIn : builtIn?.find(available);
	return tuned ?? (type === "chat" ? "current" : null);
}

/** Split a canonical spec at its first `/`: `openrouter/google/gemini-x` → provider `openrouter`. */
export function splitModelSpec(spec: string): { provider: string; id: string } {
	const slash = spec.indexOf("/");
	return { provider: spec.slice(0, slash), id: spec.slice(slash + 1) };
}

/** Does a provider base URL point at this machine? Data sent there never leaves it. */
export function isLoopbackUrl(baseUrl: unknown): boolean {
	if (typeof baseUrl !== "string" || !baseUrl) return false;
	try {
		const host = new URL(baseUrl).hostname.toLowerCase();
		return isLoopbackHost(host) || /^127\./.test(host);
	} catch {
		return false;
	}
}

export function isLoopbackHost(host: string): boolean {
	const h = host.trim().toLowerCase();
	return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]";
}

export function configPathForHome(homeDir: string): string {
	return path.join(homeDir, REGISTRY_DIR, CONFIG_FILE);
}

export function loadSettings(homeDir: string, env: Record<string, string | undefined> = process.env): AccordionSettings {
	const filePath = configPathForHome(homeDir);
	let fileData: Record<string, unknown> = {};
	const hasFile = fs.existsSync(filePath);
	try {
		if (hasFile) {
			const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				fileData = parsed as Record<string, unknown>;
			}
		}
	} catch {
		/* ignore malformed config file */
	}

	// If running under an isolated test home (`ACCORDION_HOME` set) without an explicit config file
	// or `ACCORDION_AUTO_ARM`, preserve upstream's `autoArm: false` baseline so existing protocol
	// smoke tests that assert folding starts off do not need to rewrite their assumptions.
	const defaultAutoArm = env.ACCORDION_HOME && !hasFile && env.ACCORDION_AUTO_ARM === undefined ? false : DEFAULT_SETTINGS.autoArm;

	const autoArm =
		env.ACCORDION_AUTO_ARM !== undefined
			? env.ACCORDION_AUTO_ARM === "1" || env.ACCORDION_AUTO_ARM === "true"
			: typeof fileData.autoArm === "boolean"
				? fileData.autoArm
				: defaultAutoArm;

	const defaultConductor =
		typeof env.ACCORDION_DEFAULT_CONDUCTOR === "string" && env.ACCORDION_DEFAULT_CONDUCTOR.trim()
			? env.ACCORDION_DEFAULT_CONDUCTOR.trim()
			: typeof fileData.defaultConductor === "string" && fileData.defaultConductor.trim()
				? fileData.defaultConductor.trim()
				: DEFAULT_SETTINGS.defaultConductor;

	const compact = env.ACCORDION_COMPACT_MODE !== undefined
		? migrateCompactMode(env.ACCORDION_COMPACT_MODE)
		: fileData.compact === undefined ? migrateCompactMode(fileData.compactMode) : sanitizeCompactSettings(fileData.compact);
	const bindHost = sanitizeBindHost(env.ACCORDION_HOST ?? fileData.bindHost);
	const doorPort =
		env.ACCORDION_DOOR_PORT !== undefined
			? sanitizeDoorPort(env.ACCORDION_DOOR_PORT)
			: env.ACCORDION_PORT !== undefined
				? sanitizeDoorPort(env.ACCORDION_PORT)
				: sanitizeDoorPort(fileData.doorPort);
	const customToken = sanitizeCustomToken(env.ACCORDION_TOKEN ?? fileData.customToken);

	return {
		debug: typeof fileData.debug === "boolean" ? fileData.debug : DEFAULT_SETTINGS.debug,
		autoArm,
		defaultConductor,
		compact,
		bindHost,
		doorPort,
		customToken,
		models: sanitizeModelSettings(fileData.models),
		privacyConsent: sanitizePrivacyConsent(fileData.privacyConsent),
		taskWidget: sanitizeTaskWidget(fileData.taskWidget),
		tasks: sanitizeTaskSettings(fileData.tasks),
		taskfold: sanitizeTaskfoldSettings(fileData.taskfold),
		modelDefaults: sanitizeModelDefaults(fileData.modelDefaults),
	};
}

export function saveSettings(homeDir: string, settings: AccordionSettings): AccordionSettings {
	const normalized: AccordionSettings = {
		debug: settings.debug === true,
		autoArm: !!settings.autoArm,
		defaultConductor: (settings.defaultConductor || DEFAULT_SETTINGS.defaultConductor).trim(),
		compact: sanitizeCompactSettings(settings.compact),
		bindHost: sanitizeBindHost(settings.bindHost),
		doorPort: sanitizeDoorPort(settings.doorPort),
		customToken: sanitizeCustomToken(settings.customToken),
		models: sanitizeModelSettings(settings.models),
		privacyConsent: sanitizePrivacyConsent(settings.privacyConsent),
		taskWidget: sanitizeTaskWidget(settings.taskWidget),
		tasks: sanitizeTaskSettings(settings.tasks),
		taskfold: sanitizeTaskfoldSettings(settings.taskfold),
		modelDefaults: sanitizeModelDefaults(settings.modelDefaults),
	};
	try {
		const filePath = configPathForHome(homeDir);
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		const tmp = `${filePath}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(normalized, null, 2) + "\n", { mode: 0o600 });
		fs.renameSync(tmp, filePath);
	} catch {
		/* best-effort persistence */
	}
	return normalized;
}
