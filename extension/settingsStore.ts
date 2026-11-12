import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { configPathForHome, migrateCompactMode, resolveSettings, type AccordionSettings } from "./settings";
import { settingParts, settingPaths, validateSettingsPatch, type SettingPath, type SettingsPatch } from "./settingsValidation";
import { withSidecarLockRetry } from "./sidecarLock";

/** The winning configuration layer for a field. */
export type SettingSource = "default" | "file" | "env" | "flag";

/** Effective settings and provenance for one exact on-disk revision. */
export interface SettingsSnapshot {
	settings: AccordionSettings;
	sources: Record<SettingPath, SettingSource>;
	rev: string;
}

/** Save outcome; a conflict requires reloading or revising the staged edits. */
export type SettingsSaveResult = { ok: true; snapshot: SettingsSnapshot } | { ok: false; error: string; conflict?: boolean };

/** Flags supported by the native extension; undefined leaves the lower layers intact. */
export type SettingsFlags = Partial<Record<"bindHost" | "doorPort" | "customToken", string>>;

interface DiskState { data: Record<string, unknown>; rev: string; exists: boolean; error?: string }
const FLAG_ENV = { bindHost: "ACCORDION_HOST", doorPort: "ACCORDION_DOOR_PORT", customToken: "ACCORDION_TOKEN" } as const;
const ENV = {
	autoArm: ["ACCORDION_AUTO_ARM"], defaultConductor: ["ACCORDION_DEFAULT_CONDUCTOR"],
	"compact.manual": ["ACCORDION_COMPACT_MODE"], "compact.threshold": ["ACCORDION_COMPACT_MODE"], "compact.onSaturated": ["ACCORDION_COMPACT_MODE"],
	bindHost: ["ACCORDION_HOST"], doorPort: ["ACCORDION_DOOR_PORT", "ACCORDION_PORT"], customToken: ["ACCORDION_TOKEN"],
} satisfies Partial<Record<SettingPath, string[]>>;

function record(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function valueAt(object: unknown, parts: readonly string[]): unknown {
	let value = object;
	for (const part of parts) {
		if (!record(value) || !Object.hasOwn(value, part)) return undefined;
		value = value[part];
	}
	return value;
}

/** Paths whose effective values or provenance differ, including removed dynamic entries. */
export function changedSettingPaths(before: SettingsSnapshot, next: SettingsSnapshot): SettingPath[] {
	const names = new Set([...settingPaths(before.settings), ...settingPaths(next.settings)]);
	return [...names].filter(name => {
		const parts = settingParts(name);
		return parts && (!isDeepStrictEqual(valueAt(before.settings, parts), valueAt(next.settings, parts)) || before.sources[name] !== next.sources[name]);
	});
}

function setAt(object: Record<string, unknown>, parts: readonly string[], value: unknown): void {
	const [key, ...rest] = parts;
	if (!rest.length) {
		if (value === undefined) delete object[key];
		else object[key] = value;
		return;
	}
	const previous = Object.hasOwn(object, key) ? object[key] : undefined;
	const child = record(previous) ? previous : {};
	setAt(child, rest, value);
	if (Object.keys(child).length) object[key] = child;
	else delete object[key];
}

function readDisk(file: string): DiskState {
	let bytes: string;
	try { bytes = fs.readFileSync(file, "utf8"); }
	catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return { data: {}, rev: "", exists: false };
		throw error;
	}
	const rev = crypto.createHash("sha256").update(bytes).digest("hex");
	let data: unknown;
	try { data = JSON.parse(bytes); }
	catch { return { data: {}, rev, exists: true, error: "config.json is not valid JSON; repair it before saving" }; }
	if (!record(data)) return { data: {}, rev, exists: true, error: "config.json must contain an object; repair it before saving" };
	if (data.compact === undefined && data.compactMode !== undefined) data.compact = migrateCompactMode(data.compactMode);
	delete data.compactMode;
	return { data, rev, exists: true };
}

/** Revisioned configuration: merge only requested fields under the permanent sidecar mutex. */
export class SettingsStore {
	private readonly file: string;
	private readonly env: Record<string, string | undefined>;
	private readonly flags: () => SettingsFlags;
	private readonly revisions = new Map<string, Record<string, unknown>>();
	private snapshot: SettingsSnapshot;

	/** Load the initial revision; unreadable or malformed configuration rejects initialization. */
	constructor(homeDir: string, env: Record<string, string | undefined>, flags: () => SettingsFlags = () => ({})) {
		this.file = configPathForHome(homeDir);
		this.env = { ...env };
		this.flags = flags;
		const disk = readDisk(this.file);
		if (disk.error) throw new Error(disk.error);
		this.snapshot = this.capture(disk);
	}

	/** Return a detached snapshot so staged UI edits cannot mutate the store or its baselines. */
	current(): SettingsSnapshot { return structuredClone(this.snapshot); }

	private capture(disk: DiskState): SettingsSnapshot {
		const flags = this.flags();
		const env = { ...this.env };
		for (const name of Object.keys(FLAG_ENV) as (keyof typeof FLAG_ENV)[]) {
			if (flags[name] !== undefined) env[FLAG_ENV[name]] = flags[name];
		}
		const settings = resolveSettings(disk.data, env, disk.exists);
		const sources = {} as Record<SettingPath, SettingSource>;
		for (const name of settingPaths(settings)) {
			const parts = settingParts(name);
			const fromFile = parts && valueAt(disk.data, parts) !== undefined;
			const fromEnv = Object.hasOwn(ENV, name) && ENV[name as keyof typeof ENV].some(key => this.env[key] !== undefined);
			const fromFlag = Object.hasOwn(FLAG_ENV, name) && flags[name as keyof SettingsFlags] !== undefined;
			sources[name] = fromFlag ? "flag" : fromEnv ? "env" : fromFile ? "file" : "default";
		}
		if (!disk.error) this.revisions.set(disk.rev, disk.data);
		return { settings, sources, rev: disk.rev };
	}

	/** Re-read settings and report effective-value or provenance changes, including removed entries. */
	poll(): SettingPath[] {
		const disk = readDisk(this.file);
		if (disk.error) throw new Error(disk.error);
		const next = this.capture(disk);
		const changed = changedSettingPaths(this.snapshot, next);
		this.snapshot = next;
		return changed;
	}

	/** Retry contention asynchronously; stale disjoint edits merge, but overlapping edits conflict. */
	async save(patch: SettingsPatch, baseRev: string, options: { active?: () => boolean } = {}): Promise<SettingsSaveResult> {
		const result = await withSidecarLockRetry(this.file, (): SettingsSaveResult => {
			const disk = readDisk(this.file);
			if (disk.error) return { ok: false, error: disk.error };
			const validation = validateSettingsPatch(patch, resolveSettings(disk.data, {}, disk.exists));
			if (!validation.ok) return validation;
			const base = this.revisions.get(baseRev);
			if (baseRev !== disk.rev && !base) return { ok: false, error: "Unknown settings revision; reload before saving", conflict: true };
			const edits = Object.entries(patch);
			for (const [name] of edits) {
				const parts = settingParts(name);
				if (!parts) throw new Error("Validated setting has no address");
				if (baseRev !== disk.rev && !isDeepStrictEqual(valueAt(base, parts), valueAt(disk.data, parts))) return { ok: false, error: `${name}: changed on disk; reload before saving`, conflict: true };
			}
			const latest = this.capture(disk);
			for (const [name] of edits) {
				const source = latest.sources[name as SettingPath];
				if (source === "env" || source === "flag") return { ok: false, error: `${name}: controlled by an ${source === "env" ? "environment variable" : "active flag"}; remove that override before editing` };
			}
			const data = structuredClone(disk.data);
			for (const [name, value] of edits) {
				const parts = settingParts(name);
				if (!parts) throw new Error("Validated setting has no address");
				setAt(data, parts, value);
			}
			const bytes = JSON.stringify(data, null, 2) + "\n";
			const temporary = `${this.file}.${crypto.randomUUID()}.tmp`;
			try {
				fs.writeFileSync(temporary, bytes, { mode: 0o600, flag: "wx" });
				fs.renameSync(temporary, this.file);
			} finally { fs.rmSync(temporary, { force: true }); }
			this.snapshot = this.capture({ data, exists: true, rev: crypto.createHash("sha256").update(bytes).digest("hex") });
			return { ok: true, snapshot: this.current() };
		}, options);
		if (result.status === "done") return result.value;
		if (result.status === "failed") return { ok: false, error: `Cannot save settings: ${result.error instanceof Error ? result.error.message : "sidecar mutex failed"}` };
		return { ok: false, error: result.status === "busy" ? "Settings file is busy; retry the save" : "Settings save cancelled" };
	}
}
