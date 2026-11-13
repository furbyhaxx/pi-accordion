/*
 * accordion.ts — the pi extension, now the AUTHORITY for a live session's context (Phase B).
 *
 * The truth moved into the extension: it hosts an in-process `Truth` per session (core/truth.ts —
 * the same class the app once ran). pi's `context` hook is a LOCAL operation against that Truth —
 * NO 250ms GUI plan round trip. A client (the GUI) is a REPLICA + remote control over protocol v22.
 *
 * Per-hook loop (all local, no disk I/O, no await on any client):
 *   1. reconcile pi's `event.messages` against the Truth by a cheap durable-id walk. If it is our
 *      last-processed array plus a new suffix, linearize ONLY the suffix and append (O(Δ) text
 *      work). If it diverges structurally (compaction / fork / tree-nav / another extension rewrote
 *      it), REBUILD the Truth from scratch, re-mark all sent, and force clients to resnapshot —
 *      counted in telemetry.
 *   2. // PHASE C: wire-departing hold — a no-op seam where the conductor's last-moment fold plugs in.
 *   3. if folding is enabled (default OFF; a GUI command toggles it) → `truth.serializeWire` and
 *      return the replacement; else return undefined (passthrough). Either way the view stays live.
 *   4. markSent through the last serialized block.
 *   5. measure the whole hook duration and stream it as `telemetry`.
 *
 * `message_end` / `agent_end` append the finished message(s) to the Truth immediately — this kills
 * the one-turn lag. `model_select` → truth.setContextWindow. The agent's `unfold`/`recall` tools
 * resolve LOCALLY against the Truth (no client needed).
 *
 * Every Truth mutation emits a TruthEvent; a single subscription forwards each as a REPLAYABLE
 * `event` to all connected clients (append / ops / config / locks / sent / reset), rev-stamped.
 * A client replays inputs through its own replica Truth and resnapshots on a rev mismatch. Human
 * actions arrive as `command` messages; the host applies them and the resulting events echo back
 * (no optimistic apply on the client — loopback echo is sub-ms).
 *
 * Connection model: "pull" (docs/adr/0001-pi-live-integration.md). Each pi session binds an
 * ephemeral loopback port and advertises ~/.accordion/sessions/<id>.json for discovery; the
 * browser-served static UI + `/__accordion/sessions` + all WS auth (origin/token/loopback) are
 * UNCHANGED from before. `/__accordion/meta` now reports hook telemetry instead of plan outcomes.
 *
 * Safety:
 *   • No disk I/O on the `context` hook path.
 *   • Folding the live agent is OPT-IN and OFF by default; disabled ⇒ the model call is untouched.
 *   • pi's native /compact is suppressed ONLY while a client is attached.
 *   • The shared serialization (Truth.serializeWire → applyPlan) carries the provider-safety rules
 *     (durable-id + kind checks); the engine never folds a protected block.
 *
 * Register it in ~/.pi/agent/settings.json:
 *   { "extensions": ["<repo>/extension/accordion.ts"] }
 */
import { WebSocketServer, WebSocket } from "ws";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import * as http from "node:http";
import * as crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Type } from "typebox";
import { BLOCK_REASONS, TASK_ACTIONS, TaskError, TaskStore, runTasksTracked, type TaskList, type TasksArgs } from "./tasks";
import { TaskWidgetController } from "./tui/taskWidget";
import { DIALS_ENTRY, describeSource, dialsRecordsOf, formatTokens, parseTokens, resolveDials, type DialKind, type DialsRecord, type ResolvedDials } from "./dials";
import { NOTICE_MESSAGE, TaskSession, attachedList, type StartReason } from "./taskSession";
import { emptySpanRefusal, IDLE_ENTRY, idleVerdict, TaskCoach } from "./taskCoach";
import { deliverContext, deliveryKey, liveDeliveryKeys, PIN_LIMITS, PinError } from "./taskPins";
import { symbolFiles, warmSymbols } from "./taskSymbols";
import { taskEventOf } from "./taskEvents";
import { ADOPTED_ENTRY, adoptionOf, applyAdoption, deriveAdoption, needsAdoption, type Adoption } from "./taskAdoption";
import { TaskEventQueue, withTaskEvents } from "../core/taskEvents";
import { UNFOLD_ENTRY, VERDICT_ENTRY, taskfoldVerdicts, unfoldStatesOf, verdictsOf } from "../conductors/in-process/taskfold/verdicts";
import { TaskfoldConductor } from "../conductors/in-process/taskfold/taskfold";
import { taskfoldRouting } from "../conductors/in-process/taskfold/routing";
import { createRouting } from "./taskRouting";
import { nativeCompletion, type CompletionFunction } from "./nativeCompletion";
import { refusalMessage, type TaskViewsHost } from "./tui/taskViews";
import { transcriptSource, transcriptSpans } from "./tui/taskTranscript";
import { DUMP_FORMATS, dumpDocument, dumpFileName, formatOfPath, parseFormatSpec, renderDump, withExtension, type DumpFormat } from "./tui/transcriptDump";
import { foldToolRow, noticeRow, tasksDetails, tasksRow, toolRowRenderers, type TasksDetails } from "./tui/toolRows";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { Truth } from "../core/truth";
import { wireFoldable } from "../core/digest";
import { estTokens } from "../core/tokens";
import { linearize, messageInfo, contentFingerprint, wireToBlock, type PiMessage } from "../core/wire";
import type { Block } from "../core/types";
import { serializeSnapshot, wireEventFromTruthEvent } from "../core/replica";
import { resolveUnfoldBounded } from "../core/agentView";
import { RECALL_POLICY, RecallAccount, recallRefusal, serveRecall } from "../core/recallAccount";
import { FactLedger, LEDGER_ENTRY, LEDGER_MIN_TOKENS, LEDGER_OUTPUT_TOKENS, LEDGER_SYSTEM, ledgerChunks, ledgerData, ledgerOf, verifiedRows, type FactRow } from "../core/factLedger";
import { foldedTasks } from "../core/recallView";
import { ASK_ANSWER_TOKENS, ASK_SYSTEM, askAnswer, askFallback, askMaterial, askPrompt } from "../core/recallAsk";
import { expireRecall } from "../core/recallExpiry";
import { guardResults } from "../core/resultGuard";
import { taskReports } from "../conductors/in-process/taskfold/taskReports";
import { applyGuardingHostOnly, sanitizeOps, type OpResult } from "../core/ops";
import type { TruthEvent } from "../core/events";
import {
	PROTOCOL_VERSION,
	DOOR_PORT,
	sanitizeCommand,
	sanitizeSurfaceId,
	sanitizeSurfaceLabel,
	type Role,
	type ServerMessage,
	type StreamMessage,
	type WireCommand,
	type ControllerInfo,
} from "../core/protocol";
import { LiveConductorHost, type SpawnedRunner } from "../core/conductor/liveHost";
import { catalogMeta, entryById, type RegistryEntry } from "../core/conductor/registry";
import type { CompletionRequest, CompletionResult, ClassificationRequest, ClassificationResult } from "../core/conductor/contract";
import { conductorReadiness, resolveRunnerPath as resolveConductorRunnerPath, runnerNodeBinary } from "./conductorReadiness";
import { openAccordionPanel, type PanelTabId } from "./tui/panel";
import { AlertGate, footerText, statusLevel } from "./tui/status";
import type { AccordionTuiHost } from "./tui/host";
import { connectRemoteSession, listLiveSessions as discoverNativeSessions } from "./tui/remote";
import {
	loadSettings,
	saveSettings,
	generateMemorableToken,
	VALID_DOOR_SECRET_RE,
	isLoopbackHost,
	sanitizeBindHost,
	sanitizeDoorPort,
	sanitizeCustomToken,
	resolveModelSpec,
	splitModelSpec,
	isLoopbackUrl,
	type AccordionSettings,
} from "./settings";
import {
	REGISTRY_PROTOCOL,
	REGISTRY_DIR,
	SESSIONS_SUBDIR,
	FOCUS_FILE,
	CONTROLLER_FILE,
	DOOR_SECRET_FILE,
	HEARTBEAT_INTERVAL_MS,
	isLiveEntry,
	isFreshLease,
	isControllerLease,
	type SessionEntry,
	type FocusRequest,
	type ControllerLease,
} from "../app/src/lib/live/registry";

// Phase B: pi's `context` hook is a LOCAL operation against the in-process Truth — there is no
// GUI plan round trip, so the old ACCORDION_PLAN_TIMEOUT_MS / ACCORDION_PLAN_DEADLINE_MS knobs and
// the unfold/recall reply timeouts are gone. unfold/recall resolve synchronously against Truth.

// WebSocket frames otherwise inherit ws's 100 MiB default. Plans and control messages are
// normally kilobytes; 8 MiB leaves ample headroom while bounding allocation + JSON.parse work.
const MAX_WS_PAYLOAD_BYTES = 8 * 1024 * 1024;
// Browser-served session A may switch to session B without possessing B's token. B verifies A
// through A's loopback-only /__accordion/meta endpoint plus the live registry. Bound that
// upgrade-time probe so an unrelated local port cannot tie up verifier work indefinitely.
const SIBLING_ORIGIN_PROBE_MS = 750;
const SIBLING_ORIGIN_META_MAX_BYTES = 16 * 1024;
const MAX_PENDING_SIBLING_ORIGIN_PROBES = 8;
// Phase C: an attached conductor's out-of-band `complete()` launches real provider work. Keep the
// spend bound process-wide (across in-process + spawned conductors) and finish before the wire's own
// safety timeout.
const MAX_CONCURRENT_COMPLETIONS = 4;
const COMPLETION_TIMEOUT_MS = 110_000;
// ── the door (ADR 0024) ──────────────────────────────────────────────────────
// Slow, best-effort cadence at which a standing-by extension re-attempts to bind the door port
// after it found it held by ANOTHER live Accordion door — so when that holder dies, this extension
// claims the door within a few seconds. NEVER on the context hook (a bare unref'd timer).
const DOOR_RETRY_MS = 4_000;
// Bounded probe of the door port's /__accordion/meta (reuses the sibling-origin probe bound), used
// both to classify an EADDRINUSE occupant (live Accordion vs. foreign software) and to decide the
// /accordion URL. Never blocks a model call.
const DOOR_PROBE_MS = 750;
// Door-secret recovery (ADR 0024 §8/§9). When the secret file is absent or INVALID (empty/partial —
// a crashed or mid-write creator), re-attempt the atomic ensure on a bare unref'd timer instead of
// giving up with an empty (unusable) secret. Bounded so a permanently-broken file can't spin forever.
const DOOR_SECRET_RETRY_MS = 400;
const DOOR_SECRET_MAX_TRIES = 10;
// An INVALID secret file older than this is treated as an abandoned crash artifact and unlinked so
// the atomic create can re-run — no legitimate writer holds the file invalid for anywhere near this
// long (a tmp+link create is sub-millisecond). Bounded convergence: two extensions both recovering
// race the link/EEXIST primitive rather than fighting.
const DOOR_SECRET_STALE_MS = 10_000;
/**
 * Three-way classification of whatever holds the door port (C2/S3):
 *   • "accordion"  — a completed 200 from a loopback peer that is a MATCHING-version live Accordion
 *                    (served:true AND protocolVersion===PROTOCOL_VERSION AND its sessionId is in the
 *                    registry). Trust it: stand down this cycle, and /accordion may print the door URL.
 *   • "foreign"    — a COMPLETED HTTP response that fails the served/shape check (definitive evidence
 *                    of non-Accordion software). Permanent stand-down for this run.
 *   • "transient"  — probe timeout, connection error/refused, or an Accordion of a DIFFERENT protocol
 *                    version (served:true but protocolVersion mismatched), or a matching Accordion whose
 *                    sessionId we could not confirm in the registry (likely a startup race). Ambiguous:
 *                    keep retrying, NEVER permanent, and NEVER trust it with the secret door URL.
 */
type DoorProbe = "accordion" | "foreign" | "transient";
// ── the controller lease (ADR 0024) ──────────────────────────────────────────
// The lease-holder's extension refreshes controller.json's heartbeat this often while a matching
// socket is connected; other extensions observe changes by polling + content-comparing the file
// this often (no mtime gating — see pollControllerFile).
// Both are bare unref'd timers, best-effort, NEVER on the context hook.
const CONTROLLER_HEARTBEAT_MS = 2_000;
const CONTROLLER_POLL_MS = 1_000;
// Fixed cookie name for the shared door secret. Unlike the per-session webToken cookie (port-
// qualified so two sessions on the same host don't clobber each other), the door secret is shared
// across every extension, so a single stable name survives a door takeover (the value stays valid).
const DOOR_COOKIE = "accordion_door";

interface RuntimeDependencies {
	/** Test seam mirroring dc037bc: production resolves pi-ai lazily through pi's package alias. */
	complete?: CompletionFunction;
	openPanel?: typeof openAccordionPanel;
	beforeControllerHeartbeatWrite?: () => void;
}
// Vite's fixed localhost:1420 Origin is browser-obtainable, unlike Tauri's production custom
// origins. Trust it only for an explicit local development session; shipped installs stay closed.
const ALLOW_TAURI_DEV_ORIGIN = process.env.ACCORDION_ALLOW_TAURI_DEV_ORIGIN === "1";

/** Origins used by Accordion's Tauri webview. Normal web pages cannot mint these origins. */
function isTrustedTauriOrigin(origin: string): boolean {
	let u: URL;
	try { u = new URL(origin); } catch { return false; }
	if (u.username || u.password) return false;
	// Tauri v2 production origins: tauri://localhost on macOS/Linux and
	// https://tauri.localhost on Windows (the latter may also be http in older WebView2 builds).
	if (u.protocol === "tauri:" && u.hostname === "localhost" && !u.port) return true;
	if ((u.protocol === "https:" || u.protocol === "http:") && u.hostname === "tauri.localhost" && !u.port) return true;
	// tauri.conf.json's Vite development URL — opt-in only because port 1420 is not a
	// cryptographically distinguished origin and may be occupied by unrelated local content.
	return ALLOW_TAURI_DEV_ORIGIN
		&& u.protocol === "http:"
		&& (u.hostname === "localhost" || u.hostname === "127.0.0.1")
		&& u.port === "1420";
}

// Base dir is overridable for tests (smoke.mjs) so they don't touch the real home.
const HOME = process.env.ACCORDION_HOME || os.homedir();
const REGISTRY_ROOT = path.join(HOME, REGISTRY_DIR);
const SESSIONS_DIR = path.join(REGISTRY_ROOT, SESSIONS_SUBDIR);
const FOCUS_PATH = path.join(REGISTRY_ROOT, FOCUS_FILE);
const CONTROLLER_PATH = path.join(REGISTRY_ROOT, CONTROLLER_FILE);
const DOOR_SECRET_PATH = path.join(REGISTRY_ROOT, DOOR_SECRET_FILE);

/**
 * The door's loopback port. Fixed at DOOR_PORT (ADR 0024), but overridable via ACCORDION_DOOR_PORT
 * for TEST ISOLATION (mirrors ACCORDION_HOME) — a smoke run points it at a free port so it never
 * collides with a real running door, and `0`/invalid DISABLES the door entirely (bind nothing).
 * Read dynamically (not cached) so a test can flip it between extension instances. Production never
 * sets the env, so it is always DOOR_PORT.
 */
function currentDoorPort(): number | null {
	const raw = process.env.ACCORDION_DOOR_PORT;
	if (raw === undefined) return DOOR_PORT;
	const n = Number(raw);
	if (!Number.isInteger(n) || n <= 0 || n > 65535) return null; // 0 / invalid ⇒ door disabled
	return n;
}

/** The door retry cadence, overridable via ACCORDION_DOOR_RETRY_MS for fast tests (default DOOR_RETRY_MS). */
function currentDoorRetryMs(): number {
	const raw = process.env.ACCORDION_DOOR_RETRY_MS;
	if (raw === undefined) return DOOR_RETRY_MS;
	const n = Number(raw);
	return Number.isInteger(n) && n > 0 ? n : DOOR_RETRY_MS;
}

/** Door-secret recovery retry cadence, overridable via ACCORDION_DOOR_SECRET_RETRY_MS for fast tests
 *  (default DOOR_SECRET_RETRY_MS). Test-only seam; production always uses DOOR_SECRET_RETRY_MS. */
function currentDoorSecretRetryMs(): number {
	const raw = process.env.ACCORDION_DOOR_SECRET_RETRY_MS;
	if (raw === undefined) return DOOR_SECRET_RETRY_MS;
	const n = Number(raw);
	return Number.isInteger(n) && n > 0 ? n : DOOR_SECRET_RETRY_MS;
}

/** Controller heartbeat cadence, overridable via ACCORDION_CONTROLLER_HEARTBEAT_MS for fast tests
 *  (default CONTROLLER_HEARTBEAT_MS). Test-only seam mirroring ACCORDION_DOOR_RETRY_MS; production
 *  never sets the env, so it is always CONTROLLER_HEARTBEAT_MS. */
function currentControllerHeartbeatMs(): number {
	const raw = process.env.ACCORDION_CONTROLLER_HEARTBEAT_MS;
	if (raw === undefined) return CONTROLLER_HEARTBEAT_MS;
	const n = Number(raw);
	return Number.isInteger(n) && n > 0 ? n : CONTROLLER_HEARTBEAT_MS;
}

/** Controller poll cadence, overridable via ACCORDION_CONTROLLER_POLL_MS for fast tests
 *  (default CONTROLLER_POLL_MS). Test-only seam; production always uses CONTROLLER_POLL_MS. */
function currentControllerPollMs(): number {
	const raw = process.env.ACCORDION_CONTROLLER_POLL_MS;
	if (raw === undefined) return CONTROLLER_POLL_MS;
	const n = Number(raw);
	return Number.isInteger(n) && n > 0 ? n : CONTROLLER_POLL_MS;
}

const ACCORDION_APP_FLAG = "accordion-app";
const ACCORDION_HOST_FLAG = "accordion-host";
const ACCORDION_PORT_FLAG = "accordion-port";
const ACCORDION_TOKEN_FLAG = "accordion-token";
const ACCORDION_APP_ENV = "ACCORDION_APP_PATH";

// The live link binds an OS-assigned ephemeral port on loopback (127.0.0.1) only — a
// same-machine surface. The desktop app's discovery dials 127.0.0.1; the browser-served
// page auto-connects to the same origin. There is no remote/off-loopback bind mode.

/** True if a socket peer address is loopback (127.0.0.1 / ::1, incl. IPv4-mapped IPv6). */
function isLoopbackPeer(addr: string | undefined | null): boolean {
	if (!addr) return false;
	const a = addr.toLowerCase();
	// Strip the IPv4-mapped IPv6 prefix so 127.0.0.1 is recognized under dual-stack.
	const v4 = a.startsWith("::ffff:") ? a.slice(7) : a;
	return v4 === "127.0.0.1" || v4 === "::1" || v4 === "localhost";
}

type LaunchSource = "cli" | "env" | "default";
type LaunchResult =
	| { ok: true; path: string; source: LaunchSource }
	| { ok: false; reason: "explicit-invalid"; path: string; source: Extract<LaunchSource, "cli" | "env"> }
	| { ok: false; reason: "not-found" }
	| { ok: false; reason: "spawn-failed"; path: string; source: LaunchSource; error: unknown };

function cleanExplicitPath(value: unknown): string | null {
	if (typeof value !== "string") return null;
	let s = value.trim();
	if (!s) return null;
	// This is still a path-only override, not shell parsing. Stripping one matching
	// quote pair makes common copied Windows paths ("C:\\...\\Accordion.exe") work.
	if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1, -1).trim();
	if (s === "~") return os.homedir();
	if (s.startsWith("~/") || s.startsWith("~\\")) return path.join(os.homedir(), s.slice(2));
	return s;
}

function isLaunchableFile(p: string): boolean {
	try {
		return fs.statSync(p).isFile();
	} catch {
		return false;
	}
}

function windowsInstallCandidates(): string[] {
	if (process.platform !== "win32") return [];
	const roots = [
		process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "Accordion"),
		process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Accordion"),
		process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "Accordion"),
		process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Accordion"),
	].filter((s): s is string => !!s);
	const names = ["Accordion.exe", "app.exe"];
	const out: string[] = [];
	for (const root of roots) for (const name of names) out.push(path.join(root, name));
	return out;
}

function repoAppCandidates(): string[] {
	try {
		const here = path.dirname(fileURLToPath(import.meta.url));
		const repo = path.resolve(here, "..");
		const ext = process.platform === "win32" ? ".exe" : "";
		return [
			path.join(repo, "app", "src-tauri", "target", "release", `app${ext}`),
			path.join(repo, "app", "src-tauri", "target", "debug", `app${ext}`),
		];
	} catch {
		return [];
	}
}

function resolveAccordionApp(pi: ExtensionAPI): LaunchResult {
	const flagPath = cleanExplicitPath(pi.getFlag(ACCORDION_APP_FLAG));
	if (flagPath) {
		if (isLaunchableFile(flagPath)) return { ok: true, path: flagPath, source: "cli" };
		return { ok: false, reason: "explicit-invalid", path: flagPath, source: "cli" };
	}

	const envPath = cleanExplicitPath(process.env[ACCORDION_APP_ENV]);
	if (envPath) {
		if (isLaunchableFile(envPath)) return { ok: true, path: envPath, source: "env" };
		return { ok: false, reason: "explicit-invalid", path: envPath, source: "env" };
	}

	for (const candidate of [...windowsInstallCandidates(), ...repoAppCandidates()]) {
		if (isLaunchableFile(candidate)) return { ok: true, path: candidate, source: "default" };
	}
	return { ok: false, reason: "not-found" };
}

async function launchAccordionApp(pi: ExtensionAPI): Promise<LaunchResult> {
	const resolved = resolveAccordionApp(pi);
	if (!resolved.ok) return resolved;
	try {
		const child = spawn(resolved.path, [], { detached: true, stdio: "ignore", shell: false });
		// Catch immediate async launch failures without waiting for the app to boot. Some
		// spawn failures arrive on the child "error" event rather than throwing from spawn().
		return await new Promise<LaunchResult>((resolve) => {
			let settled = false;
			const ok: LaunchResult = { ok: true, path: resolved.path, source: resolved.source };
			const timer = setTimeout(() => finish(ok), 150);
			const finish = (result: LaunchResult) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				child.off("spawn", onSpawn);
				child.unref();
				resolve(result);
			};
			const onSpawn = () => finish(ok);
			const onError = (error: unknown) => finish({ ok: false, reason: "spawn-failed", path: resolved.path, source: resolved.source, error });
			child.once("spawn", onSpawn);
			// Leave this listener installed even after a timeout success; if the OS reports a
			// late error, onError no-ops via `settled` and avoids an unhandled error event.
			child.once("error", onError);
		});
	} catch (error) {
		return { ok: false, reason: "spawn-failed", path: resolved.path, source: resolved.source, error };
	}
}

function launchResultLine(result: LaunchResult | null): { text: string; type: "info" | "warning" } {
	if (!result) return { text: "Accordion focus requested for this session.", type: "info" };
	if (result.ok) return { text: "Launching/focusing Accordion for this session…", type: "info" };
	if (result.reason === "explicit-invalid") {
		const source = result.source === "cli" ? `--${ACCORDION_APP_FLAG}` : ACCORDION_APP_ENV;
		return {
			text: `Accordion focus request written, but ${source} does not point to an executable: ${result.path}`,
			type: "warning",
		};
	}
	if (result.reason === "spawn-failed") {
		return {
			text: `Accordion focus request written, but launching failed for ${result.path}. Set ${ACCORDION_APP_ENV} or --${ACCORDION_APP_FLAG} to the Accordion executable.`,
			type: "warning",
		};
	}
	return {
		text: `Accordion focus request written, but I couldn't find the desktop app. Open Accordion manually, or set ${ACCORDION_APP_ENV} / --${ACCORDION_APP_FLAG}.`,
		type: "warning",
	};
}

export default function accordionLive(pi: ExtensionAPI, dependencies: RuntimeDependencies = {}): void {
	pi.registerFlag(ACCORDION_APP_FLAG, {
		description: "Path to the Accordion desktop app executable for /accordion launch/focus",
		type: "string",
	});
	pi.registerFlag(ACCORDION_HOST_FLAG, {
		description: "Bind address for the Accordion Web UI (default 127.0.0.1; e.g. 0.0.0.0 or Tailscale IP)",
		type: "string",
	});
	pi.registerFlag(ACCORDION_PORT_FLAG, {
		description: "Door port for the Accordion Web UI (default 24317, 0 to disable)",
		type: "string",
	});
	pi.registerFlag(ACCORDION_TOKEN_FLAG, {
		description: "Custom bearer token for the Accordion Web UI",
		type: "string",
	});

	let settings: AccordionSettings = loadSettings(HOME);
	const factLedger = new FactLedger();
	// Tasks whose extraction failed in this process; not retried until the next start.
	const ledgerTried = new Set<string>();
	let ledgerBusy = false;
	// The Truth revision at which every folded task had its ledger; nothing to scan until it changes.
	let ledgerIdleRev = -1;
	let ledgerWarned = false;
	// A session's first Truth holds its history as already sent; the guard repairs that once.
	let guardLoadedSession = false;
	const recallAccount = new RecallAccount(() => ({ ...RECALL_POLICY, callTokens: settings.recall.callTokens, liveTokens: settings.recall.liveTokens }));

	function activeBindHost(): string {
		try {
			const flagHost = pi.getFlag?.(ACCORDION_HOST_FLAG);
			if (typeof flagHost === "string" && flagHost.trim()) return sanitizeBindHost(flagHost);
		} catch { /* ignore */ }
		if (process.env.ACCORDION_HOST) return sanitizeBindHost(process.env.ACCORDION_HOST);
		return settings.bindHost;
	}

	function activeCustomToken(): string | null {
		try {
			const flagTok = pi.getFlag?.(ACCORDION_TOKEN_FLAG);
			const clean = sanitizeCustomToken(flagTok);
			if (clean) return clean;
		} catch { /* ignore */ }
		if (process.env.ACCORDION_TOKEN) {
			const clean = sanitizeCustomToken(process.env.ACCORDION_TOKEN);
			if (clean) return clean;
		}
		return settings.customToken;
	}

	function resolvedDoorPort(): number | null {
		if (process.env.ACCORDION_DOOR_PORT !== undefined) return currentDoorPort();
		try {
			const flagPort = pi.getFlag?.(ACCORDION_PORT_FLAG);
			if (typeof flagPort === "string" && flagPort.trim()) {
				const p = sanitizeDoorPort(flagPort);
				return p > 0 ? p : null;
			}
		} catch { /* ignore */ }
		return settings.doorPort > 0 ? settings.doorPort : null;
	}

	function localConnectHost(): string {
		const h = activeBindHost();
		return h === "0.0.0.0" || h === "::" ? "127.0.0.1" : h;
	}

	function displayWebHost(): string {
		return activeBindHost();
	}

	function activeBrowserToken(): string {
		return activeCustomToken() || doorSecret || webToken;
	}

	function currentWebUrl(): string | null {
		const dp = resolvedDoorPort();
		const host = displayWebHost();
		const tok = activeBrowserToken();
		if (dp !== null && tok && doorHeld) {
			return `http://${host}:${dp}/?token=${tok}`;
		}
		if (port && tok) {
			return `http://${host}:${port}/?token=${tok}`;
		}
		return null;
	}

	function regenerateSharedToken(): string {
		const next = generateMemorableToken();
		settings = saveSettings(HOME, { ...settings, customToken: null });
		webToken = next;
		doorSecret = next;
		try {
			fs.mkdirSync(REGISTRY_ROOT, { recursive: true });
			const tmp = `${DOOR_SECRET_PATH}.${process.pid}.regen.tmp`;
			fs.writeFileSync(tmp, next, { mode: 0o600 });
			fs.renameSync(tmp, DOOR_SECRET_PATH);
		} catch {
			/* best-effort */
		}
		notifyNative();
		return next;
	}

	function compactNow(): { beforeTokens: number; afterTokens: number; message: string } {
		if (!truth) return { beforeTokens: 0, afterTokens: 0, message: "No context to compact." };
		const beforeTokens = truth.stats().liveTokens;
		if (!foldingEnabled) setFolding(true);
		if (!liveHost.activeMeta() && settings.defaultConductor && settings.defaultConductor !== "none") {
			selectConductor(settings.defaultConductor);
		}
		const last = truth.blocks[truth.blocks.length - 1];
		liveHost.fireTurnCommitted(last ? last.turn : 0, truth.rev);
		if (truth.stats().liveTokens >= beforeTokens) {
			const eligible = truth.blocks
				.filter((b) => !truth!.isProtected(b) && !truth!.isFolded(b) && !truth!.held(b) && !truth!.groupOf(b) && wireFoldable(b) && truth!.foldedTokensOf(b) < b.tokens)
				.map((b) => b.id);
			if (eligible.length > 0) {
				truth.apply([{ kind: "fold", ids: eligible }], "auto");
			}
		}
		const afterTokens = truth.stats().liveTokens;
		const saved = Math.max(0, beforeTokens - afterTokens);
		const message =
			saved > 0
				? `Accordion compacted context: ${beforeTokens} → ${afterTokens} tok (−${saved} tok)`
				: `Accordion folding armed (${afterTokens} tok live; remaining blocks are protected or pinned)`;
		return { beforeTokens, afterTokens, message };
	}

	let wss: WebSocketServer | null = null;
	// The HTTP server that BOTH hosts the WebSocket upgrade AND serves the browser
	// build of the Accordion app on the same ephemeral port (feat/browser-served-extension).
	// One server per pi session; closed alongside `wss` at shutdown.
	let httpServer: http.Server | null = null;
	// Per-session token gating the HTTP surface and browser WebSocket upgrades. Native clients
	// without an Origin and the Tauri webview remain tokenless. Browser clients authenticate
	// explicitly, by an exact-origin cookie, or as a verified live sibling Accordion origin.
	let webToken = "";
	// Connected clients (Phase B: broadcast Truth events to ALL). Each carries its declared role;
	// `conductor` is carried through auth + tagged for Phase C. A client is a REPLICA + remote
	// control — it never mutates optimistically, only via the echoed event stream.
	// v16 (ADR 0024): a gui socket also carries the connecting surface's sanitized identity —
	// surfaceId/label decide who may steer (the READ-ONLY controller gate) and who claimed the lease.
	const clients = new Map<WebSocket, { role: Role; surfaceId: string | null; label: string | null }>();
	let sessionId = "";
	let meta = { title: "pi session", cwd: "", model: "", contextWindow: null as number | null, format: "pi" as const };
	let pendingSiblingOriginProbes = 0;
	// Phase C: the socket of the currently-attached spawn conductor (null for none / in-process).
	// `sendToConductor` routes to it; the connection handler sets it on accept, clears it on close.
	let conductorWs: WebSocket | null = null;
	// Most recent full model object (dc037bc's `latestModel`) — a completion needs the whole object
	// (apiKey resolution + maxTokens ceiling), not just the id string kept in `model`.
	let latestModelObj: any = null;
	// Process-wide in-flight completion count, bounded by MAX_CONCURRENT_COMPLETIONS.
	let activeCompletions = 0;

	// -- the door (ADR 0024) --
	// The shared browser bearer secret (32 hex bytes), read/created at startServer from
	// ~/.accordion/door-secret. EVERY extension accepts it wherever the per-session webToken is
	// accepted, which makes the door URL session-independent. Empty until loaded.
	let doorSecret = "";
	// The additional fixed-port listeners this extension binds IFF it currently holds the door.
	let doorServer: http.Server | null = null;
	let doorWss: WebSocketServer | null = null;
	let doorHeld = false;      // we successfully bound and hold the door port
	let doorBinding = false;   // a bind attempt is in flight (guards concurrent tryBindDoor)
	let doorForeign = false;   // the door port is held by NON-Accordion software -> stood down permanently
	let doorRetryTimer: ReturnType<typeof setTimeout> | null = null; // slow re-attempt while an Accordion door holds it
	let doorSecretRetryTimer: ReturnType<typeof setTimeout> | null = null; // re-attempt the secret ensure (absent/invalid file)
	let doorSecretTries = 0;   // bounded retry counter for the secret ensure (DOOR_SECRET_MAX_TRIES)
	let doorSecretGaveUp = false; // exhaustion warned once (parity with the foreign-occupant warn)

	// -- the controller lease (ADR 0024) --
	// In-memory view of the GLOBAL controller.json lease, kept current by our own claim writes and a
	// ~1s poll. null => no lease exists. Enforcement reads this; the poll, the heartbeat, and a claim
	// all re-read the file fresh (content-level, not mtime-gated — see reloadControllerLease / C4).
	let controllerLease: ControllerLease | null = null;
	let lastBroadcastHolder: string | null = null; // last surfaceId we broadcast (dedupe `controller` frames)
	let controllerPollTimer: ReturnType<typeof setInterval> | null = null;
	let controllerHeartbeatTimer: ReturnType<typeof setInterval> | null = null;

	// ── the authoritative Truth (Phase B) ──────────────────────────────────────
	// Span events derived for a session recorded before task events existed (SPEC-0002 §14);
	// overlaid on every message array before it reaches Truth.
	let adoption: Adoption | null = null;

	// The single source of context state for this live session. Built at session_start, rebuilt on
	// structural divergence (compaction / fork / tree-nav / another extension rewriting messages).
	// pi's `context` hook operates against it LOCALLY. `unsubTruth` detaches the event forwarder.
	let truth: Truth | null = null;
	let unsubTruth: (() => void) | null = null;
	// Folding the live agent is OPT-IN and OFF by default (today's armed semantics). Toggled by a
	// GUI `setFolding` command; disabled ⇒ the model call is untouched. Broadcast on change and
	// carried in every snapshot so a reconnecting client sees the current arm.
	let foldingEnabled = false;
	const nativeListeners = new Set<() => void>();
	let nativeSurfaceId: string | null = null;
	let lastNativeSurfaceId: string | null = null;
	let controllerWasFresh = false;
	const nativeRemotes = new Set<{ close(): void }>();
	const pendingControllerClaims = new Set<WebSocket>();
	let controllerLockWarning = false;

	// The last full messages array the Truth was reconciled against (an authoritative `context`
	// snapshot, extended by message_end / agent_end deltas). pi's next `event.messages` is compared
	// against it by a cheap durable-id walk to decide append-a-suffix vs. rebuild.
	let lastMessages: PiMessage[] = [];
	// Index-aligned content fingerprints for `lastMessages` (E1 hardening, sol P1). Computed once at
	// INGEST time so the per-hook identity walk hashes only the fresh INCOMING copy and reads the prev
	// side straight from this cache — never re-hashing already-ingested history on every `context` hook
	// (see `contentFingerprint`'s doc comment for the cost analysis). INVARIANT: `lastFps` is written
	// ONLY through `setLastMessages`, in the SAME statement as `lastMessages`, so the two can never
	// drift out of alignment — a stale/misaligned fingerprint here would silently defeat E1 (a false
	// "same identity" on a real rewrite), the exact failure this cache must never introduce.
	let lastFps: number[] = [];
	function setLastMessages(messages: PiMessage[], fps?: number[]): void {
		lastMessages = messages;
		lastFps = fps ?? messages.map((m) => contentFingerprint(m));
	}

	// ── hook telemetry (replaces the plan-outcome ack) ──────────────────────────
	let hookCount = 0; // total `context` hook invocations this extension lifetime
	let lastHookMs = 0; // most recent hook duration (ms)
	let maxHookMs = 0; // worst hook duration
	let rebuilds = 0; // structural-divergence Truth rebuilds
	let hookErrors = 0; // `context` hook throws caught by the passthrough guard (should stay 0)
	let ingressErrors = 0; // unexpected throws caught at the WS message boundary (should stay 0 — a buggy peer must not crash us)
	const hookDurations: number[] = []; // bounded ring for the p95 readout
	const HOOK_RING = 256;

	// ── token calibration (issue #11 stage 1, ADR 0025) ──────────────────────────
	// `pendingWireEst` is the estimate of the wire the MOST RECENT `context` hook let depart — set
	// there because that is the one place both "what we estimated" and "what actually got sent" are
	// known together. `maybeObserveCalibration` (called from `ingestFinishedMessage`, so it covers
	// both `message_end` and the `agent_end` backstop) pairs it against the resulting assistant
	// message's REAL provider usage and raw-snaps `truth.calibration`. The captured block-order
	// frontier makes that k apply only to blocks actually present on this departing wire (issue #102),
	// never to assistant/tool blocks appended before the receipt arrives. `lastRealTokens`/
	// `lastEstWireTokens` are the raw ingredients of the most recent observation, surfaced on
	// `telemetryMsg()` (protocol v18) so the GUI/smoke tests can audit calibration independently of
	// the derived multiplier.
	let pendingWireEst: number | null = null;
	let pendingCalibrationThroughOrder: number | null = null;
	let lastRealTokens: number | null = null;
	let lastEstWireTokens: number | null = null;

	// Most recent ExtensionContext seen on any hook. Captured so the WS connection handler
	// (which gets no ctx of its own) can read pi's CURRENT session history at attach time — the
	// authoritative way to populate a session that already has turns (especially a RESUMED one).
	let latestCtx: ExtensionContext | null = null;

	// ── discovery (registry) state ──────────────────────────────────────────────
	let port = 0; // actual ephemeral port, filled once the server is listening
	/** A spawned default conductor dials back on `port`, so its selection waits for the listen. */
	let conductorAwaitingPort: string | null = null;
	let startedAt = 0;
	let model = "";
	let tokens: number | null = null;
	let contextWindow: number | null = null;
	// Issue #93: module-level cache of the most recently captured system prompt, same shape as
	// `contextWindow` above and for the same reason — `refreshFromCtx` runs before `truth` may be
	// null/about to be rebuilt (`ingestMessages` → `buildTruth`), so the captured value must survive
	// that gap and get re-applied once a fresh `Truth` exists (see `buildTruth`'s re-apply).
	let systemPromptText: string | null = null;
	let systemPromptTokens = 0;
	let heartbeat: ReturnType<typeof setInterval> | null = null;
	// Set iff the HTTP server's bind failed (e.g. an unexpected EADDRINUSE on the ephemeral port).
	// Previously the "error" listener discarded the error entirely, so `port` stayed 0
	// forever and `/accordion` printed "port starting…" — indistinguishable from a slow,
	// still-booting server. Surfaced verbatim in the /accordion status line instead.
	let bindError: string | null = null;

	const attached = (): boolean => clients.size > 0;

	function send(ws: WebSocket, m: ServerMessage): void {
		try {
			ws.send(JSON.stringify(m));
		} catch {
			/* socket gone */
		}
	}

	/** Send a message to every connected client (Phase B fan-out). */
	function notifyNative(): void {
		for (const listener of nativeListeners) {
			try { listener(); } catch { /* a presentation failure must not affect the session */ }
		}
	}

	function broadcast(m: ServerMessage): void {
		for (const ws of clients.keys()) if (ws.readyState === 1 /* OPEN */) send(ws, m);
		notifyNative();
	}

	/** Forward a host Truth event to every replica as a replayable `event` (null ⇒ nothing to replay). */
	function forwardTruthEvent(e: TruthEvent): void {
		const ev = wireEventFromTruthEvent(e);
		if (ev) broadcast({ type: "event", event: ev });
	}

	/**
	 * Send the current Truth snapshot to one client, or — with `ws` omitted — broadcast it to every
	 * client (the forced resnapshot after a divergence rebuild). A no-op until the Truth exists.
	 */
	function sendSnapshot(ws?: WebSocket): void {
		if (!truth) return;
		const m: ServerMessage = { type: "snapshot", state: serializeSnapshot(truth, foldingEnabled) };
		if (ws) send(ws, m);
		else broadcast(m);
	}

	/** Broadcast a stream lifecycle frame to every attached client (presentation-only ghosts). */
	function sendStream(frame: StreamMessage): void {
		broadcast(frame);
	}

	// ── Phase C: the live conductor host (registry, locks, wire-departing hold, completion relay) ─
	// Fully dependency-injected; every capability it needs — the live Truth, client fan-out, the
	// conductor socket, token minting, the spawn bridge, the completion executor — is a closure over
	// this session's state. It makes NO folding decisions of its own on the hook path.
	const liveHost = new LiveConductorHost({
		truth: () => truth,
		createInProcess: (entry) => entry.id === "taskfold" ? new TaskfoldConductor(settings.taskfold, taskfoldVerdicts) : undefined,
		broadcast,
		sendToConductor: (m) => {
			if (conductorWs && conductorWs.readyState === 1) send(conductorWs, m);
		},
		sendToSocket: (socket, m) => {
			const ws = socket as WebSocket | null;
			if (ws && ws.readyState === 1) send(ws, m);
		},
		mintToken: () => crypto.randomBytes(16).toString("hex"),
		readiness: readinessOf,
		spawnRunner,
		runCompletion,
		runClassification,
		spawnEnv: () => ({ port, sessionKey: sessionId, home: HOME }),
		now: () => Date.now(),
	});

	/** Does any model this conductor sends session content to run off this machine? */
	function leavesMachine(entry: RegistryEntry): boolean {
		for (const type of entry.privacy?.models ?? []) {
			let m: any;
			try {
				m = type === "chat" ? resolveChatModel(entry.id, undefined) : resolveClassifierModel(entry.id, undefined);
			} catch {
				continue; // an unresolvable model receives nothing
			}
			if (m && !isLoopbackUrl(m.baseUrl)) return true;
		}
		return false;
	}

	/**
	 * Attach a conductor through its privacy gate. Ungated, consented or fully local conductors attach
	 * at once (returns true). Otherwise the user confirms once in an interactive session; acceptance is
	 * persisted and attaches the conductor, and a session switch while the dialog is open drops it.
	 */
	function selectConductor(id: string | null): boolean {
		const entry = entryById(id);
		if (!entry?.privacy || settings.privacyConsent[entry.id] || !leavesMachine(entry)) {
			liveHost.select(id);
			return true;
		}
		const ctx = latestCtx;
		if (!ctx?.hasUI) {
			ctx?.ui.notify(`${entry.label} sends session content to a remote model and needs a one-time consent in an interactive session.`, "warning");
			return false;
		}
		const session = sessionId;
		void ctx.ui.confirm(`${entry.label}: privacy notice`, `${entry.privacy.notice}\n\nAccept once and enable ${entry.label}?`).then(
			(accepted) => {
				if (session !== sessionId || !accepted) return;
				settings = saveSettings(HOME, { ...settings, privacyConsent: { ...settings.privacyConsent, [entry.id]: new Date().toISOString() } });
				liveHost.select(entry.id);
			},
			() => {},
		);
		return false;
	}

	// Footer status and one-shot alerts for the active conductor; any broadcast may change them.
	const conductorAlerts = new AlertGate();
	let lastFooter = "";
	let lastConductorLabel: string | null = null;
	function refreshConductorPresentation(): void {
		const ctx = latestCtx;
		if (!ctx) return;
		const status = liveHost.cachedStatus();
		const active = liveHost.activeMeta()?.label ?? null;
		if (active) lastConductorLabel = active;
		const level = statusLevel(status?.metrics);
		const text = footerText({ folding: foldingEnabled, conductor: active, statusText: status?.text ?? null, level });
		try {
			const color = level === "error" ? "error" : level === "warning" ? "warning" : foldingEnabled ? "accent" : "dim";
			const footer = ctx.ui.theme.fg(color, text);
			if (footer !== lastFooter) {
				lastFooter = footer;
				ctx.ui.setStatus("accordion", footer);
			}
			const alert = conductorAlerts.next(active ?? lastConductorLabel, status?.text ?? null, level);
			if (alert) ctx.ui.notify(alert.text, alert.level);
		} catch {
			/* status API optional */
		}
	}
	nativeListeners.add(refreshConductorPresentation);

	// Conductor-declared tools are active only while that conductor is attached.
	const conductorTools = new Set(catalogMeta().flatMap((e) => entryById(e.id)?.tools ?? []));
	let activeConductorTools = "";
	function syncConductorTools(): void {
		const want = entryById(liveHost.activeMeta()?.id ?? null)?.tools ?? [];
		const sig = want.join(",");
		if (sig === activeConductorTools) return;
		activeConductorTools = sig;
		try {
			const keep = pi.getActiveTools().filter((t) => !conductorTools.has(t));
			pi.setActiveTools([...keep, ...want]);
		} catch {
			/* no active session to configure */
		}
	}
	nativeListeners.add(syncConductorTools);

	const conductorsWsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "conductors", "ws");

	/** Required-capability readiness shared by hello metadata and host-side selection enforcement. */
	function readinessOf(entry: RegistryEntry) {
		return conductorReadiness(entry, conductorsWsDir);
	}

	/** Resolve a sanitized spawn runner path. Module requirements are checked separately above. */
	function resolveRunnerPath(entryFile: string): string | null {
		return resolveConductorRunnerPath(conductorsWsDir, entryFile);
	}

	/**
	 * Launch a spawn conductor's runner in its own Node process (NOT detached, so it dies with pi),
	 * piping stderr into a bounded buffer surfaced via `conductorStatus` on an unexpected exit. The
	 * returned handle's `kill()` sends SIGTERM first, SIGKILL on a second call — the grace loop lives
	 * in `LiveConductorHost`. Returns null when the runner disappears after readiness was checked;
	 * selection then fails transactionally without acquiring locks.
	 */
	function spawnRunner(entryFile: string, env: Record<string, string>): SpawnedRunner | null {
		const runnerPath = resolveRunnerPath(entryFile);
		if (!runnerPath) return null;
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(runnerNodeBinary(process.execPath, process.env), [runnerPath], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
		} catch {
			return null;
		}
		let stderrBuf = "";
		const STDERR_CAP = 8 * 1024;
		child.stderr?.on("data", (d: Buffer) => {
			stderrBuf = (stderrBuf + d.toString()).slice(-STDERR_CAP);
		});
		let sigterm = false;
		return {
			kill(): void {
				try {
					child.kill(sigterm ? "SIGKILL" : "SIGTERM");
					sigterm = true;
				} catch {
					/* already dead */
				}
			},
			onExit(cb): void {
				child.on("exit", (code) => cb({ code, stderr: stderrBuf }));
				child.on("error", () => cb({ code: null, stderr: stderrBuf }));
			},
		};
	}

	/**
	 * Fire-and-forget append of one JSON line to `ACCORDION_COMPLETION_LOG`, when set. This is the
	 * only place `runCompletion` records the usage/cost of an out-of-band completion — protocol v22
	 * gives conductors only `CompletionResult { text, model, inputTokens?, outputTokens? }`, so
	 * without this side-log a conductor's spend is invisible to anything summing `host.jsonl` (e.g.
	 * bellows' collector). NEVER on the `context` hook path (disk I/O is fine here — see the doc
	 * comment on `runCompletion` below) and must never throw into, delay, or alter the completion
	 * result: every error is swallowed, and the write is not awaited by the caller.
	 */
	function logCompletion(line: Record<string, unknown>): void {
		const target = process.env.ACCORDION_COMPLETION_LOG;
		if (typeof target !== "string" || target.length === 0) return;
		void fs.promises.appendFile(target, JSON.stringify(line) + "\n").catch(() => {});
	}

	/**
	 * The out-of-band completion executor (ported from dc037bc's completeRequest handler): resolve
	 * the live model's API key, lazily import pi-ai, clamp `maxOutputTokens` to the model's ceiling,
	 * and race the provider call against an abortable timeout. NEVER on the `context` hook path — the
	 * conductor awaits it off to the side. A process-wide semaphore bounds concurrent spend.
	 */
	/** The chat model a conductor's completion resolves to under the user's model routing. */
	function resolveChatModel(conductorId: string | null, requested: string | undefined): any {
		const ctx = latestCtx;
		const spec = resolveModelSpec(settings.models, "chat", conductorId, requested, entryById(conductorId)?.defaultModels?.chat);
		if (spec === "current" || spec === null) return latestModelObj ?? (ctx?.model as any) ?? null;
		const { provider, id } = splitModelSpec(spec);
		const m = (ctx as any)?.modelRegistry?.find?.(provider, id);
		if (!m) throw new Error(`unknown chat model "${spec}"`);
		return m;
	}

	/** The classifier model a conductor's classification resolves to, or a rejection naming why not. */
	function resolveClassifierModel(conductorId: string | null, requested: string | undefined): any {
		const registry = (latestCtx as any)?.modelRegistry;
		if (typeof registry?.findOfType !== "function" || typeof registry?.classify !== "function")
			throw new Error("this Pi host does not expose classifier models to extensions");
		const spec = resolveModelSpec(settings.models, "classifier", conductorId, requested, entryById(conductorId)?.defaultModels?.classifier);
		if (!spec) throw new Error("no classifier model configured (set models.defaults.classifier in ~/.accordion/config.json)");
		const { provider, id } = splitModelSpec(spec);
		const m = registry.findOfType("classifier", provider, id);
		if (!m) throw new Error(`unknown classifier model "${spec}"`);
		return m;
	}

	async function runCompletion(req: CompletionRequest, signal: AbortSignal, conductorId: string | null): Promise<CompletionResult> {
		const startedAt = Date.now();
		if (typeof req.prompt !== "string" || req.prompt.length === 0) throw new Error("missing or empty prompt");
		if (req.maxOutputTokens !== undefined && (!Number.isSafeInteger(req.maxOutputTokens) || req.maxOutputTokens <= 0))
			throw new Error("maxOutputTokens must be a positive safe integer");
		if (activeCompletions >= MAX_CONCURRENT_COMPLETIONS) throw new Error(`too many concurrent completions in flight (max ${MAX_CONCURRENT_COMPLETIONS})`);
		activeCompletions++;
		const abort = new AbortController();
		const onAbort = () => abort.abort();
		if (signal.aborted) abort.abort();
		else signal.addEventListener("abort", onAbort, { once: true });
		const timeoutError = new Error(`completion timed out after ${COMPLETION_TIMEOUT_MS}ms`);
		let timer: ReturnType<typeof setTimeout> | null = null;
		const deadline = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => {
				abort.abort(timeoutError);
				reject(timeoutError);
			}, COMPLETION_TIMEOUT_MS);
			(timer as { unref?: () => void }).unref?.();
		});
		// Non-null only AFTER complete() has actually launched provider work. A client-facing timeout
		// aborts that work and settles this call, but the concurrency slot stays occupied until the
		// underlying provider promise confirms settlement — an adapter that ignores AbortSignal must
		// not let spend accounting reopen a slot while its call is still burning tokens (issue: the
		// `finally` fires when Promise.race settles, i.e. on timeout BEFORE providerCall settles).
		let providerSettlement: Promise<void> | null = null;
		// Captured once a model is resolved so the catch block's failure line can report the same
		// provider/model a success line would have, when available.
		let mForLog: any = null;
		try {
			const ctx = latestCtx;
			const m = ctx ? resolveChatModel(conductorId, req.model) : null;
			if (!ctx || !m) throw new Error("no model available");
			mForLog = m;
			const auth = await Promise.race([(ctx as any).modelRegistry.getApiKeyAndHeaders(m), deadline]);
			if (!auth?.ok) throw new Error(`could not resolve API key: ${auth?.error ?? "unknown"}`);
			const complete: CompletionFunction =
				dependencies.complete ??
				nativeCompletion((ctx as any).modelRegistry, m.provider) ??
				(await Promise.race([import("@earendil-works/pi-ai" as any), deadline])).complete;
			const context = {
				...(typeof req.system === "string" ? { systemPrompt: req.system } : {}),
				messages: [{ role: "user" as const, content: req.prompt, timestamp: Date.now() }],
			};
			let maxTokens: number | undefined;
			if (typeof req.maxOutputTokens === "number") {
				const ceiling = Number.isSafeInteger(m.maxTokens) && m.maxTokens > 0 ? m.maxTokens : undefined;
				maxTokens = ceiling !== undefined ? Math.min(req.maxOutputTokens, ceiling) : req.maxOutputTokens;
			}
			const providerCall = complete(m, context, { apiKey: auth.apiKey, headers: auth.headers, signal: abort.signal, ...(maxTokens !== undefined ? { maxTokens } : {}) });
			// Consume either outcome for cleanup without changing the result used below.
			providerSettlement = providerCall.then(() => {}, () => {});
			const result = await Promise.race([providerCall, deadline]);
			let text = "";
			if (Array.isArray(result.content))
				text = result.content.filter((p: any) => p?.type === "text").map((p: any) => (typeof p?.text === "string" ? p.text : "")).join("");
			const usage = result.usage as { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } } | undefined;
			logCompletion({
				t: "complete",
				at: startedAt,
				conductor: liveHost.activeMeta()?.id ?? null,
				provider: m.provider,
				model: result.model ?? m.id,
				input: typeof usage?.input === "number" ? usage.input : null,
				output: typeof usage?.output === "number" ? usage.output : null,
				cacheRead: typeof usage?.cacheRead === "number" ? usage.cacheRead : null,
				cacheWrite: typeof usage?.cacheWrite === "number" ? usage.cacheWrite : null,
				costUsd: typeof usage?.cost?.total === "number" ? usage.cost.total : null,
				ms: Date.now() - startedAt,
			});
			return {
				text,
				model: result.model,
				inputTokens: typeof result.usage?.input === "number" ? result.usage.input : undefined,
				outputTokens: typeof result.usage?.output === "number" ? result.usage.output : undefined,
			};
		} catch (err) {
			logCompletion({
				t: "complete",
				at: startedAt,
				conductor: liveHost.activeMeta()?.id ?? null,
				provider: mForLog?.provider ?? null,
				model: mForLog?.id ?? null,
				error: err instanceof Error ? err.message : String(err),
				ms: Date.now() - startedAt,
			});
			throw err;
		} finally {
			if (timer) clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
			// Release the concurrency slot only when the provider call itself settles; if we timed out
			// or failed before provider work ever launched, release immediately (there is nothing in
			// flight to keep the slot for).
			const release = (): void => {
				activeCompletions--;
			};
			if (providerSettlement) void providerSettlement.then(release);
			else release();
		}
	}

	/**
	 * The out-of-band classifier executor: resolve the routed classifier model, then run it through
	 * Pi's model registry (request-time auth) under the same concurrency bound and timeout as
	 * completions. The registry never rejects, so a non-`stop` result is turned into a rejection here.
	 */
	async function runClassification(req: ClassificationRequest, signal: AbortSignal, conductorId: string | null): Promise<ClassificationResult> {
		const startedAt = Date.now();
		if (!req.state || typeof req.state !== "object" || Array.isArray(req.state)) throw new Error("classification state must be a JSON object");
		if (!req.questions || typeof req.questions !== "object" || !Object.keys(req.questions).length) throw new Error("classification needs at least one question");
		if (activeCompletions >= MAX_CONCURRENT_COMPLETIONS) throw new Error(`too many concurrent model calls in flight (max ${MAX_CONCURRENT_COMPLETIONS})`);
		const m = resolveClassifierModel(conductorId, req.model);
		activeCompletions++;
		const abort = new AbortController();
		const onAbort = () => abort.abort();
		if (signal.aborted) abort.abort();
		else signal.addEventListener("abort", onAbort, { once: true });
		let timer: ReturnType<typeof setTimeout> | null = null;
		const timeoutError = new Error(`classification timed out after ${COMPLETION_TIMEOUT_MS}ms`);
		const deadline = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => {
				abort.abort(timeoutError);
				reject(timeoutError);
			}, COMPLETION_TIMEOUT_MS);
			(timer as { unref?: () => void }).unref?.();
		});
		const call: Promise<any> = (latestCtx as any).modelRegistry.classify(m, { state: req.state, questions: req.questions }, { signal: abort.signal });
		const settled = call.then(() => {}, () => {});
		const spec = `${m.provider}/${m.id}`;
		try {
			const result = await Promise.race([call, deadline]);
			if (result?.stopReason !== "stop") throw new Error(`classifier ${spec} failed: ${result?.errorMessage ?? result?.stopReason ?? "unknown error"}`);
			logCompletion({ t: "classify", at: startedAt, conductor: conductorId, provider: m.provider, model: m.id, costUsd: result.usage?.cost?.total ?? null, ms: Date.now() - startedAt });
			return { answers: result.answers, model: spec };
		} catch (err) {
			logCompletion({ t: "classify", at: startedAt, conductor: conductorId, provider: m.provider, model: m.id, error: err instanceof Error ? err.message : String(err), ms: Date.now() - startedAt });
			throw err;
		} finally {
			if (timer) clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
			void settled.then(() => {
				activeCompletions--;
			});
		}
	}

	// ── hook telemetry ──────────────────────────────────────────────────────────
	function recordHook(ms: number): void {
		hookCount++;
		lastHookMs = ms;
		if (ms > maxHookMs) maxHookMs = ms;
		hookDurations.push(ms);
		if (hookDurations.length > HOOK_RING) hookDurations.shift();
	}
	function p95HookMs(): number {
		if (!hookDurations.length) return 0;
		const sorted = [...hookDurations].sort((a, b) => a - b);
		return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
	}
	/** The current telemetry frame — one builder for the per-connection seed + the per-hook broadcast. */
	function telemetryMsg(): ServerMessage {
		// lastHoldMs/holdTimeouts (protocol v13) are the REAL wire-departing hold telemetry now: how
		// long the host held the departing wire for the attached conductor's last-moment proposal on
		// the most recent hook, and how many holds have timed out over the session. Both stay 0 while
		// no conductor is attached (no hold is ever fired), so a no-conductor session is unchanged.
		// realTokens/estWireTokens (protocol v18, issue #11 stage 1) are the raw ingredients of the most
		// recent calibration observation — null until the first one lands this session (cold start).
		return {
			type: "telemetry",
			lastHookMs,
			maxHookMs,
			p95HookMs: p95HookMs(),
			rebuilds,
			hookCount,
			lastHoldMs: liveHost.lastHoldMs,
			holdTimeouts: liveHost.holdTimeouts,
			realTokens: lastRealTokens,
			estWireTokens: lastEstWireTokens,
		};
	}
	function broadcastTelemetry(): void {
		broadcast(telemetryMsg());
	}

	// ── registry file: advertise this session for the app to discover ───────────
	function buildEntry(): SessionEntry {
		return {
			registryProtocol: REGISTRY_PROTOCOL,
			protocolVersion: PROTOCOL_VERSION,
			sessionId,
			port,
			pid: process.pid,
			cwd: meta.cwd,
			title: meta.title,
			model,
			tokens,
			contextWindow,
			startedAt,
			heartbeatAt: Date.now(),
		};
	}

	/** Atomic write (temp + rename) so the app never reads a half-written file. */
	function writeEntry(): void {
		if (!port || !sessionId) return;
		try {
			fs.mkdirSync(SESSIONS_DIR, { recursive: true });
			const target = path.join(SESSIONS_DIR, `${sessionId}.json`);
			const tmp = `${target}.${process.pid}.tmp`;
			fs.writeFileSync(tmp, JSON.stringify(buildEntry()));
			fs.renameSync(tmp, target);
		} catch {
			/* discovery is best-effort; never let it break a session */
		}
	}

	function deleteEntry(): void {
		if (!sessionId) return;
		try {
			fs.unlinkSync(path.join(SESSIONS_DIR, `${sessionId}.json`));
		} catch {
			/* already gone */
		}
	}

	/**
	 * Read every OTHER live session's advertised entry alongside our own. This is plain
	 * Node `fs` access (unlike a browser tab, this extension process is never filesystem-
	 * sandboxed) — the same directory the desktop app's Tauri layer reads, just read from
	 * the other side. Powers the browser-served multi-session sidebar (no Tauri required):
	 * any one session's HTTP server can list every session on the machine. Best-effort:
	 * an unreadable directory or a partially-written/corrupt file is skipped, never thrown.
	 *
	 * ASYNC (fs.promises), not fs.*Sync: this runs on the same event loop as the `context` hook,
	 * which is now a LOCAL, synchronous reconcile against the in-process Truth (no plan round
	 * trip) that must stay fast — disk I/O on that path is a documented invariant violation. A
	 * browser tab polls this endpoint every second; synchronous directory/file I/O here would
	 * still share that event loop and add avoidable jitter ahead of the next model call. The
	 * async form yields between files instead.
	 *
	 * Opportunistically REAPS dead entries it encounters (unlike a bare read): a browser-only
	 * user has no desktop app ever running to clean up `~/.accordion/sessions/` after a
	 * SIGKILLed pi (skips session_shutdown's own deleteEntry), so if nothing reaps here, stale
	 * files accumulate forever for exactly this feature's target user. Mirrors the desktop
	 * app's own reap-on-poll behavior (discovery.svelte.ts). Deleting a stale file is itself
	 * best-effort and never blocks the response.
	 */
	async function listLiveSessions(): Promise<SessionEntry[]> {
		const now = Date.now();
		const out: SessionEntry[] = [];
		let names: string[] = [];
		try {
			names = await fs.promises.readdir(SESSIONS_DIR);
		} catch {
			return out;
		}
		for (const name of names) {
			if (!name.endsWith(".json")) continue;
			const filePath = path.join(SESSIONS_DIR, name);
			let raw: unknown;
			try {
				raw = JSON.parse(await fs.promises.readFile(filePath, "utf8"));
			} catch {
				continue; // partial write / corrupt file / deleted mid-scan — skip, never crash
			}
			if (isLiveEntry(raw, now)) {
				out.push(raw);
			} else if (raw && typeof raw === "object" && typeof (raw as { sessionId?: unknown }).sessionId === "string") {
				// Recognizably a registry entry, just stale or an old protocol version — reap it.
				// A merely-paused (not dead) session self-heals: its next heartbeat rewrites the
				// file, so reaping a transient staleness read is harmless — UNLESS that heartbeat
				// lands in the gap between our read above and the unlink below, in which case we'd
				// delete a file a concurrent writeEntry() just atomically renamed into place (a live
				// session's live advertisement). Narrow that window: re-read + re-check staleness
				// immediately before unlinking. This does not ELIMINATE the race (a heartbeat could
				// still land between this re-check and the unlink itself), only narrows it from "one
				// readdir pass" to "one extra read" — accepted, since closing it fully would need a
				// file lock this best-effort registry deliberately doesn't have. Any read/parse
				// failure here (file renamed/deleted mid-recheck) is swallowed: nothing to reap.
				fs.promises
					.readFile(filePath, "utf8")
					.then((freshRaw) => {
						let fresh: unknown;
						try {
							fresh = JSON.parse(freshRaw);
						} catch {
							return; // corrupt/partial re-read — leave it for the next pass
						}
						if (isLiveEntry(fresh, Date.now())) return; // a heartbeat healed it — don't reap
						return fs.promises.unlink(filePath);
					})
					.catch(() => {});
			}
		}
		out.sort((a, b) => a.startedAt - b.startedAt);
		return out;
	}

	/** /accordion writes a one-shot request for the app to focus us once it is open. */
	function writeFocusRequest(): void {
		if (!sessionId) return;
		try {
			fs.mkdirSync(REGISTRY_ROOT, { recursive: true });
			const req: FocusRequest = { sessionId, ts: Date.now() };
			const tmp = `${FOCUS_PATH}.${process.pid}.tmp`;
			fs.writeFileSync(tmp, JSON.stringify(req));
			fs.renameSync(tmp, FOCUS_PATH);
		} catch {
			/* best-effort */
		}
	}

	/**
	 * Read pi's CURRENT session history as an AgentMessage[] (the same shape the
	 * `context` hook delivers), straight from the session manager. This is the
	 * authoritative source for "what's in this session right now" — it works even
	 * when no hook has fired yet (a freshly resumed/loaded session), which is the
	 * exact case where `lastMessages` is still empty.
	 *
	 * Prefer `buildSessionContext()` — pi's own resolver (tree traversal from the
	 * current leaf; collapses compaction/branches to exactly what would go to the
	 * model). It lives on SessionManager but is omitted from the ReadonlySessionManager
	 * type, so we reach it via a guarded cast. Fall back to reconstructing from the
	 * active branch's message entries (already in chronological order).
	 * Best-effort throughout: any failure yields [] and the caller keeps its cache.
	 */
	function readSessionMessages(c: ExtensionContext | null): PiMessage[] {
		if (!c) return [];
		let sm: {
			buildSessionContext?: () => { messages?: unknown };
			getBranch?: (fromId?: string) => Array<{ type: string; message?: unknown }>;
		} | undefined;
		try {
			sm = c.sessionManager as unknown as typeof sm;
		} catch {
			return [];
		}
		if (!sm) return [];
		try {
			const sc = sm.buildSessionContext?.();
			if (sc && Array.isArray(sc.messages)) return sc.messages as PiMessage[];
		} catch {
			/* fall through to the branch reconstruction */
		}
		try {
			const branch = sm.getBranch?.() ?? [];
			const msgs = branch.filter((e) => e.type === "message" && e.message).map((e) => e.message as PiMessage);
			return msgs;
		} catch {
			return [];
		}
	}

	/**
	 * Shared model-window budget-clamp policy. A mid-session swap to a smaller-window model must
	 * shrink an oversized budget, or the aged-summary conductors' 90%-of-budget trigger only fires
	 * after the REAL window is already exhausted (the output-reservation path then declines with
	 * "window too tight"). Clamps DOWN only — never raises budget, so a human's smaller custom
	 * budget (or a swap to a LARGER window) survives untouched. Applied at every call site that
	 * learns/changes the window (`buildTruth`'s rebuild path, `model_select`, and the late-learned
	 * path in `refreshFromCtx`) rather than inside `Truth.setContextWindow` itself — doing it there
	 * would need the emitted `config` event to carry both fields in one rev-bump, but
	 * `core/replica.ts`'s `applyWireEvent` replays `budget`/`contextWindow` fields independently via
	 * the ordinary public setters, so a replica replaying one combined event would double-apply the
	 * clamp and end up one rev ahead of the host. Calling `setBudget` as a separate, ordinary
	 * follow-up call (as done here) emits its own single-field `config` event exactly like any other
	 * human/host budget change, which a replica already replays 1:1 — no protocol change needed.
	 */
	function clampBudgetToWindow(t: Truth, window: number): void {
		if (t.budget > window) t.setBudget(window);
	}

	/** Adopt a model's id + context window into the live + meta state (best-effort). */
	function applyModel(m: { id?: string; provider?: string; contextWindow?: number } | undefined): void {
		if (!m) return;
		if (latestModelObj && (latestModelObj.id !== m.id || latestModelObj.provider !== m.provider)) {
			pendingWireEst = null;
			pendingCalibrationThroughOrder = null;
			lastRealTokens = null;
			lastEstWireTokens = null;
			truth?.setCalibration(1, -1);
		}
		// Keep the FULL model object — an out-of-band completion needs it (apiKey resolution, the
		// maxTokens ceiling), not just the id string. `model: "current"` then follows a just-selected
		// model immediately instead of waiting for the next `context` hook to refresh `latestCtx`.
		latestModelObj = m;
		if (m.id) {
			model = m.id;
			meta.model = m.id;
		}
		// Set the window independent of `id` — some providers surface a usable
		// contextWindow even when id is momentarily absent (the registry showed this).
		if (typeof m.contextWindow === "number" && m.contextWindow > 0) {
			contextWindow = m.contextWindow;
			meta.contextWindow = m.contextWindow;
		}
	}

	/** Pull model id + live usage off the hook context (best-effort). */
	function refreshFromCtx(ctx: ExtensionContext): void {
		try {
			applyModel(ctx.model as { id?: string; contextWindow?: number } | undefined);
			const u = ctx.getContextUsage?.();
			if (u) {
				tokens = u.tokens;
				if (typeof u.contextWindow === "number") {
					contextWindow = u.contextWindow;
					meta.contextWindow = u.contextWindow;
				}
			}
			// Late-learned window: `buildTruth` may have run with `contextWindow` still null (left the
			// 70_000 default budget in place), or the window only becomes known/changes here rather
			// than via `model_select`. Adopt it into the live Truth now, clamping budget DOWN only.
			// Guarded on an actual change so a steady-state hook tick (this runs before every model
			// call) doesn't spam a rev bump/broadcast when nothing moved. On a genuine change the
			// two setters emit config events that reach an attached ViewConductor as `state-changed`,
			// so a swap tick pays for the conductor's synchronous re-conduct on the hook path —
			// CPU-only (no disk I/O), one-time per swap, and only with folding + a conductor active.
			if (truth && contextWindow != null && truth.contextWindow !== contextWindow) {
				truth.setContextWindow(contextWindow);
				clampBudgetToWindow(truth, contextWindow);
			}
			applyDials();
			// Issue #93: capture the CURRENT effective system prompt on every hook tick (never at
			// `session_start` — that races pi's own `resources_discover`-driven rebuild, see
			// `ExtensionContext.getSystemPrompt`'s call site history). `getSystemPrompt` is a cheap field
			// read, not a rebuild, and reflects any per-turn `before_agent_start` override already
			// applied — the effective prompt is NOT guaranteed static across a session (pi can rebuild it
			// on a model/tool-set change), so this diffs on every tick rather than capturing once.
			// Optionally-typed cast: guards a version-skewed pi host that predates this API.
			const sp = (ctx as { getSystemPrompt?: () => string }).getSystemPrompt?.();
			if (typeof sp === "string") {
				systemPromptText = sp;
				systemPromptTokens = estTokens(sp);
			}
			if (truth && systemPromptText !== null && truth.systemPrompt?.text !== systemPromptText) {
				truth.setSystemPrompt(systemPromptText, systemPromptTokens);
			}
		} catch {
			/* optional APIs */
		}
	}

	// ── static file serving for the browser build ──────────────────────────────
	// extension→MIME map. Unknown extensions fall back to application/octet-stream.
	const MIME: Record<string, string> = {
		".html": "text/html; charset=utf-8",
		".js": "text/javascript",
		".mjs": "text/javascript",
		".css": "text/css",
		".json": "application/json",
		".png": "image/png",
		".svg": "image/svg+xml",
		".ico": "image/x-icon",
		".woff2": "font/woff2",
		".woff": "font/woff",
		".txt": "text/plain",
		".map": "application/json",
	};

	/**
	 * Resolve the directory holding the browser build, or null if none exists.
	 * Two layouts:
	 *   • dist/client          — the PUBLISHED layout (build-client.mjs copies app/build here)
	 *   • ../app/build         — the repo DEV layout (SvelteKit's adapter-static output)
	 * First existing wins; checked on every request (cheap) so a build appearing later works.
	 */
	function resolveClientRoot(): string | null {
		try {
			const here = path.dirname(fileURLToPath(import.meta.url));
			const candidates = [path.join(here, "dist", "client"), path.resolve(here, "..", "app", "build")];
			for (const dir of candidates) {
				try {
					if (fs.statSync(dir).isDirectory()) return dir;
				} catch {
					/* try next */
				}
			}
		} catch {
			/* fall through to null */
		}
		return null;
	}

	// Cookie name is PORT-QUALIFIED (not just "accordion_token"): cookies are host-scoped, not
	// port-scoped, so two sessions on the same host (e.g. two pi sessions both browser-served on
	// 127.0.0.1, different ports) would otherwise clobber each other's cookie — opening session B
	// overwrites A's `accordion_token` cookie, and A's next cookie-authed request 403s. Qualifying
	// by port keeps each session's cookie distinct. `port` is closed over and only read from
	// request handlers, which never run before `startServer`'s `listen` callback sets it.
	function accordionCookieName(): string {
		return `accordion_token_p${port}`;
	}

	/**
	 * True iff `token` is one this extension accepts as a bearer: the per-session `webToken` OR the
	 * shared door secret (v16, ADR 0024). EVERY extension accepts the door secret wherever the
	 * webToken is accepted — that is what makes the door URL session-independent and lets a
	 * door-served page dial any sibling session's ephemeral port.
	 *
	 * Security posture (honest version — an earlier comment wrongly said "both live on disk"): the
	 * per-session `webToken` is MEMORY-ONLY — minted with `crypto.randomBytes` per session, never
	 * written to disk (a `SessionEntry`/`buildEntry` carries no token). Only the door secret is a file
	 * (`~/.accordion/door-secret`). What stops a hostile WEB PAGE is unchanged and is the boundary that
	 * matters: it can read neither files nor this process's memory, so neither secret is reachable to
	 * it. A same-user LOCAL process is explicitly OUTSIDE the threat model — it can already read pi's
	 * own session data on disk directly, so reading `door-secret` grants it nothing new. What the door
	 * secret DOES newly introduce, versus the ephemeral in-memory webToken, and which is owned rather
	 * than hand-waved: it is persisted (survives reboots), never rotated for the life of the file,
	 * shared machine-wide, and rides a bookmarkable URL (history/bookmark-sync exposure — the address
	 * bar is scrubbed client-side after capture, S1b, but a link the user copies/shares still carries a
	 * live, non-expiring, machine-wide credential). Secret rotation is a NAMED FOLLOW-UP, not shipped.
	 */
	function isBearer(token: string | null | undefined): boolean {
		if (typeof token !== "string" || !token) return false;
		const custom = activeCustomToken();
		if (custom && token === custom) return true;
		if (webToken && token === webToken) return true;
		if (doorSecret && token === doorSecret) return true;
		return false;
	}

	/** Is this request authenticated for static-file serving? (bearer token query OR a matching cookie.) */
	function isWebAuthed(req: http.IncomingMessage, u: URL): boolean {
		if (isBearer(u.searchParams.get("token"))) return true;
		const cookie = req.headers["cookie"];
		if (typeof cookie !== "string") return false;
		const parts = cookie.split(";").map((c) => c.trim());
		const custom = activeCustomToken();
		if (custom && (parts.includes(`${DOOR_COOKIE}=${custom}`) || parts.includes(`${accordionCookieName()}=${custom}`))) return true;
		if (webToken && parts.includes(`${accordionCookieName()}=${webToken}`)) return true;
		if (doorSecret && parts.includes(`${DOOR_COOKIE}=${doorSecret}`)) return true;
		return false;
	}

	/**
	 * HTTP request handler — serves the browser build of the Accordion app, gated by a
	 * per-session token. Runs ENTIRELY off the pi `context`/model-call hook path: it does
	 * no folding, touches no plan, and a failure to serve a file never crashes a session
	 * (every path is wrapped). The token gates file serving; `/meta` is ungated (loopback-only).
	 */
	function handleHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
		try {
			const u = new URL(req.url || "/", "http://127.0.0.1");

			// Meta endpoint. UNGATED — the whole surface is loopback-only, and local tooling (the
			// smoke test, bellows polling from the same machine) and the browser's own same-origin
			// fetch all depend on reading it without a token.
			if (u.pathname === "/__accordion/meta") {
				res.writeHead(200, { "Content-Type": "application/json" });
				// Phase B telemetry: the `context` hook is a local operation, so instead of plan
				// outcomes we report the hook-duration stream (proving the local path is fast) plus
				// the structural-rebuild count and the current folding-enabled arm. `served`/
				// `sessionId`/`protocolVersion` are unchanged (the sibling-origin probe depends on them).
				res.end(
					JSON.stringify({
						served: true,
						sessionId,
						protocolVersion: PROTOCOL_VERSION,
						telemetry: { hookCount, lastHookMs, maxHookMs, p95HookMs: p95HookMs(), rebuilds, hookErrors, ingressErrors, foldingEnabled },
					}),
				);
				return;
			}

			// Session list — powers the browser-served multi-session sidebar. TOKEN-GATED
			// (unlike /meta): it reveals cwd/title/model across every live session on the
			// machine, not just this one, so it must not be reachable without the token — a
			// leaked token for THIS session otherwise exposes every other live session's
			// port/cwd/title/model too. An accepted tradeoff for the multi-session sidebar.
			if (u.pathname === "/__accordion/sessions") {
				if (!isWebAuthed(req, u)) {
					res.writeHead(403, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: "forbidden" }));
					return;
				}
				void listLiveSessions().then(
					(sessions) => {
						res.writeHead(200, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ sessions }));
					},
					() => {
						res.writeHead(500, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ error: "internal error" }));
					},
				);
				return;
			}

			// Everything below is the static file surface — token-gated.
			if (!isWebAuthed(req, u)) {
				res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
				res.end("Forbidden — open Accordion via the /accordion command's Browser link (it carries the session token).");
				return;
			}
			// A valid ?token mints a cookie so subsequent same-origin requests (the SvelteKit
			// asset fetches, which don't carry the query string) stay authenticated. The webToken and
			// the shared door secret each mint their OWN cookie: the webToken's is port-qualified (per
			// session), the door secret's is the fixed DOOR_COOKIE (shared, survives a door takeover).
			const headers: Record<string, string> = {};
			const qtoken = u.searchParams.get("token");
			const custom = activeCustomToken();
			if (webToken && qtoken === webToken) {
				headers["Set-Cookie"] = `${accordionCookieName()}=${webToken}; HttpOnly; SameSite=Strict; Path=/`;
			} else if (doorSecret && qtoken === doorSecret) {
				headers["Set-Cookie"] = `${DOOR_COOKIE}=${doorSecret}; HttpOnly; SameSite=Strict; Path=/`;
			} else if (custom && qtoken === custom) {
				headers["Set-Cookie"] = `${DOOR_COOKIE}=${custom}; HttpOnly; SameSite=Strict; Path=/`;
			}

			const root = resolveClientRoot();
			if (!root) {
				res.writeHead(404, { ...headers, "Content-Type": "text/plain; charset=utf-8" });
				res.end("No browser build found. Run `npm run build` in app/, or `npm run build:client` in extension/.");
				return;
			}

			// Map the URL path to a file under root. "/" → index.html.
			let rel = decodeURIComponent(u.pathname);
			if (rel === "/") rel = "/index.html";
			let filePath = path.join(root, rel);

			// Path-traversal guard: the resolved absolute path MUST stay under root.
			const rootResolved = path.resolve(root);
			if (path.resolve(filePath) !== rootResolved && !path.resolve(filePath).startsWith(rootResolved + path.sep)) {
				res.writeHead(403, { ...headers, "Content-Type": "text/plain; charset=utf-8" });
				res.end("Forbidden");
				return;
			}

			// SPA fallback: adapter-static emits `fallback: index.html`. If the requested
			// path doesn't exist AND has no file extension (i.e. it's a client route, not a
			// missing asset), serve index.html so deep links / refreshes work. A missing
			// path WITH an extension is a genuine 404.
			let exists = false;
			try {
				exists = fs.statSync(filePath).isFile();
			} catch {
				exists = false;
			}
			if (!exists) {
				if (path.extname(rel) === "") {
					filePath = path.join(root, "index.html");
				} else {
					res.writeHead(404, { ...headers, "Content-Type": "text/plain; charset=utf-8" });
					res.end("Not found");
					return;
				}
			}

			let body: Buffer;
			try {
				body = fs.readFileSync(filePath);
			} catch {
				res.writeHead(404, { ...headers, "Content-Type": "text/plain; charset=utf-8" });
				res.end("Not found");
				return;
			}
			const mime = MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream";
			res.writeHead(200, { ...headers, "Content-Type": mime });
			res.end(body);
		} catch {
			// Best-effort: never let a serving error escape and crash the session.
			try {
				res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
				res.end("Internal error");
			} catch {
				/* response already gone */
			}
		}
	}

	function hasAccordionCookie(req: http.IncomingMessage): boolean {
		const cookie = req.headers.cookie;
		return !!webToken && typeof cookie === "string"
			&& cookie.split(";").some((part) => part.trim() === `${accordionCookieName()}=${webToken}`);
	}

	/** v16: does this request carry the shared door-secret cookie? (The door-served page's ambient
	 *  auth for its no-query asset fetches; still gated by an exact-served-Origin check at upgrade.) */
	function hasDoorCookie(req: http.IncomingMessage): boolean {
		const cookie = req.headers.cookie;
		if (typeof cookie !== "string") return false;
		const custom = activeCustomToken();
		return cookie.split(";").some((part) => {
			const trimmed = part.trim();
			return (!!doorSecret && trimmed === `${DOOR_COOKIE}=${doorSecret}`)
				|| (!!custom && trimmed === `${DOOR_COOKIE}=${custom}`);
		});
	}

	/**
	 * Cookies are ambient and host-scoped, not port-scoped. Only accept Accordion's cookie when
	 * the browser Origin exactly names this upgrade Host. On default loopback binds we also require
	 * a literal loopback hostname; when the user explicitly binds a non-loopback address, we accept
	 * matching Host headers for that listener.
	 */
	function isExactServedOrigin(req: http.IncomingMessage, origin: string): boolean {
		const host = req.headers.host;
		if (typeof host !== "string" || !host) return false;
		try {
			const u = new URL(origin);
			if (u.protocol !== "http:" || u.username || u.password) return false;
			if (u.host.toLowerCase() !== host.trim().toLowerCase()) return false;
			const hostname = u.hostname.toLowerCase();
			if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]") return true;
			const configuredHost = activeBindHost().toLowerCase();
			if (!isLoopbackHost(configuredHost)) {
				return configuredHost === "0.0.0.0" || configuredHost === "::" || hostname === configuredHost;
			}
			return false;
		} catch {
			return false;
		}
	}

	/**
	 * Browser-served mode intentionally supports switching from session A's page to sibling B.
	 * A does not know B's token, so B verifies that A is a currently live Accordion loopback
	 * origin. A literal host check defeats DNS rebinding; a bounded live /meta probe proves
	 * current port ownership; the matching registry identity prevents an unrelated local HTTP
	 * service from authorizing itself by copying the public JSON shape.
	 */
	function isKnownAccordionLoopbackOrigin(origin: string): Promise<boolean> {
		let u: URL;
		try { u = new URL(origin); } catch { return Promise.resolve(false); }
		if (u.protocol !== "http:" || u.username || u.password) return Promise.resolve(false);
		const hostname = u.hostname.toLowerCase();
		if (hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "[::1]") return Promise.resolve(false);
		const originPort = Number(u.port || 80);
		if (!Number.isSafeInteger(originPort) || originPort <= 0 || originPort > 65535) return Promise.resolve(false);
		if (pendingSiblingOriginProbes >= MAX_PENDING_SIBLING_ORIGIN_PROBES) return Promise.resolve(false);
		const requestHost = hostname === "[::1]" ? "::1" : hostname;
		pendingSiblingOriginProbes++;

		return new Promise((resolve) => {
			let settled = false;
			let request: http.ClientRequest | null = null;
			const finish = (ok: boolean): void => {
				if (settled) return;
				settled = true;
				pendingSiblingOriginProbes--;
				clearTimeout(deadline);
				resolve(ok);
			};
			const deadline = setTimeout(() => {
				request?.destroy();
				finish(false);
			}, SIBLING_ORIGIN_PROBE_MS);
			request = http.get({ hostname: requestHost, port: originPort, path: "/__accordion/meta" }, (response) => {
				if (response.statusCode !== 200 || !isLoopbackPeer(response.socket.remoteAddress)) {
					response.destroy();
					finish(false);
					return;
				}
				const contentType = response.headers["content-type"];
				if (typeof contentType !== "string" || !contentType.toLowerCase().includes("application/json")) {
					response.destroy();
					finish(false);
					return;
				}
				const chunks: Buffer[] = [];
				let bodyBytes = 0;
				response.on("data", (chunk: Buffer) => {
					bodyBytes += chunk.length;
					if (bodyBytes > SIBLING_ORIGIN_META_MAX_BYTES) {
						response.destroy();
						finish(false);
						return;
					}
					chunks.push(chunk);
				});
				response.on("end", () => {
					if (settled) return;
					try {
						const sibling = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
							served?: unknown; sessionId?: unknown; protocolVersion?: unknown;
						};
						if (sibling.served !== true || typeof sibling.sessionId !== "string" || sibling.protocolVersion !== PROTOCOL_VERSION) {
							finish(false);
							return;
						}
						void listLiveSessions().then(
							(sessions) => finish(sessions.some((s) => s.sessionId === sibling.sessionId && s.port === originPort)),
							() => finish(false),
						);
					} catch {
						finish(false);
					}
				});
				response.on("aborted", () => finish(false));
				response.on("error", () => finish(false));
			});
			request.on("error", () => finish(false));
		});
	}

	/**
	 * Loopback binding blocks network peers, but not cross-site WebSocket hijacking: browsers do
	 * not apply CORS to WebSocket handshakes. A hostile page that finds the ephemeral port could
	 * otherwise replace the GUI, read the backlog, and steer plans.
	 */
	function verifyWsUpgrade(info: { req: http.IncomingMessage }, cb: (res: boolean, code?: number, message?: string) => void): void {
		const req = info.req;
		const peerLoopback = isLoopbackPeer(req.socket.remoteAddress);
		if (!peerLoopback && isLoopbackHost(activeBindHost())) {
			cb(false, 403, "loopback connection required");
			return;
		}

		let token: string | null;
		try {
			token = new URL(req.url || "/", "http://accordion.local").searchParams.get("token");
		} catch {
			// ws does not protect callback-style verifyClient from a synchronous throw.
			cb(false, 400, "bad request target");
			return;
		}

		// PHASE C: a conductor-role socket is authorized SOLELY by the single-use pending attach token
		// the host minted when it spawned this runner — role confers NO privilege on its own.
		if (roleFromUrl(req.url) === "conductor") {
			if (!peerLoopback) {
				cb(false, 403, "conductor requires loopback");
				return;
			}
			const pending = liveHost.pendingAttachToken;
			const ok = !!pending && token === pending;
			cb(ok, ok ? undefined : 403, ok ? undefined : "conductor attach token required");
			return;
		}

		const origin = req.headers.origin;
		// Tokenless native/Tauri clients are allowed ONLY from loopback peers.
		if (peerLoopback && (typeof origin !== "string" || origin === "")) { cb(true); return; } // native client
		if (peerLoopback && isTrustedTauriOrigin(origin)) { cb(true); return; }
		if (isBearer(token)) { cb(true); return; } // explicit bearer (webToken, doorSecret, or customToken)
		// A page served by us (webToken cookie) OR by the door (door-secret cookie) — both still gated
		// by an exact-served-Origin check so an ambient host-scoped cookie can't authorize cross-port.
		if (typeof origin === "string" && (hasAccordionCookie(req) || hasDoorCookie(req)) && isExactServedOrigin(req, origin)) { cb(true); return; }

		if (!peerLoopback) {
			cb(false, 403, "remote WebSocket requires valid token");
			return;
		}

		// A browser page served by another live Accordion session is the one intentional
		// cross-origin path. verifyClient supports an asynchronous callback.
		void isKnownAccordionLoopbackOrigin(origin).then(
			(ok) => cb(ok, ok ? undefined : 403, ok ? undefined : "cross-origin WebSocket blocked"),
			() => cb(false, 403, "cross-origin WebSocket blocked"),
		);
	}

	// -- door secret: the shared browser bearer (ADR 0024 §8) --
	// One value, written EXACTLY once, stable for as long as any extension has it cached. Creation is
	// atomic-WITH-CONTENT: write the full secret to a same-dir tmp file (0600), then
	// fs.linkSync(tmp, DOOR_SECRET_PATH) -- the destination appears with COMPLETE bytes or not at all,
	// and EEXIST means a racer won (adopt theirs). This replaces the earlier "wx" open-then-write,
	// whose open->write gap let a racer read empty/partial bytes and cache "" with NO retry, and whose
	// crash window (creator dies between open and write) left a permanently invalid file on disk.
	// (Still deliberately NOT write-rename like controller.json: a rename would clobber an in-use
	// secret out from under every extension that already cached + handed it out. link/EEXIST keeps
	// first-writer-wins; the tmp step just guarantees the winner's bytes are complete.)
	// Reader side: an absent/invalid read schedules a BOUNDED re-attempt on an unref'd timer (never a
	// one-shot give-up), and an invalid file whose mtime is older than DOOR_SECRET_STALE_MS is a
	// crashed creator's artifact -- unlinked and re-created (two extensions both recovering converge
	// via the link/EEXIST primitive rather than fighting). The retry budget (~22s of linear backoff)
	// deliberately exceeds the staleness threshold (10s), so a young invalid file always ages into
	// reapability within the budget. The door itself is GATED on a valid secret: tryBindDoor refuses
	// to bind while doorSecret is "", and the retry timer re-kicks it the moment the secret resolves,
	// so the door is never up (nor its URL printable) while the bearer it would serve is empty.
	// Retries exhausted => doorSecret stays "" (no door; the per-session webToken path is unaffected,
	// and every bearer/cookie comparison pre-checks doorSecret so "" can never match).
	const DOOR_SECRET_RE = VALID_DOOR_SECRET_RE;

	/** The on-disk secret iff present AND well-formed (8-char memorable or 64-hex), else null. */
	function readValidDoorSecret(): string | null {
		try {
			const existing = fs.readFileSync(DOOR_SECRET_PATH, "utf8").trim();
			return DOOR_SECRET_RE.test(existing) ? existing : null;
		} catch {
			return null; // absent / unreadable
		}
	}

	/** Attempt the atomic create (tmp + linkSync). Sets doorSecret iff WE created the file. */
	function tryCreateDoorSecret(): void {
		const secret = generateMemorableToken();
		const tmp = `${DOOR_SECRET_PATH}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
		try {
			fs.mkdirSync(REGISTRY_ROOT, { recursive: true });
			fs.writeFileSync(tmp, secret, { mode: 0o600 });
			try {
				fs.linkSync(tmp, DOOR_SECRET_PATH); // appears with COMPLETE bytes or not at all
				doorSecret = secret;
			} catch (e) {
				const code = (e as NodeJS.ErrnoException)?.code;
				if (code === "EPERM" || code === "ENOSYS" || code === "EXDEV" || code === "ENOTSUP") {
					const fd = fs.openSync(DOOR_SECRET_PATH, "wx", 0o600); // fallback; EEXIST if a racer won
					try { fs.writeSync(fd, secret); } finally { fs.closeSync(fd); }
					doorSecret = secret;
				}
				// EEXIST or anything else: a racer won / creation failed -- caller re-reads + retries.
			}
		} catch {
			/* best-effort: mkdir / tmp write / wx fallback failed -- the bounded retry re-attempts */
		} finally {
			try { fs.unlinkSync(tmp); } catch { /* never created / already gone */ }
		}
	}

	/** Crash recovery: an INVALID secret file whose mtime is older than DOOR_SECRET_STALE_MS has no
	 *  live writer (a tmp+link create is sub-millisecond; even the wx fallback's window is micro-
	 *  seconds) -- unlink it so the atomic create can re-run. Never touches a VALID file, and leaves
	 *  a YOUNG invalid file alone (possibly a legacy-path writer mid-write; it either completes or
	 *  ages into reapability within the retry budget). */
	function reapStaleInvalidDoorSecret(): void {
		try {
			const st = fs.statSync(DOOR_SECRET_PATH);
			if (Date.now() - st.mtimeMs <= DOOR_SECRET_STALE_MS) return;
			if (readValidDoorSecret() !== null) return; // valid -- never reap a good secret
			// Decision made: stale + invalid. Re-stat + re-validate IMMEDIATELY before the unlink to
			// shrink the TOCTOU against a racer that reaped + re-created a VALID file inside our gap --
			// a fresh mtime or now-valid content means a racer just acted, so stand down. The residual
			// window is now just validate->unlink (microseconds) and remains accepted (ADR 0024 par. 8).
			const again = fs.statSync(DOOR_SECRET_PATH);
			if (Date.now() - again.mtimeMs <= DOOR_SECRET_STALE_MS) return;
			if (readValidDoorSecret() !== null) return;
			fs.unlinkSync(DOOR_SECRET_PATH);
		} catch {
			/* absent or unreadable -- nothing to reap */
		}
	}

	/**
	 * Ensure the shared door secret exists on disk, is valid, and is cached in `doorSecret` -- with
	 * bounded retry instead of the old one-shot. Synchronous happy path (valid file, or we win the
	 * create). Otherwise: reap a stale-invalid file, attempt the atomic create, re-read (a racer may
	 * have won), and if STILL unresolved schedule a bounded, linearly backed-off, unref'd re-attempt
	 * that re-kicks the (secret-gated) door bind when the secret finally resolves. Idempotent; a
	 * session swap re-arms it via startServer. Never on the context hook path.
	 */
	function ensureDoorSecret(): void {
		if (doorSecret) return;
		const existing = readValidDoorSecret();
		if (existing !== null) { doorSecret = existing; doorSecretTries = 0; return; }
		reapStaleInvalidDoorSecret();
		tryCreateDoorSecret();
		if (!doorSecret) {
			const again = readValidDoorSecret(); // a racer may have completed while we tried
			if (again !== null) doorSecret = again;
		}
		if (doorSecret) { doorSecretTries = 0; return; }
		if (doorSecretRetryTimer) return;
		if (doorSecretTries >= DOOR_SECRET_MAX_TRIES) {
			// P3: exhaustion must not be silent (parity with the foreign-occupant warn). One line, once:
			// e.g. a persistently-invalid file we may not unlink, or EACCES on every create attempt.
			if (!doorSecretGaveUp) {
				doorSecretGaveUp = true;
				console.warn(`[accordion] door secret could not be created or read after ${DOOR_SECRET_MAX_TRIES} attempts (${DOOR_SECRET_PATH}); the stable door URL is unavailable this run`);
			}
			return;
		}
		doorSecretTries++;
		doorSecretRetryTimer = setTimeout(() => {
			doorSecretRetryTimer = null;
			ensureDoorSecret();
			if (doorSecret) tryBindDoor(); // the secret just resolved -- the gated door bind may proceed
		}, currentDoorSecretRetryMs() * doorSecretTries); // linear backoff: n * base
		doorSecretRetryTimer.unref?.();
	}

	// -- the door: an ADDITIONAL fixed-port listener, one extension at a time (ADR 0024) --
	/**
	 * Probe the door port's /__accordion/meta and CLASSIFY the occupant (C2/S3, DoorProbe above). This
	 * is deliberately STRICTER than the old served:true-only trust: a completed response that only sets
	 * served:true is not enough to print the secret door URL at it — it must also match this protocol
	 * version and name a session in the registry. And, critically, a timeout / connection error / a
	 * mismatched-version Accordion is "transient", NOT foreign: a busy or momentarily-unavailable peer
	 * must never trigger a PERMANENT door stand-down. Bounded (DOOR_PROBE_MS); never on the hook path.
	 */
	function probeDoor(): Promise<DoorProbe> {
		const dp = resolvedDoorPort();
		if (dp === null) return Promise.resolve("transient");
		const probeHost = isLoopbackHost(activeBindHost()) || activeBindHost() === "0.0.0.0" || activeBindHost() === "::" ? "127.0.0.1" : activeBindHost();
		return new Promise((resolve) => {
			let settled = false;
			let request: http.ClientRequest | null = null;
			const finish = (result: DoorProbe): void => {
				if (settled) return;
				settled = true;
				clearTimeout(deadline);
				resolve(result);
			};
			// A timeout means we never got a completed response — AMBIGUOUS (a busy/slow peer), not foreign.
			const deadline = setTimeout(() => { request?.destroy(); finish("transient"); }, DOOR_PROBE_MS);
			request = http.get({ hostname: probeHost, port: dp, path: "/__accordion/meta" }, (response) => {
				if (probeHost === "127.0.0.1" && !isLoopbackPeer(response.socket.remoteAddress)) { response.destroy(); finish("transient"); return; }
				// A COMPLETED non-200 HTTP response is a live server that isn't our (ungated, always-200)
				// /meta contract — definitive foreign software.
				if (response.statusCode !== 200) { response.destroy(); finish("foreign"); return; }
				const chunks: Buffer[] = [];
				let bodyBytes = 0;
				response.on("data", (chunk: Buffer) => {
					bodyBytes += chunk.length;
					if (bodyBytes > SIBLING_ORIGIN_META_MAX_BYTES) { response.destroy(); finish("foreign"); return; }
					chunks.push(chunk);
				});
				response.on("end", () => {
					if (settled) return;
					let meta: { served?: unknown; sessionId?: unknown; protocolVersion?: unknown };
					try {
						meta = JSON.parse(Buffer.concat(chunks).toString("utf8"));
					} catch { finish("foreign"); return; } // completed response, unparseable body → foreign
					// Fails the served/shape check → foreign (a completed response from non-Accordion software).
					if (meta.served !== true || typeof meta.sessionId !== "string") { finish("foreign"); return; }
					// An Accordion of a DIFFERENT protocol version — do NOT trust it with the secret URL, but
					// do NOT permanently stand down either (it's still Accordion). Keep retrying.
					if (meta.protocolVersion !== PROTOCOL_VERSION) { finish("transient"); return; }
					// Best-effort registry confirmation: a matching sessionId in the live registry proves this
					// really is our peer. If we can't confirm it (registry read fails, or the session isn't
					// listed yet — a startup race), treat it as ambiguous rather than trusting the secret URL.
					const sid = meta.sessionId;
					void listLiveSessions().then(
						(sessions) => finish(sessions.some((s) => s.sessionId === sid) ? "accordion" : "transient"),
						() => finish("transient"),
					);
				});
				response.on("aborted", () => finish("transient"));
				response.on("error", () => finish("transient"));
			});
			// A connection error (ECONNREFUSED, ECONNRESET from a peer that exited mid-probe, …) is
			// AMBIGUOUS — never a permanent foreign stand-down.
			request.on("error", () => finish("transient"));
		});
	}

	/** Schedule a slow re-attempt to bind the door (only while a LIVE Accordion door holds it). */
	function scheduleDoorRetry(): void {
		if (doorHeld || doorForeign || doorRetryTimer) return;
		doorRetryTimer = setTimeout(() => { doorRetryTimer = null; tryBindDoor(); }, currentDoorRetryMs());
		doorRetryTimer.unref?.();
	}

	/**
	 * Try to become the door holder: bind the fixed door port as an ADDITIONAL listener serving the
	 * SAME handlers (static UI, /__accordion/*, WS upgrade) as this session's ephemeral server. On
	 * EADDRINUSE, probe + classify the occupant (probeDoor): a matching live Accordion door -> stand by
	 * and re-check on a slow timer; definitive foreign software -> log once and stand down PERMANENTLY;
	 * anything ambiguous (timeout / connection error / other-version Accordion) -> keep retrying, never
	 * permanent. Idempotent (no-op once held / stood down / a bind is already in flight). NEVER on the
	 * context hook.
	 */
	function tryBindDoor(): void {
		if (doorHeld || doorForeign || doorBinding) return;
		const dp = resolvedDoorPort();
		if (dp === null) return; // door disabled (test isolation)
		// GATED on a valid shared secret (ADR 0024 §8): never bind/advertise the door while doorSecret
		// is "" -- a door with no bearer to serve is a door nobody can be authorized through, and the
		// /accordion print path must never see doorHeld=true with an empty secret. ensureDoorSecret's
		// bounded retry re-invokes this the moment the secret resolves.
		if (!doorSecret) { ensureDoorSecret(); if (!doorSecret) return; }
		doorBinding = true;
		let server: http.Server;
		let dwss: WebSocketServer;
		try {
			server = http.createServer(handleHttp);
			dwss = new WebSocketServer({ server, verifyClient: verifyWsUpgrade, maxPayload: MAX_WS_PAYLOAD_BYTES });
		} catch {
			doorBinding = false;
			scheduleDoorRetry();
			return;
		}
		dwss.on("connection", onWsConnection);
		dwss.on("error", () => { /* best-effort: a door WS error runs headless, like the ephemeral one */ });
		server.once("error", (err: NodeJS.ErrnoException) => {
			doorBinding = false;
			try { dwss.close(); } catch { /* ignore */ }
			try { server.close(); } catch { /* ignore */ }
			if (err?.code === "EADDRINUSE") {
				void probeDoor().then((result) => {
					if (result === "accordion") {
						scheduleDoorRetry(); // a matching live Accordion door holds it -> stand by, re-check
					} else if (result === "foreign") {
						if (!doorForeign) {
							doorForeign = true; // definitive non-Accordion software -> permanent stand-down (log once)
							console.warn(`[accordion] door port ${dp} is held by non-Accordion software; the stable door URL is unavailable this run`);
						}
					} else {
						// transient/ambiguous (timeout / connection error / other-version Accordion / unconfirmed
						// session) -> NEVER a permanent stand-down; keep retrying so a busy or momentarily-gone
						// Accordion peer, or one still mid-startup, doesn't disable the door for this whole run.
						scheduleDoorRetry();
					}
				});
			} else {
				scheduleDoorRetry(); // transient -> try again later
			}
		});
		// C3: verified on Windows 11 (2026-07-23) that two SEPARATE node processes racing this exact
		// listen(PORT, "127.0.0.1") do NOT both bind — the loser cleanly gets EADDRINUSE (no SO_REUSEADDR
		// hijack). So the EADDRINUSE probe path above is the sole arbitration; no lockfile is needed.
		server.listen(dp, activeBindHost(), () => {
			doorBinding = false;
			doorServer = server;
			doorWss = dwss;
			doorHeld = true;
			// A post-listen server error (rare) drops the door -> reset + let the retry timer reclaim it.
			server.on("error", () => {
				try { dwss.close(); } catch { /* ignore */ }
				try { server.close(); } catch { /* ignore */ }
				doorServer = null; doorWss = null; doorHeld = false;
				scheduleDoorRetry();
			});
		});
	}

	/** Close the door listener if we hold it (releases the port for a standing-by extension). Also
	 *  stops any pending secret-ensure retry and resets its budget (a session swap re-arms both via
	 *  startServer). The cached doorSecret itself is kept -- it is stable for the process lifetime. */
	function closeDoor(): void {
		if (doorRetryTimer) { clearTimeout(doorRetryTimer); doorRetryTimer = null; }
		if (doorSecretRetryTimer) { clearTimeout(doorSecretRetryTimer); doorSecretRetryTimer = null; }
		doorSecretTries = 0;
		doorSecretGaveUp = false;
		try { doorWss?.close(); } catch { /* ignore */ }
		try { doorServer?.close(); } catch { /* ignore */ }
		doorServer = null; doorWss = null; doorHeld = false; doorBinding = false;
	}

	// -- the controller lease: the GLOBAL single-controller blackboard (ADR 0024) --
	/** Read + parse controller.json (best-effort). Returns the lease or null (absent/corrupt/old-proto).
	 *  S2: controller.json is a shared, ANY-extension-writable (or hand-editable) blackboard, so the
	 *  fields read off it are re-validated through the SAME ingress sanitizers a live `?surface`/`?label`
	 *  dial goes through — a corrupt/hostile file must not ride a malformed id or an unbounded label into
	 *  the lease cache or a `controller` broadcast. A field that fails sanitization ⇒ treat as no lease. */
	function readControllerLease(): ControllerLease | null {
		try {
			const raw = JSON.parse(fs.readFileSync(CONTROLLER_PATH, "utf8"));
			if (!isControllerLease(raw)) return null;
			const surfaceId = sanitizeSurfaceId(raw.surfaceId);
			const label = sanitizeSurfaceLabel(raw.label);
			if (!surfaceId || !label) return null; // reject: same charset/length gate as the dial ingress
			return { ...raw, surfaceId, label };
		} catch {
			return null;
		}
	}

	/** Structural equality on the fields that decide "did the lease change" — content-level so a
	 *  same-mtime foreign rewrite is caught (C4). Compares holder + timestamps, not the file's mtime. */
	function leaseEq(a: ControllerLease | null, b: ControllerLease | null): boolean {
		if (a === b) return true;               // both null (or the same object)
		if (!a || !b) return false;
		return a.surfaceId === b.surfaceId
			&& a.label === b.label
			&& a.claimedAt === b.claimedAt
			&& a.heartbeatAt === b.heartbeatAt;
	}

	/** Read controller.json FRESH into the in-memory cache (content-level, NOT mtime-gated — C4/C1) and
	 *  report whether the lease changed since our cached copy. Never broadcasts (each caller decides). */
	function reloadControllerLease(): { lease: ControllerLease | null; changed: boolean } {
		const next = readControllerLease();
		const changed = !leaseEq(controllerLease, next);
		controllerLease = next;
		return { lease: next, changed };
	}

	// The permanent sidecar is a mutex, not lease storage; never unlink or replace it.
	// SQLite releases its OS lock on close/crash. Upstream writers do not honor this lock.
	function withControllerLeaseLock(action: () => void): "done" | "busy" | "failed" {
		let db: DatabaseSync | undefined;
		try {
			fs.mkdirSync(REGISTRY_ROOT, { recursive: true });
			db = new DatabaseSync(`${CONTROLLER_PATH}.lock.sqlite`);
			db.exec("BEGIN IMMEDIATE");
			action();
			return "done";
		} catch (error) {
			if (error instanceof Error && "errcode" in error && error.errcode === 5) return "busy";
			return "failed";
		} finally {
			try { db?.close(); } catch { /* ignore */ }
		}
	}

	async function claimWithControllerLeaseLock(action: () => void, active: () => boolean): Promise<boolean> {
		const deadline = Date.now() + 5_000;
		while (active() && Date.now() < deadline) {
			const result = withControllerLeaseLock(action);
			if (result === "done") return true;
			if (result === "failed") return false;
			await new Promise<void>((resolve) => setTimeout(resolve, 25));
		}
		return false;
	}

	/** Atomic write-rename of controller.json (same pattern as a registry entry). Updates the in-memory
	 *  cache so a following poll does not re-read our own write as an external change (the content compare
	 *  in reloadControllerLease sees it as unchanged). */
	function writeControllerLease(lease: ControllerLease): void {
		fs.mkdirSync(REGISTRY_ROOT, { recursive: true });
		const tmp = `${CONTROLLER_PATH}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(lease));
		fs.renameSync(tmp, CONTROLLER_PATH);
		controllerLease = lease;
	}

	/** The controller field for a `hello`: the current lease + whether its heartbeat is fresh. */
	function controllerInfo(): ControllerInfo | null {
		const l = controllerLease;
		if (!l) return null;
		return { surfaceId: l.surfaceId, label: l.label, fresh: isFreshLease(l, Date.now()) };
	}

	/** Broadcast a `controller` frame IFF the lease-holder changed since our last broadcast (dedupe). */
	function maybeBroadcastController(): void {
		const holder = controllerLease ? controllerLease.surfaceId : null;
		if (holder === lastBroadcastHolder) return;
		lastBroadcastHolder = holder;
		// No wire "cleared" frame exists (a stale lease surfaces via hello.fresh:false); only a real
		// holder is broadcast.
		if (controllerLease) broadcast({ type: "controller", surfaceId: controllerLease.surfaceId, label: controllerLease.label });
	}

	/** Read controller.json fresh into the cache + broadcast any change (used at connect time). */
	function refreshControllerNow(): void {
		reloadControllerLease();
		maybeBroadcastController();
	}

	/** ~1s poll: adopt an EXTERNAL controller.json change (another extension's claim) + broadcast it.
	 *  C4: a CONTENT compare (not the old mtime early-return) so a same-mtime foreign rewrite is never
	 *  missed. The file read is tiny, so reading it every tick is cheap. */
	function pollControllerFile(): void {
		const { changed } = reloadControllerLease();
		// maybeBroadcastController dedupes on holder, so a pure heartbeat bump (holder unchanged) is a
		// no-op; an absent file resolves to null and is never broadcast as a "cleared" frame.
		if (changed) maybeBroadcastController();
		const fresh = !!controllerLease && isFreshLease(controllerLease, Date.now());
		if (fresh !== controllerWasFresh) { controllerWasFresh = fresh; notifyNative(); }
	}

	/** Refresh a connected holder only after revalidating under the cross-process writer lock. */
	function heartbeatController(): void {
		const { lease, changed } = reloadControllerLease();
		if (changed) maybeBroadcastController(); // a foreign claim we observed this tick — adopt + broadcast it
		if (!lease) return;
		// Avoid acquiring the writer lock when this session has no connected holder.
		let holderConnected = nativeSurfaceId === lease.surfaceId;
		for (const info of clients.values()) if (info.surfaceId && info.surfaceId === lease.surfaceId) { holderConnected = true; break; }
		if (!holderConnected) return;
		dependencies.beforeControllerHeartbeatWrite?.();
		const result = withControllerLeaseLock(() => {
			const { lease: current, changed } = reloadControllerLease();
			if (changed) maybeBroadcastController();
			if (!leaseEq(lease, current)) return;
			writeControllerLease({ ...lease, heartbeatAt: Date.now() });
		});
		if (result === "failed" && !controllerLockWarning) {
			controllerLockWarning = true;
			const text = "Accordion controller lock is unavailable; check the registry permissions.";
			try { latestCtx?.ui.notify(text, "warning"); } catch { /* UI may be unavailable */ }
			broadcast({ type: "notice", text });
		} else if (result === "done") controllerLockWarning = false;
	}

	/** Start the controller poll + heartbeat timers once (idempotent). Both are unref'd, best-effort. */
	function startControllerTimers(): void {
		if (!controllerPollTimer) {
			controllerPollTimer = setInterval(pollControllerFile, currentControllerPollMs());
			controllerPollTimer.unref?.();
		}
		if (!controllerHeartbeatTimer) {
			controllerHeartbeatTimer = setInterval(heartbeatController, currentControllerHeartbeatMs());
			controllerHeartbeatTimer.unref?.();
		}
	}

	/** Stop the controller timers (session teardown). The lease itself is global and left on disk. */
	function stopControllerTimers(): void {
		if (controllerPollTimer) { clearInterval(controllerPollTimer); controllerPollTimer = null; }
		if (controllerHeartbeatTimer) { clearInterval(controllerHeartbeatTimer); controllerHeartbeatTimer = null; }
	}

	/** Parse + sanitize a gui socket's surface identity (`?surface`/`?label`) from its connect URL. */
	function surfaceFromUrl(url: string | undefined): { surfaceId: string | null; label: string | null } {
		try {
			const p = new URL(url || "/", "http://accordion.local").searchParams;
			return { surfaceId: sanitizeSurfaceId(p.get("surface")), label: sanitizeSurfaceLabel(p.get("label")) };
		} catch {
			return { surfaceId: null, label: null };
		}
	}

	/** True iff this socket's surface is the CURRENT FRESH controller (the READ-ONLY steer gate). A
	 *  stale/absent lease is treated as uncontrolled -> not the controller -> commands are refused
	 *  (the client claims first; auto-claim makes this invisible in practice). */
	function isControllerSocket(ws: WebSocket): boolean {
		const info = clients.get(ws);
		const lease = controllerLease;
		if (!lease || !info || !info.surfaceId) return false;
		if (!isFreshLease(lease, Date.now())) return false;
		return lease.surfaceId === info.surfaceId;
	}

	/** Build the READ-ONLY refusal reply for a mutating command from a non-controller surface. For an
	 *  `ops` command, mirror one `read-only` clamp per op so per-tile clamp UX still works; the
	 *  top-level `refused` is the uniform signal for the dial commands that carry no ops. Truth is
	 *  never touched (rev unchanged). */
	function refusedCommandResult(seq: number, cmd: unknown): ServerMessage {
		const parsed = sanitizeCommand(cmd);
		const results: OpResult[] = parsed && parsed.kind === "ops"
			? parsed.ops.map((op) => ({ op, applied: false, clamped: "read-only" as const }))
			: [];
		return { type: "commandResult", seq, results, rev: truth ? truth.rev : 0, refused: "read-only" };
	}

	/** A gui socket claims the global controller lease. Never refused (the human is the authority);
	 *  last write wins on races. Writes controller.json + broadcasts the change of hands. */
	function handleClaimController(ws: WebSocket): void {
		const info = clients.get(ws);
		if (!info || !info.surfaceId || pendingControllerClaims.has(ws)) return;
		pendingControllerClaims.add(ws);
		const surfaceId = info.surfaceId;
		const claimedSession = sessionId;
		void claimWithControllerLeaseLock(() => {
			const now = Date.now();
			// Skip redundant claims while holding the same lock as heartbeat revalidation.
			const { lease: current } = reloadControllerLease();
			if (current && current.surfaceId === surfaceId && isFreshLease(current, now)) {
				maybeBroadcastController();
				return;
			}
			const prior = current && current.surfaceId === surfaceId ? current : null;
			writeControllerLease({
				registryProtocol: REGISTRY_PROTOCOL,
				surfaceId,
				label: info.label || "Surface",
				claimedAt: prior ? prior.claimedAt : now,
				heartbeatAt: now,
			});
			maybeBroadcastController();
		}, () => sessionId === claimedSession && clients.has(ws)).then((ok) => {
			if ((!ok || controllerLease?.surfaceId !== surfaceId) && sessionId === claimedSession && clients.has(ws)) send(ws, { type: "notice", text: "Could not acquire Accordion control; the controller registry is busy or unavailable." });
		}).finally(() => pendingControllerClaims.delete(ws));
	}

	/**
	 * Shared WebSocket connection handler, attached to BOTH this session's ephemeral WS server AND
	 * (whenever we hold it) the fixed DOOR WS server (ADR 0024) — identical auth/replica behavior on
	 * either listener. A gui socket additionally carries its sanitized surface identity and is subject
	 * to the v16 READ-ONLY controller gate; conductor sockets are entirely unaffected.
	 */
	function onWsConnection(ws: WebSocket, req: http.IncomingMessage): void {
		const role = roleFromUrl(req?.url);
		const surface = surfaceFromUrl(req?.url); // v16: the connecting surface's sanitized identity (gui only)
		if (role === "gui") {
			let targetPort: number | null = null;
			try {
				const rawTarget = new URL(req?.url || "/", "http://accordion.local").searchParams.get("targetPort");
				if (rawTarget !== null) {
					const parsed = Number(rawTarget);
					if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 && parsed !== port) {
						targetPort = parsed;
					}
				}
			} catch {
				/* ignore malformed URL */
			}
			if (targetPort !== null) {
				const tp = targetPort;
				const queued: string[] = [];
				let upstream: WebSocket | null = null;
				let closed = false;
				const closeBoth = () => {
					if (closed) return;
					closed = true;
					try { ws.close(); } catch { /* ignore */ }
					try { upstream?.close(); } catch { /* ignore */ }
				};
				ws.on("message", (data: Buffer) => {
					const str = data.toString();
					if (upstream && upstream.readyState === WebSocket.OPEN) {
						try { upstream.send(str); } catch { closeBoth(); }
					} else if (queued.length < 32) {
						queued.push(str);
					}
				});
				ws.on("close", closeBoth);
				ws.on("error", closeBoth);
				void listLiveSessions().then((sessions) => {
					if (closed) return;
					if (!sessions.some((s) => s.port === tp)) {
						closeBoth();
						return;
					}
					const qs = new URLSearchParams();
					if (surface.surfaceId) qs.set("surface", surface.surfaceId);
					if (surface.label) qs.set("label", surface.label);
					upstream = new WebSocket(`ws://${localConnectHost()}:${tp}/?${qs.toString()}`, { maxPayload: MAX_WS_PAYLOAD_BYTES });
					upstream.on("open", () => {
						for (const frame of queued.splice(0)) {
							try { upstream?.send(frame); } catch { closeBoth(); return; }
						}
					});
					upstream.on("message", (data: Buffer) => {
						if (ws.readyState === WebSocket.OPEN) {
							try { ws.send(data.toString()); } catch { closeBoth(); }
						}
					});
					upstream.on("close", closeBoth);
					upstream.on("error", closeBoth);
				}, closeBoth);
				return;
			}
		}
		// PHASE C: a conductor-role socket must consume its single-use attach token before it is
		// treated as the active conductor (the token was already verified at upgrade time; consume
		// it here so a re-dial with the same token is rejected). It STILL joins `clients` and gets
		// the same hello/snapshot/event stream as a GUI — a remote conductor is a replica.
		if (role === "conductor") {
			let token: string | null = null;
			try {
				token = new URL(req?.url || "/", "http://accordion.local").searchParams.get("token");
			} catch {
				/* verifyWsUpgrade already rejected a malformed target */
			}
			if (!liveHost.acceptConductorSocket(ws, token)) {
				try { ws.close(); } catch { /* ignore */ }
				return;
			}
			conductorWs = ws;
		}
		// Bring the Truth up to date with the session's current history BEFORE snapshotting.
		// On a resumed/loaded session no hook has fired yet, so read straight from the session
		// manager. This runs before `ws` joins `clients`, so any resulting append events reach
		// only the ALREADY-connected clients — the new client gets the up-to-date snapshot next.
		//
		// This intentionally still runs even when `truth` already exists (not gated behind
		// `!truth`, i.e. NOT bootstrap-only): `readSessionMessages` reads pi's CURRENT
		// `sessionManager` state, which reflects tree-nav (`session_before_tree`/`session_tree`,
		// which this extension does not hook) the instant it happens — the only other way a
		// tree-nav jump surfaces is the next `context` hook. Gating this to
		// bootstrap-only would leave a client that attaches right after a tree-nav (before the
		// next model call) looking at the stale pre-nav branch. A second client attaching mid-
		// session can still spuriously trip `ingestMessages`' divergence check against
		// `lastMessages` here, forcing a rebuild — but `buildTruth`/`Truth.rebuildFrom` now
		// preserves every surviving block's overlay and the host's dials across that rebuild, so
		// the rebuild this triggers no longer wipes the first client's folds/pins/groups/dials
		// (review finding).
		const history = readSessionMessages(latestCtx);
		if (history.length) ingestMessages(history);

		// v16: re-read the controller lease from disk so this client's hello carries the current lease
		// (and any external change it reveals is broadcast to already-connected clients).
		refreshControllerNow();
		// hello advertises every conductor with host-computed required-capability readiness, plus the
		// current controller lease (v16). Optional degradation remains a runtime status concern.
		send(ws, { type: "hello", protocolVersion: PROTOCOL_VERSION, sessionId, role, meta, conductors: catalogMeta(readinessOf), controller: controllerInfo(), conditionalOps: true });
		sendSnapshot(ws);
		// P1-6: a freshly attached REMOTE conductor gets an initial turn-committed right AFTER its
		// snapshot — by now the spawned SDK has hydrated its replica and run `conductor.attach`, so its
		// listener is live and this drives an immediate pass over existing state instead of idling
		// until the next real turn. (The in-process seam fires its own initial pass inside `select`.)
		if (role === "conductor" && truth) liveHost.fireInitialTurnCommitted();
		// After the snapshot, a (re)connecting client learns who — if anyone — is driving, plus any
		// cached conductor status line, so it never renders from a locally tracked guess.
		const activeMeta = liveHost.activeMeta();
		if (activeMeta) send(ws, { type: "conductorState", active: activeMeta });
		const cachedStatus = liveHost.cachedStatus();
		if (cachedStatus) send(ws, cachedStatus);
		// Seed the client's latency badge with current telemetry (blank until the first hook otherwise).
		send(ws, telemetryMsg());
		// Register only AFTER the snapshot so no event can precede the replica it must replay onto.
		clients.set(ws, { role, surfaceId: surface.surfaceId, label: surface.label });

		ws.on("message", (data: Buffer) => {
			if (!clients.has(ws)) return; // ignore stray messages from a dropped socket
			let msg: any;
			try {
				msg = JSON.parse(data.toString());
			} catch {
				return;
			}
			// ── ingress boundary: authorized ≠ well-formed ─────────────────────────────
			// Clearing WS authorization proves a peer may REACH us, never that its frames are
			// well-formed. An authorized-but-buggy client can send `setBudget:"hello"` (→ NaN budget
			// → JSON-null on the wire → forked replicas) or `ops:[null]` (a raw `op.kind` deref that
			// would throw). Sanitize every inbound command/ops HERE, before it can touch the
			// authoritative Truth, and wrap the whole dispatch so an unexpected throw is caught +
			// counted at this seam — never allowed to escape the WS callback, where an uncaught throw
			// would tear down the live session for every other connected client.
			try {
				if (role === "conductor") {
					// A conductor replica: propose / completeRequest / setConductorStatus route to the
					// live host (which verifies this is the ACTIVE conductor socket), plus resnapshot.
					if (msg?.type === "resnapshot") {
						sendSnapshot(ws);
					} else {
						// Defense-in-depth mirror of the GUI `ops` guard: a `propose`'s ops reach
						// `Truth.apply` inside handleConductorMessage, so scrub structurally-invalid
						// elements (`[null]`, bad kinds) at the boundary before they get there. `null`
						// (not an array) collapses to an empty batch — an honest no-op proposal.
						if (msg?.type === "propose") msg.ops = sanitizeOps(msg.ops) ?? [];
						liveHost.handleConductorMessage(ws, msg);
					}
					return;
				}
				// v16 (ADR 0024): claiming control is allowed from ANY gui socket — the human is the
				// authority, takeover is never refused, last write wins on races. NOT gated by the
				// READ-ONLY controller check (that would make claiming impossible for a non-controller).
				if (msg?.type === "claimController") {
					handleClaimController(ws);
					return;
				}
				// The GUI client→server message: a remote-control command. The host applies it to the
				// authoritative Truth (emitting events to ALL clients) and replies with the per-op
				// results + resulting rev. There is NO optimistic apply on the client — the replica
				// mutates only via the echoed event stream, so a command and its events can't race.
				if (msg?.type === "command" && typeof msg.seq === "number") {
					// v16 READ-ONLY enforcement: a mutating command from a surface that is not the current
					// fresh controller is refused BEFORE it touches the Truth (typed "read-only" clamp). A
					// stale/absent lease counts as uncontrolled -> still refused (the client claims first;
					// auto-claim makes this invisible in practice). resnapshot/claimController are unaffected.
					refreshControllerNow();
					if (!isControllerSocket(ws)) {
						send(ws, refusedCommandResult(msg.seq, msg.cmd));
						return;
					}
					// `sanitizeCommand` returns a safe, applyable WireCommand or null (a NaN/negative
					// dial coerced finite, malformed `ops` dropped). A null result is unusable: refuse
					// it with an empty-results `commandResult` (the clamp-UX shape the GUI already
					// reads) that acks the client's `seq` WITHOUT mutating the Truth (rev unchanged).
					const cmd = sanitizeCommand(msg.cmd);
					if (!cmd) {
						send(ws, { type: "commandResult", seq: msg.seq, results: [], rev: truth ? truth.rev : 0 });
					} else {
						const { results, rev } = applyCommand(cmd);
						send(ws, { type: "commandResult", seq: msg.seq, results, rev });
					}
				} else if (msg?.type === "resnapshot") {
					// The replica diverged (rev mismatch) or saw a `reset` — hand it a fresh snapshot.
					sendSnapshot(ws);
				}
			} catch {
				// A malformed peer must never crash the process (an uncaught throw in a `ws` message
				// listener surfaces as an uncaughtException). Count it (surfaced in /meta telemetry)
				// and drop the frame; the session and every other client stay live.
				ingressErrors++;
			}
		});
		const drop = () => {
			clients.delete(ws);
			if (role === "conductor") {
				if (conductorWs === ws) conductorWs = null;
				liveHost.handleSocketClose(ws); // a clean detach if this was the active conductor
			}
		};
		ws.on("close", drop);
		ws.on("error", drop);
	}

	function startServer(): void {
		if (wss || httpServer) return;
		bindError = null; // fresh attempt — clear any failure a prior call recorded
		ensureDoorSecret();
		// Per-session memorable 8-char token (or shared door/custom token) for the HTTP surface and browser WS upgrades.
		webToken = activeCustomToken() || doorSecret || generateMemorableToken();
		startControllerTimers();
		tryBindDoor();
		try {
			// One HTTP server hosts BOTH halves on the SAME ephemeral loopback port:
			//   • HTTP GETs → handleHttp (the browser build, token-gated)
			//   • WS upgrades → the WebSocketServer below (loopback-only, Origin/token-gated)
			// port 0 ⇒ OS assigns a free ephemeral port (one server per pi session).
			httpServer = http.createServer(handleHttp);
			// Attach the WS server to the HTTP server (NOT { port: 0 }) so the upgrade
			// shares the port. maxPayload bounds memory/parse work before protocol validation.
			wss = new WebSocketServer({ server: httpServer, verifyClient: verifyWsUpgrade, maxPayload: MAX_WS_PAYLOAD_BYTES });
			httpServer.on("error", (err: NodeJS.ErrnoException) => {
				// Unexpected listen failure (e.g. EADDRINUSE): run headless (passthrough), but
				// record and log WHY, so `/accordion` can show a real failure instead of an
				// eternal "port starting…". No retry: a visible failure is the fix.
				const code = err?.code ?? "unknown";
				bindError = `bind failed: ${code}`;
				console.warn(`[accordion] ${bindError}`);
				try { httpServer?.close(); } catch { /* ignore */ }
				httpServer = null;
				wss = null;
			});
			httpServer.listen(0, activeBindHost(), () => {
				const addr = httpServer?.address();
				if (addr && typeof addr === "object") {
					port = addr.port;
					writeEntry(); // advertise immediately, now that the port is known
					const awaiting = conductorAwaitingPort;
					conductorAwaitingPort = null;
					if (awaiting && truth && !liveHost.activeMeta()) selectConductor(awaiting);
					if (!heartbeat) {
						heartbeat = setInterval(writeEntry, HEARTBEAT_INTERVAL_MS);
						heartbeat.unref?.(); // never keep the process alive for a heartbeat
					}
				}
			});
		} catch {
			try { httpServer?.close(); } catch { /* ignore */ }
			httpServer = null;
			wss = null;
			return;
		}
		wss.on("connection", onWsConnection);
		wss.on("error", () => {
			/* e.g. unexpected WS error — run headless (passthrough). Tear down the shared
			   HTTP server too so we don't leave an orphaned listener serving files. */
			try { httpServer?.close(); } catch { /* ignore */ }
			httpServer = null;
			wss = null;
		});
	}

	// ── Phase B host helpers (the truth lives here now) ─────────────────────────

	/** Parse the client role from the connect URL (`?role=conductor`); default "gui". */
	function roleFromUrl(url: string | undefined): Role {
		try {
			const r = new URL(url || "/", "http://accordion.local").searchParams.get("role");
			return r === "conductor" ? "conductor" : "gui";
		} catch {
			return "gui";
		}
	}

	/** The current folding arm, echoed in snapshots + on toggle. Only broadcasts on a real change. */
	function setFolding(on: boolean): void {
		if (foldingEnabled === on) return;
		foldingEnabled = on;
		broadcast({ type: "folding", enabled: foldingEnabled });
	}

	/**
	 * (Re)build the authoritative Truth from a full messages array. Subscribes the event forwarder
	 * so every subsequent Truth mutation streams to clients as a replayable `event`. Uses
	 * `Truth.rebuildFrom` so a structural-divergence rebuild (the CURRENT `truth`, captured as
	 * `prev` below, is non-null) carries over every surviving block's overlay, `birthFolded`
	 * membership, scalar dials, and fully-surviving groups from the truth being replaced — a
	 * rebuild must reconcile pi's messages, not silently wipe every human/host fold, pin, group,
	 * and dial (review finding). `prev === null` (session_start already nulled `truth`) skips
	 * carryover: a brand-new session has nothing to preserve. Sets `wireAttached` + the known
	 * context window BEFORE subscribing so those internal bumps ride the snapshot, not a stray event.
	 */
	function buildTruth(messages: PiMessage[]): void {
		messages = applyAdoption(messages, adoption);
		if (unsubTruth) {
			unsubTruth();
			unsubTruth = null;
		}
		const prev = truth;
		const blocks = linearize(messages).map(wireToBlock);
		const t = Truth.rebuildFrom(prev, { meta: { format: "pi", title: meta.title, cwd: meta.cwd, model: meta.model }, blocks, lineCount: 0, skipped: 0 });
		t.wireAttached = true; // a live pi session is always a live wire (durability-aware accounting)
		if (contextWindow != null) {
			t.setContextWindow(contextWindow);
			// Snap the budget to the model window only on the FIRST build (no prior human dial to
			// respect). A rebuild already carried `prev`'s budget via `rebuildFrom` — re-snapping it
			// here on every divergence would silently undo a human's custom budget (part of the same
			// finding: a rebuild must preserve the human's dials, not just per-block overlay). But a
			// rebuild that coincides with (or trails) a swap to a smaller-window model must still
			// clamp an oversized carried-over budget DOWN — never raise it — same policy as every
			// other window-change call site (model-window budget clamp fix).
			if (!prev) t.setBudget(contextWindow);
			else clampBudgetToWindow(t, contextWindow);
		}
		// Issue #93: re-apply the captured system prompt, same shape as `contextWindow` above. Covers
		// the very-first-hook case (`refreshFromCtx` ran while `truth` was still null, so its own
		// apply-if-changed branch was skipped) and is a harmless no-op confirmation on a later rebuild
		// (`Truth.rebuildFrom` already carried `prev`'s identical value). Placed BEFORE `onEvent`
		// subscribes below, so this call's own `config` event — if any — never double-broadcasts.
		if (systemPromptText !== null) t.setSystemPrompt(systemPromptText, systemPromptTokens);
		// One subscription drives BOTH the client fan-out (replayable events) and the in-process
		// conductor's HostEvent stream — the same TruthEvent, projected two ways.
		unsubTruth = t.onEvent((e) => {
			forwardTruthEvent(e);
			liveHost.dispatchTruthEvent(e);
		});
		truth = t;
		if (!prev) {
			recallAccount.reset();
			guardLoadedSession = true;
		}
		setLastMessages(messages); // fingerprints the full array once (rare rebuild path) — see lastFps
		if (!prev) applyDials();
	}

	/** Replace used recall results by one-line stubs, all in one transaction so the cache breaks once (SPEC-0003 §4). */
	function releaseRecall(earlierPrompts: boolean): void {
		if (!truth || !foldingEnabled) return;
		const ops = expireRecall(truth, { keepSteps: settings.recall.keepSteps, earlierPrompts });
		if (ops.length) truth.apply(ops, "auto");
	}

	// ── budget and protected tail: per model, remembered in the session (see dials.ts) ──
	let dialRecords: DialsRecord[] = [];
	// The model the current budget/tail were resolved for; a different model re-resolves them.
	let dialModel: string | null = null;

	function modelSpec(): string | null {
		const m = latestModelObj as { id?: string; provider?: string } | null;
		return m?.id && m.provider ? `${m.provider}/${m.id}` : null;
	}

	function currentDials(): (ResolvedDials & { model: string | null }) | null {
		const spec = modelSpec();
		return spec ? { ...resolveDials(spec, contextWindow, dialRecords, settings.modelDefaults), model: spec } : null;
	}

	/** Set budget and tail for the current model when it differs from the one they were set for. */
	function applyDials(): void {
		const spec = modelSpec();
		if (!truth || !spec || spec === dialModel) return;
		const r = resolveDials(spec, contextWindow, dialRecords, settings.modelDefaults);
		dialModel = spec;
		if (r.budget !== null && r.budget !== truth.budget) truth.setBudget(r.budget);
		if (r.protect !== truth.protectTokens) truth.setProtect(r.protect);
	}

	/** Remember a budget or tail the user set, for the current model, in the session file. */
	function recordDial(kind: DialKind, value: number): void {
		const spec = modelSpec();
		if (!spec) return;
		const rec: DialsRecord = { model: spec, [kind]: value };
		dialRecords.push(rec);
		dialModel = spec;
		try {
			pi.appendEntry(DIALS_ENTRY, rec);
		} catch {
			/* no session to record into (print mode) */
		}
	}

	/** Make `value` the default `kind` for the current model in config.json. */
	function saveDialDefault(kind: DialKind, value: number): string {
		const spec = modelSpec();
		if (!spec) return "The current model is not known yet";
		const prev = settings.modelDefaults[spec] ?? {};
		settings = saveSettings(HOME, { ...settings, modelDefaults: { ...settings.modelDefaults, [spec]: { ...prev, [kind]: formatTokens(value) } } });
		notifyNative();
		return `Saved ${kind === "budget" ? "budget" : "protected tail"} ${formatTokens(value)} as the default for ${spec}`;
	}

	/**
	 * Rebuild on structural DIVERGENCE (compaction / fork / tree-nav / another extension rewriting
	 * messages). Counts the rebuild in telemetry and forces every connected client to resnapshot.
	 * The first build (session_start, `truth === null`) is NOT a divergence rebuild.
	 */
	function rebuildTruth(messages: PiMessage[]): void {
		const isDivergence = truth !== null;
		buildTruth(messages);
		if (isDivergence) {
			// `Truth.rebuildFrom` intentionally drops the old receipt frontier: inserted/reordered blocks
			// make it ambiguous. Drop its pending/audit ingredients too so telemetry cannot advertise an
			// observation the rebuilt Truth no longer applies (issue #102).
			pendingWireEst = null;
			pendingCalibrationThroughOrder = null;
			lastRealTokens = null;
			lastEstWireTokens = null;
			rebuilds++;
			sendSnapshot();
			// The Truth object was replaced — an in-process conductor rebuilds its tracked desired
			// state from resync; a remote replica gets the forced resnapshot broadcast above.
			liveHost.dispatchResync();
		}
	}

	/**
	 * Two messages share identity iff they emit the same durable block ids (cheap; no token work) AND
	 * the same content fingerprint (E1: catches a same-id in-place rewrite — see `contentFingerprint`).
	 * The two fingerprints are passed in, not recomputed: `fpA` is the cached `lastFps[i]` for the
	 * prev side, `fpB` the incoming hash the caller computed once this hook — so the prev side is never
	 * re-hashed on the hot path. The int compare goes FIRST as the cheapest short-circuit for the
	 * common content-changed case; the id walk still runs to catch an anchor-only change (same text,
	 * new responseId/timestamp) that leaves the fingerprint untouched.
	 */
	function sameMessageIdentity(a: PiMessage, b: PiMessage, i: number, fpA: number, fpB: number): boolean {
		if (a.role !== b.role) return false;
		if (fpA !== fpB) return false;
		const ia = messageInfo(a, i).ids;
		const ib = messageInfo(b, i).ids;
		if (ia.length !== ib.length) return false;
		for (let k = 0; k < ia.length; k++) if (ia[k] !== ib[k]) return false;
		return true;
	}

	/** Linearize `messages.slice(from)` with globally-correct numbering and append it to the Truth. */
	function appendSuffix(messages: PiMessage[], from: number): void {
		if (!truth) return;
		const lastB = truth.blocks[truth.blocks.length - 1];
		// The next order is the LAST BLOCK'S ORDER + 1, not the block COUNT. Those agreed while every
		// block came from `linearize` (orders contiguous from 0, one per array slot), but the block log
		// can now also hold the BOLTED `system` block at index 0 with order -1 (issue #93's redesign) —
		// it is a member of the log but not of the conversation numbering. Counting it would skip an
		// order value on every append; deriving from the last block's own order is correct either way,
		// and still yields 0 for an empty log and 0 for a log holding only the system block.
		const orderStart = lastB ? lastB.order + 1 : 0;
		const turnStart = lastB ? lastB.turn : 0;
		const fresh = linearize(messages.slice(from), orderStart, turnStart).map(wireToBlock);
		truth.append(fresh); // idempotent by id; emits `appended` → forwarded to clients
	}

	/**
	 * Reconcile pi's messages against the Truth by a cheap durable-id walk: if `messages` is our
	 * last array plus a new suffix, linearize ONLY the suffix and append (O(Δ) text work); if it
	 * diverges structurally, REBUILD. Mutations broadcast automatically via the Truth subscription.
	 */
	function ingestMessages(messages: PiMessage[]): void {
		messages = applyAdoption(messages, adoption);
		if (!truth) {
			rebuildTruth(messages);
			return;
		}
		const prev = lastMessages;
		let diverged = messages.length < prev.length;
		// Incoming content fingerprints, hashed once (prev side comes from the `lastFps` cache). Only the
		// prefix is needed to decide divergence; the suffix is filled below so an append can hand the
		// whole array to `setLastMessages` without a second hashing pass. Left null when we already know
		// we diverge (shorter array) — the rebuild path re-hashes from scratch anyway.
		const incomingFps = diverged ? null : new Array<number>(messages.length);
		if (!diverged) {
			for (let i = 0; i < prev.length; i++) {
				const fp = contentFingerprint(messages[i]);
				incomingFps![i] = fp;
				if (!sameMessageIdentity(prev[i], messages[i], i, lastFps[i], fp)) {
					diverged = true;
					break;
				}
			}
		}
		if (diverged) {
			rebuildTruth(messages);
			return;
		}
		for (let i = prev.length; i < messages.length; i++) incomingFps![i] = contentFingerprint(messages[i]);
		if (messages.length > prev.length) appendSuffix(messages, prev.length);
		setLastMessages(messages, incomingFps!);
	}

	/**
	 * Real provider usage fields (issue #11 stage 1) — NOT part of `core/wire.ts`'s `PiMessage` (a
	 * lowest-common-denominator projection used across both the extension and `core/`), so read them
	 * off the raw pi message object instead of the narrowed type.
	 *
	 * Deliberately no `totalTokens` field (F6, review round): the pairing this project chose is
	 * `input + cacheRead + cacheWrite`, never `usage.totalTokens` (see `maybeObserveCalibration`'s
	 * doc for why `output` is excluded). Accepted gap: a provider that reports ONLY `totalTokens` and
	 * leaves `input`/`cacheRead`/`cacheWrite` all undefined never calibrates — `real` computes to 0
	 * and the `real <= 0` guard below refuses the observation — rather than silently falling back to
	 * a quantity (`totalTokens`, which INCLUDES output) this pairing exists specifically to exclude.
	 */
	interface RealUsage {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
	}

	/**
	 * Issue #11 stage 1 (ADR 0025): pair the wire estimate the most recent `context` hook recorded
	 * (`pendingWireEst`) against THIS message's REAL provider usage (assistant messages only), and
	 * raw-snap `truth.calibration = real / est` through that wire's captured block frontier — no
	 * clamp, no smoothing (owner-approved v1 policy:
	 * the dial always reflects the latest observation, never a running average). `pendingWireEst` is
	 * consumed (cleared) unconditionally on every call — including a non-assistant message, an
	 * aborted/errored reply, or one with no usable `usage` — so a departing wire that never yields a
	 * usable pairing can't accidentally pair with a LATER, unrelated response.
	 *
	 * PAIRING CHOICE: `usage.input + usage.cacheRead + usage.cacheWrite` is exactly what the provider
	 * billed as INPUT for the request that carried the departing wire `pendingWireEst` estimated.
	 * `usage.output` is that SAME call's own reply and was never part of what was sent, so it is
	 * deliberately EXCLUDED here — unlike pi's own `calculateContextTokens` (input+output+cacheRead+
	 * cacheWrite, `@earendil-works/pi-coding-agent`'s compaction module), which sums output back IN
	 * because it estimates the NEXT call's forward-looking context size, a different quantity than
	 * "what did THIS request actually cost." This is the chosen "rigorous" pairing over the
	 * `ctx.getContextUsage()`-based v1 fallback the design allows: it is never null (no post-
	 * compaction gap) and isolates exactly the one request `pendingWireEst` describes, rather than
	 * blending in `ctx.getContextUsage()`'s own trailing-message estimate.
	 *
	 * SMEARING CAVEAT: `est` is Truth's own block-token accounting, which — by design — excludes
	 * tool-call schemas (they belong to no block). `real` includes them. One multiplier therefore
	 * distributes that fixed overhead PROPORTIONALLY across every block rather than carrying it as its
	 * own line item — `real = base + k·est` would be the honest affine model; we ship the pure
	 * multiplier knowingly (stage 1 scope; see ADR 0025 for the stage-2 plan). UPDATED (issue #93):
	 * `est` (`truth.liveTokens()`/`fullTokens()`) now ALSO includes the system prompt's own raw
	 * estimate, so as of the un-smearing fix, the system prompt is no longer part of this caveat —
	 * only tool-call-schema overhead remains smeared into `k`. See ADR 0025's issue-#93 addendum.
	 */
	function maybeObserveCalibration(msg: unknown): void {
		if (!truth) return;
		const est = pendingWireEst;
		const throughOrder = pendingCalibrationThroughOrder;
		pendingWireEst = null;
		pendingCalibrationThroughOrder = null;
		if (est === null || est <= 0 || throughOrder === null) return;
		const m = msg as { role?: string; stopReason?: string; usage?: RealUsage } | null | undefined;
		if (!m || m.role !== "assistant" || !m.usage) return;
		if (m.stopReason === "aborted" || m.stopReason === "error") return;
		const u = m.usage;
		const input = typeof u.input === "number" ? u.input : 0;
		const cacheRead = typeof u.cacheRead === "number" ? u.cacheRead : 0;
		const cacheWrite = typeof u.cacheWrite === "number" ? u.cacheWrite : 0;
		const real = input + cacheRead + cacheWrite;
		if (real <= 0) return;
		lastRealTokens = real;
		lastEstWireTokens = est;
		truth.setCalibration(real / est, throughOrder);
	}

	/**
	 * Append ONE just-finished message (message_end) to the Truth immediately — this is what kills
	 * the one-turn lag. Deduped on the message's durable ids so a re-fire or an already-appended
	 * message is skipped (and `lastMessages` is extended so the next context prefix still matches).
	 *
	 * `allowCalibration` (issue #11 F3, ADR 0025) defaults true for the normal `message_end` path,
	 * where it is always correct: `message_end` fires once per message, immediately after that
	 * message's own generating `context` hook and strictly before the NEXT one, so `pendingWireEst`
	 * always describes the wire that produced THIS message. The `agent_end` backstop below passes
	 * `false` for every message except the run's FINAL assistant reply — see that handler's comment
	 * for why an EARLIER newly-appended message must never be allowed to consume `pendingWireEst`.
	 */
	function ingestFinishedMessage(msg: PiMessage, allowCalibration = true): void {
		if (!truth) return;
		const ids = messageInfo(msg, 0).ids;
		if (!ids.length) return;
		if (ids.every((id) => truth!.get(id))) return; // already represented → nothing to do
		// Calibration pairing runs only for a message actually being NEWLY appended (review round,
		// issue #11): the `agent_end` backstop replays the whole run in order, and an already-appended
		// earlier assistant message must be deduped out ABOVE before it can consume `pendingWireEst` —
		// otherwise it would mispair its own (older, smaller) usage against the estimate of the LATER
		// departing wire the backstop is actually recovering, snapping k visibly low for one turn.
		if (allowCalibration) maybeObserveCalibration(msg);
		appendSuffix([...lastMessages, msg], lastMessages.length);
		setLastMessages([...lastMessages, msg], [...lastFps, contentFingerprint(msg)]);
	}

	/** Apply a client command to the authoritative Truth; returns the per-op results + resulting rev. */
	function applyCommand(cmd: WireCommand): { results: OpResult[]; rev: number } {
		if (!truth) return { results: [], rev: 0 };
		switch (cmd.kind) {
			case "ops": {
				// Guard host-only ops (`freeze`) at the GUI wire entry: an authenticated client must not
				// be able to seize a conductor's strategy folds through the ungated kill switch. A smuggled
				// freeze is stripped and reported back as a `locked` clamp in the commandResult.
				const t = truth;
				if (cmd.baseRev !== undefined && cmd.baseRev !== t.rev) {
					return { results: cmd.ops.map((op) => ({ op, applied: false, clamped: "stale" as const })), rev: t.rev };
				}
				const r = applyGuardingHostOnly(Array.isArray(cmd.ops) ? cmd.ops : [], (allowed) => t.apply(allowed, "you"));
				return { results: r.results, rev: r.rev };
			}
			case "setBudget":
				truth.setBudget(cmd.value);
				if (Number.isFinite(cmd.value)) recordDial("budget", truth.budget);
				return { results: [], rev: truth.rev };
			case "setProtect":
				truth.setProtect(cmd.value);
				if (Number.isFinite(cmd.value)) recordDial("protect", truth.protectTokens);
				return { results: [], rev: truth.rev };
			case "setFolding":
				setFolding(!!cmd.value);
				return { results: [], rev: truth.rev };
			case "selectConductor":
				// GUI-only (a conductor socket never reaches applyCommand — its messages route to
				// handleConductorMessage). Drives the host's attach/detach; state arrives via events +
				// the conductorState broadcast, so nothing to return here beyond the current rev.
				selectConductor(cmd.id);
				return { results: [], rev: truth.rev };
			default:
				return { results: [], rev: truth.rev };
		}
	}
	// ── lifecycle ──────────────────────────────────────────────────────────────
	const taskStores = new Map<string, { session: string; store: TaskStore }>();
	/** Derive the adoption for this branch from its messages and the project's list files. */
	function deriveFor(ctx: ExtensionContext): Adoption {
		const lists = new Map(taskStoreFor(ctx).scan().lists.map((l) => [l.slug, l.tasks] as const));
		return deriveAdoption(readSessionMessages(ctx), lists);
	}

	/** Persist and apply an adoption, then rebuild Truth so the next epoch sees the closed spans. */
	function adopt(ctx: ExtensionContext, next: Adoption): void {
		pi.appendEntry(ADOPTED_ENTRY, next);
		adoption = next;
		rebuildTruth(readSessionMessages(ctx));
	}

	function adoptionSummary(a: Adoption): string {
		return `${a.stats.nested} task event${a.stats.nested === 1 ? "" : "s"} from nested calls, ${a.stats.reconciled} span${a.stats.reconciled === 1 ? "" : "s"} closed from the list file${a.stats.lists.length ? ` (${a.stats.lists.join(", ")})` : ""}`;
	}

	/** Adopt a legacy session on resume according to `tasks.adopt`. Never throws. */
	function adoptOnStart(ctx: ExtensionContext, sessionAtStart: string): void {
		try {
			if (settings.tasks.adopt === "off" || !needsAdoption(readSessionMessages(ctx), adoption)) return;
			const next = deriveFor(ctx);
			if (!Object.keys(next.events).length) return;
			if (settings.tasks.adopt === "auto") {
				adopt(ctx, next);
				ctx.ui.notify(`Accordion adopted this session for Taskfold: ${adoptionSummary(next)}.`, "info");
				return;
			}
			if (!ctx.hasUI) return;
			void ctx.ui.confirm("Adopt this session for Taskfold?", `It was recorded before task events existed. Adoption adds ${adoptionSummary(next)} so finished tasks can fold. Messages are not changed.`).then((yes) => {
				if (yes && sessionId === sessionAtStart) adopt(ctx, next);
			}, () => undefined);
		} catch (err) {
			ctx.ui.notify(`Accordion could not adopt this session; it continues on the legacy scan: ${err instanceof Error ? err.message : String(err)}`, "warning");
		}
	}

	function taskStoreFor(ctx: ExtensionContext): TaskStore {
		const session = ctx.sessionManager.getSessionId();
		const project = path.resolve(ctx.cwd);
		const key = JSON.stringify([project, session]);
		const existing = taskStores.get(key);
		if (existing) return existing.store;
		const store = new TaskStore(project, () => session, () => pi.getSessionName());
		taskStores.set(key, { session, store });
		return store;
	}

	/** Whether the attached conductor provides the `tasks` tool. */
	function tasksToolActive(): boolean {
		return (entryById(liveHost.activeMeta()?.id ?? null)?.tools ?? []).includes("tasks");
	}

	let taskSession: TaskSession | null = null;
	let taskCoach = new TaskCoach();

	let taskListSnapshot: { project: string; session: string; lists: TaskList[]; invalid: string[] } | null = null;
	function scanTaskLists(): { lists: TaskList[]; invalid: string[] } {
		if (!latestCtx) { taskListSnapshot = null; return { lists: [], invalid: [] }; }
		taskListSnapshot = null;
		const scan = taskStoreFor(latestCtx).scan();
		taskListSnapshot = { project: path.resolve(latestCtx.cwd), session: latestCtx.sessionManager.getSessionId(), ...scan };
		return scan;
	}
	const taskWidget = new TaskWidgetController({
		lists: () => taskListSnapshot?.lists ?? [],
		scan: scanTaskLists,
		session: () => (typeof latestCtx?.sessionManager?.getSessionId === "function" ? latestCtx.sessionManager.getSessionId() : null),
		truth: () => truth,
		enabled: tasksToolActive,
		settings: () => settings.taskWidget,
		saveExpanded: (expanded) => {
			if (settings.taskWidget.expanded !== expanded) settings = saveSettings(HOME, { ...settings, taskWidget: { ...settings.taskWidget, expanded } });
		},
	});
	nativeListeners.add(() => taskWidget.sync());

	function releaseTaskClaims(): void {
		for (const { session, store } of taskStores.values()) {
			for (const list of store.lists()) {
				if (list.claim?.session !== session) continue;
				try {
					store.release(list.slug);
				} catch (err) {
					try {
						latestCtx?.ui.notify(`Could not release task list "${list.slug}": ${err instanceof Error ? err.message : String(err)}`, "warning");
					} catch { /* UI may be unavailable during shutdown. */ }
				}
			}
		}
		taskStores.clear();
	}

	pi.on("session_start", (event, ctx: ExtensionContext) => {
		releaseTaskClaims();
		nestedTaskEvents.clear();
		// Tear down the OLD session's Truth + event forwarder before building the new one; a
		// session swap invalidates the whole context state (a fresh Truth is authoritative). Detach
		// any attached conductor first (kills a spawned runner, clears its locks off the old Truth,
		// aborts in-flight completions) — a conductor is per-session and never carries across a swap.
		liveHost.shutdown();
		conductorWs = null;
		if (unsubTruth) {
			unsubTruth();
			unsubTruth = null;
		}
		truth = null;
		// issue #11 stage 1: a pending/observed calibration pairing belongs to the OLD session's Truth
		// (which just went away) — carrying it over would either mispair the new session's first
		// assistant reply against a stale estimate, or report a stale realTokens/estWireTokens in
		// telemetry for a session that has not yet observed anything of its own.
		pendingWireEst = null;
		pendingCalibrationThroughOrder = null;
		lastRealTokens = null;
		lastEstWireTokens = null;
		// Issue #93 review fix: prompt capture is session-scoped. `refreshFromCtx` is deliberately
		// best-effort and one optional API throwing can abort the rest of that refresh; without an
		// eager reset here, `buildTruth` could apply the previous session's cached prompt to the new
		// Truth, leaking its text and corrupting token totals until a later successful hook refresh.
		systemPromptText = null;
		systemPromptTokens = 0;
		latestModelObj = null;
		model = "";
		contextWindow = null;
		tokens = null;
		setLastMessages([]); // clears lastMessages + lastFps together (invariant: never one without the other)
		// E2 (external review round): folding is OPT-IN and OFF by default PER SESSION — reset the
		// arm on every `session_start`, regardless of `_event.reason` ("startup"/"reload"/"new"/
		// "resume"/"fork"). Everything else this handler touches (Truth, `lastMessages`, `meta`, the
		// conductor, and — a few lines below — `sessionId` itself) is ALREADY unconditionally reset
		// here for every reason, including a mere "reload": pi's own types note `previousSessionFile`
		// is present only for "new"/"resume"/"fork", implying "reload" re-enters the SAME session, yet
		// this handler has never special-cased it — it still tears down and rebuilds the authoritative
		// Truth from scratch and mints a brand-new `sessionId`. Leaving `foldingEnabled` as the one
		// piece of state that survives a reload would be an inconsistent, easy-to-miss exception to
		// that existing behavior, and would violate the per-session opt-in invariant on the case this
		// finding named explicitly. `setFolding` only broadcasts when the value actually changes, so an
		// already-attached client whose GUI toggle shows "on" gets an explicit `folding:false` to
		// resync it — connected clients are NOT dropped across a session_start, so without this a
		// client's toggle could silently drift from the true (now-reset) internal state.
		settings = loadSettings(HOME);
		setFolding(false);
		latestCtx = ctx;
		if (typeof ctx.sessionManager?.getSessionId === "function") taskStoreFor(ctx);
		activeConductorTools = ""; // a new session starts with its own active tool set
		sessionId = `s-${process.pid}-${Date.now()}`;
		startedAt = Date.now();
		try {
			meta = { title: "pi session", cwd: process?.cwd?.() ?? "", model: "", contextWindow: null, format: "pi" };
		} catch {
			/* keep defaults */
		}
		// This session's own budget/tail, read before anything resolves them for the new Truth.
		dialModel = null;
		try {
			dialRecords = dialsRecordsOf(typeof ctx.sessionManager?.getBranch === "function" ? ctx.sessionManager.getBranch() : []);
		} catch {
			dialRecords = [];
		}
		// Taskfold's verdicts from earlier runs of this session, so a resume neither loses nor re-bills them.
		const sessionAtStart = sessionId;
		try {
			const entries = typeof ctx.sessionManager?.getBranch === "function" ? ctx.sessionManager.getBranch() : [];
			adoption = adoptionOf(entries);
			factLedger.reset(ledgerOf(entries));
			ledgerTried.clear();
			ledgerWarned = false;
			ledgerIdleRev = -1;
			taskfoldVerdicts.reset(verdictsOf(entries), (id, v) => {
				if (sessionId === sessionAtStart) pi.appendEntry(VERDICT_ENTRY, { id, ...v });
			}, unfoldStatesOf(entries), (key, state) => {
				if (sessionId === sessionAtStart) pi.appendEntry(UNFOLD_ENTRY, { key, ...state });
			});
		} catch {
			taskfoldVerdicts.reset(new Map(), null);
		}
		refreshFromCtx(ctx); // model / context window may be known already
		// Build the authoritative Truth from the session's current history. For a fresh session
		// this is []; for a RESUMED/loaded session it is the full prior conversation, born SENT
		// (the Truth constructor marks all loaded blocks sent). A client that attaches before any
		// turn still gets a correct snapshot.
		buildTruth(readSessionMessages(ctx));
		adoptOnStart(ctx, sessionAtStart);
		startServer();
		if (settings.autoArm) {
			setFolding(true);
			if (settings.defaultConductor && settings.defaultConductor !== "none") {
				if (port === 0 && entryById(settings.defaultConductor)?.kind === "spawn") conductorAwaitingPort = settings.defaultConductor;
				else selectConductor(settings.defaultConductor);
			}
		}
		lastFooter = "";
		refreshConductorPresentation();
		taskWidget.attach(ctx.mode === "tui" && ctx.hasUI ? ctx.ui : null);
		taskSession?.dispose();
		taskSession = null;
		taskfoldRouting.current = null;
		taskCoach = new TaskCoach();
		if (typeof ctx.sessionManager?.getSessionId === "function") {
			taskSession = new TaskSession({
				store: () => taskStoreFor(ctx),
				session: () => ctx.sessionManager.getSessionId(),
				enabled: tasksToolActive,
				appendEntry: (type, data) => pi.appendEntry(type, data),
				changed: () => { taskWidget.reload(); notifyNative(); },
			});
			taskSession.start(ctx.sessionManager.getBranch(), (event as { reason?: StartReason }).reason ?? "startup", ctx.mode === "tui" && ctx.hasUI ? ctx.ui : null);
			// New user messages are extracted into the attached list while the Taskfold conductor runs (SPEC-0002 §4.6).
			const routedSession = ctx.sessionManager.getSessionId();
			taskfoldRouting.current = createRouting({
				attached: () => {
					if (!tasksToolActive() || latestCtx?.sessionManager.getSessionId() !== routedSession) return null;
					const store = taskStoreFor(ctx);
					const list = attachedList(store.claimedBySession());
					return list ? { store, list } : null;
				},
				limits: () => ({ ...PIN_LIMITS, ...settings.tasks.pins, maxLines: settings.tasks.attachments.maxLines, roots: settings.tasks.attachments.roots }),
				applied: (slug, outcome) => {
					taskSession?.noteRouted(slug, outcome.applied);
					taskWidget.reload();
					notifyNative();
					void flushTaskNotices(latestCtx ?? ctx);
				},
			});
		}
	});

	// A tasks call made inside another tool (codemode) has no block of its own: its span event rides
	// on the outer call's persisted result instead (SPEC-0002 §5.3).
	const nestedTaskEvents = new TaskEventQueue();

	// Coaching on the task protocol rides on tool results: work outside any task gets a reminder.
	pi.on("tool_result", (event, ctx: ExtensionContext) => {
		const details = event.parentToolCallId ? null : withTaskEvents(event.details, nestedTaskEvents.take(event.toolCallId));
		const withDetails = details ? { details } : undefined;
		if (event.toolName === "tasks" || !tasksToolActive() || latestCtx?.sessionManager.getSessionId() !== ctx.sessionManager.getSessionId()) return withDetails;
		let list: TaskList | null = null;
		try {
			list = attachedList(taskStoreFor(ctx).claimedBySession());
		} catch {
			/* an unreadable list directory just means no coaching */
		}
		taskCoach.setList(list);
		void flushTaskNotices(ctx);
		const note = taskCoach.toolResult(!!event.parentToolCallId);
		return note ? { ...withDetails, content: [...event.content, { type: "text" as const, text: note }] } : withDetails;
	});

	// Prose the agent writes inside a task is work too: an analysis may need no tool call.
	function countAssistantText(msg: PiMessage | undefined, ctx: ExtensionContext): void {
		if (msg?.role !== "assistant" || !Array.isArray(msg.content) || !tasksToolActive() || latestCtx?.sessionManager.getSessionId() !== ctx.sessionManager.getSessionId()) return;
		const chars = msg.content.reduce((n, p) => n + (p.type === "text" && typeof p.text === "string" ? p.text.trim().length : 0), 0);
		if (!chars) return;
		try {
			taskCoach.setList(attachedList(taskStoreFor(ctx).claimedBySession()));
		} catch {
			return;
		}
		taskCoach.assistantText(chars);
	}

	// Each stop is judged against the attached list and kept in the session, so a premature stop
	// (open or startable work left) can be told apart from waiting on the user or a third party.
	function recordIdleVerdict(ctx: ExtensionContext): void {
		if (!tasksToolActive()) return;
		try {
			const list = attachedList(taskStoreFor(ctx).claimedBySession());
			if (list) pi.appendEntry(IDLE_ENTRY, { list: list.slug, at: new Date().toISOString(), ...idleVerdict(list) });
		} catch {
			/* no list, no verdict */
		}
	}

	// Changes made while a turn runs (a user edit, an extracted instruction) reach the agent between
	// tool calls as one appended steer message; while idle they wait for the next prompt (SPEC-0002 §4.4).
	async function flushTaskNotices(ctx: ExtensionContext): Promise<void> {
		if (!taskSession || !tasksToolActive() || ctx.isIdle()) return;
		const content = await taskSession.takeNotice(false);
		if (!content) return;
		try {
			await pi.sendMessage({ customType: NOTICE_MESSAGE, content, display: true }, { deliverAs: "steer" });
		} catch {
			taskSession.requeue(content);
		}
	}

	// The agent hears about task list changes it did not make (a resume, the user attaching lists)
	// with its next prompt. An open resume dialog is answered first.
	pi.on("before_agent_start", async (_event, ctx: ExtensionContext) => {
		recallAccount.reset();
		const content = await taskSession?.takeNotice();
		return content ? { message: { customType: NOTICE_MESSAGE, content, display: true } } : undefined;
	});

	pi.registerMessageRenderer(NOTICE_MESSAGE, (message, options, theme) => noticeRow(theme, typeof message.content === "string" ? message.content : "", options.expanded));

	// ── ghost layer: forward stream lifecycle frames (Phase 4, ADR 0003) ─────────
	// `message_update` fires for every token delta — we deliberately drop those.
	// We forward ONLY the *_start / *_end / error lifecycle transitions, which are
	// sufficient to drive a CSS pulse animation. The token-delta firehose is consumed
	// and discarded at the source; zero per-token frames cross the wire.
	//
	// View-only: this handler never touches a model call, never reads lastMessages,
	// and never registers in `pending`. It is purely presentational.
	//
	// Kind mapping: text_start/end → "text", thinking_start/end → "thinking",
	//               toolcall_start/end → "tool_call". error → abort sweep.
	pi.on("message_update", (event: any) => {
		if (!attached()) return;

		const ev = event?.assistantMessageEvent;
		if (!ev || typeof ev.type !== "string") return;

		const t = ev.type as string;
		const ci: number = typeof ev.contentIndex === "number" ? ev.contentIndex : 0;

		// Map pi's event type to ghost kind + phase.
		// start events → spawn / refresh a ghost.
		if (t === "text_start") {
			sendStream({ type: "stream", phase: "start", kind: "text", contentIndex: ci });
		} else if (t === "thinking_start") {
			sendStream({ type: "stream", phase: "start", kind: "thinking", contentIndex: ci });
		} else if (t === "toolcall_start") {
			sendStream({ type: "stream", phase: "start", kind: "tool_call", contentIndex: ci });
		}
		// end events → resolve a ghost.
		else if (t === "text_end") {
			sendStream({ type: "stream", phase: "end", kind: "text", contentIndex: ci });
		} else if (t === "thinking_end") {
			sendStream({ type: "stream", phase: "end", kind: "thinking", contentIndex: ci });
		} else if (t === "toolcall_end") {
			sendStream({ type: "stream", phase: "end", kind: "tool_call", contentIndex: ci });
		}
		// error / aborted → abort sweep: clear all ghosts (contentIndex -1 = "all").
		// On an abnormal stream end NO committed block is coming, so the ghost must
		// vanish immediately (ADR 0003 invariant #3), not wait for the message_end sweep.
		else if (t === "error" || t === "aborted") {
			sendStream({ type: "stream", phase: "abort", kind: "text", contentIndex: -1 });
		}
		// `done` (clean stream end) is intentionally NOT swept here: the message_end hook
		// fires immediately after with the committed blocks and runs its own sweep, so
		// resolving here would only risk a sub-tick gap. All `*_delta` events (the token
		// firehose) are silently dropped — we never forward token deltas over the wire.
	});

	// ── the loop: LOCAL reconcile + optional serialize + telemetry ──────────────
	// Phase B: pi's `context` hook is a LOCAL operation against the in-process Truth. No client
	// round trip, no await, no disk I/O. Returning `undefined` passes pi's messages through
	// unchanged (the default when folding is disabled); an explicit `{ messages }` replaces them.
	pi.on("context", async (event, ctx: ExtensionContext) => {
		const t0 = Date.now();
		// Invariant: this hook must NEVER break a model call. Everything that can throw (a bad
		// parse, an unexpected message shape, a Truth bug) is guarded — on any throw we fall back to
		// passthrough (`ret` stays undefined) so pi proceeds with its own original messages,
		// unmodified. Timing (below) still covers the whole guarded body, error or not.
		let ret: { messages: AgentMessage[] } | undefined;
		try {
			latestCtx = ctx;
			// Refresh model/usage in memory only — NO disk I/O on the model-call critical path.
			refreshFromCtx(ctx);
			const messages = event.messages as unknown as PiMessage[];
			// (a) Reconcile pi's messages against the Truth: append a new suffix, or rebuild on
			//     structural divergence (both broadcast to clients via the Truth subscription).
			ingestMessages(messages);
			// No tool result departs larger than the guard allows; clipped before first send, so no cache cost.
			if (truth && foldingEnabled) {
				const clipped = guardResults(truth, settings.guard.resultTokens, guardLoadedSession);
				guardLoadedSession = false;
				if (clipped.length) truth.apply(clipped, "auto");
			}
			// Near the budget, recall results that were already used go first: they are copies.
			if (truth && truth.budget > 0 && truth.stats().liveTokens >= settings.taskfold.high * truth.budget) releaseRecall(false);
			if (truth) {
				// (b) PHASE C: the wire-departing hold. ONLY paid when folding is armed AND the attached
				//     conductor declares a hold window — the sync fast path (no conductor / no hold /
				//     folding off) never awaits anything, keeping a no-conductor session byte-identical
				//     to pre-Phase-C. This is where a conductor's last-moment (birth-)fold lands before
				//     the wire is serialized. No disk I/O; the spawn/kill bridge is never on this path.
				const holdMeta = liveHost.activeMeta();
				if (foldingEnabled && holdMeta && holdMeta.holdWireUpToMs > 0) {
					await liveHost.fireWireDepartingAndAwaitHold();
				}
				// (c) If folding is armed, serialize the wire from the Truth and replace; else passthrough.
				if (foldingEnabled) {
					ret = { messages: truth.serializeWire(messages) as unknown as AgentMessage[] };
				}
				// (c.1) issue #11 stage 1: record what THIS departing wire is estimated to cost, so the
				// NEXT assistant reply's real usage can be paired against it (`maybeObserveCalibration`).
				// `liveTokens()` is Truth's own accounting of what `serializeWire` just produced when
				// folding is armed (never diverges from the wire, by the same invariant every other
				// group/fold accounting relies on); `fullTokens()` is the raw unfolded size when folding
				// is off (passthrough — `ret` stays undefined, `event.messages` departs verbatim).
				// Capture the current last order alongside the estimate. `sentThroughOrder` cannot stand in
				// for this: sent-ness advances in `finally` before the receipt, while this frontier must stay
				// pinned to the exact wire being measured (issue #102).
				// Recorded regardless of whether any client is connected, same as every other Truth
				// bookkeeping on this hook — no disk I/O, CPU-only.
				pendingWireEst = foldingEnabled ? truth.liveTokens() : truth.fullTokens();
				pendingCalibrationThroughOrder = truth.blocks[truth.blocks.length - 1]?.order ?? -1;
			}
		} catch (err) {
			hookErrors++;
			console.error("[accordion] context hook failed; passing messages through unmodified:", err);
			ret = undefined;
		} finally {
			// (d) markSent through the last block — GUARANTEED on both the success AND the error path
			// (E3, external review round). Invariant: whatever this hook actually let through to the
			// model counts as sent. On the happy path `ret` may hold the serialized replacement, but
			// either way (folding on or off) pi ends up delivering every block up to the Truth's current
			// tail — the range markSent covers is correct regardless of which branch built `ret`. On the
			// error path `ret` stays `undefined`, so pi sends `event.messages` RAW AND UNMODIFIED — every
			// block in the Truth mirroring that array still departed to the model whole. Previously
			// markSent lived only inside the try, AFTER the risky work (ingestMessages / the wire-
			// departing hold / serializeWire) — a throw anywhere in there returned raw passthrough
			// (those messages DO reach the model) but skipped markSent, so already-departed blocks were
			// later misclassified as never-sent and wrongly treated as still birth-foldable (`canFold`'s
			// `!sent(b)` exemption). Moving it to `finally` makes it run on every exit path. Guarded in
			// its own try/catch so a throw HERE (Truth in a genuinely broken state) still can't escape
			// and break the model call — the hook's return value is already decided either way.
			try {
				if (truth) {
					const last = truth.blocks[truth.blocks.length - 1];
					if (last) truth.markSent(last.order);
				}
			} catch (err) {
				console.error("[accordion] context hook markSent (finally) failed:", err);
			}
		}
		// (e) Measure the whole hook (guarded body included, hold window and all) and stream it as
		// telemetry — lastHoldMs/holdTimeouts (from the live host) ride alongside the hook duration.
		recordHook(Date.now() - t0);
		// Off the hook's own time: the scan for tasks without a ledger and the model calls after it.
		if (settings.recall.ledger.enabled) setTimeout(() => void noteFacts(), 0);
		broadcastTelemetry();
		return ret;
	});

	// ── model swap: keep the context window in lockstep ─────────────────────────
	// Request-local only: armed folding clears historical usage anchors so Pi estimates the actual
	// outgoing prefix. Nothing is appended to any message; every request extends the previous one.
	pi.on("context_with_system", (event) => {
		if (!foldingEnabled) return;
		const messages = event.messages.map((message) => {
			if (message.role !== "assistant" || !message.usage) return message;
			return { ...message, usage: { ...message.usage, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } };
		});
		return { messages };
	});

	// `/model` fires `model_select` immediately, carrying the NEW model. Adopt its context window
	// into the Truth right away (emits a `config` event to every client) so the budget tracks the
	// swap without waiting for the next model call.
	pi.on("thinking_level_select", () => notifyNative());

	pi.on("model_select", (event) => {
		applyModel(event?.model as { id?: string; contextWindow?: number } | undefined);
		if (truth && contextWindow != null) {
			truth.setContextWindow(contextWindow);
			// A swap to a smaller-window model must shrink an oversized budget too, or the
			// aged-summary conductors' 90%-of-budget trigger only fires after the REAL window is
			// already exhausted (model-window budget clamp fix). Never raises budget.
			clampBudgetToWindow(truth, contextWindow);
		}
		applyDials();
	});

	// ── turn settled: the canonical re-plan trigger for a turn-based conductor ───
	// `turn_end` fires after each LLM turn. It is the host-lifecycle equivalent of
	// `TestHost.commitTurn` — an attached conductor (in-process) or the remote replica (over the
	// wire) treats it as the moment to re-run its pass. Purely a notification; folding still happens
	// only at `context`, and there is no conductor attached ⇒ this is a no-op.
	pi.on("turn_end", () => {
		if (!truth) return;
		const last = truth.blocks[truth.blocks.length - 1];
		liveHost.fireTurnCommitted(last ? last.turn : 0, truth.rev);
	});

	// ── committed streaming: append finished messages to the Truth immediately ──
	// `context` only fires BEFORE a model call (messages going IN); `agent_end` fires once at loop
	// end. `message_end` fires the moment each message is finalized — including assistant replies
	// mid-tool-loop — so appending here (idempotent by id) is what KILLS the one-turn lag: the
	// reply's blocks enter the Truth (and stream to every client) the instant they exist, not at
	// the next model call. View-only: folding still happens only at `context`.
	pi.on("message_end", (event, ctx: ExtensionContext) => {
		countAssistantText(event.message as unknown as PiMessage, ctx);
		// Sweep all active ghosts (invariant #2, ADR 0003) BEFORE the committed blocks stream, so a
		// client swaps its ghost placeholders for the real blocks in the same tick.
		sendStream({ type: "stream", phase: "abort", kind: "text", contentIndex: -1 });
		const msg = event.message as unknown as PiMessage;
		if (msg) ingestFinishedMessage(msg);
	});

	// ── loop-end backstop: append this run's finished messages ──────────────────
	// pi's `agent_end.messages` contains ONLY messages generated by this prompt, not the full
	// session history. Treating it as an authoritative snapshot makes `ingestMessages` see a
	// shorter array and rebuild Truth from just the latest run; the app then appears to lose all
	// prior context until the next `context` hook restores the full history. Replay these run-local
	// messages through the same idempotent delta path as `message_end` instead. Usually every id is
	// already present; this remains a backstop for any finalized message that hook missed.
	//
	// CALIBRATION PAIRING (issue #11 F3, ADR 0025): a multi-call run (a tool loop) fires the
	// `context` hook once per LLM call, each overwriting `pendingWireEst` with the estimate of ITS
	// OWN departing wire — by the time this backstop runs, `pendingWireEst` (if still set at all)
	// describes only the LAST of those calls. If `message_end` missed an EARLIER assistant message
	// in this run (the actual gap this backstop exists to cover), that message reaches
	// `ingestFinishedMessage` here as genuinely new, and — pre-fix — would consume whatever
	// `pendingWireEst` happened to be sitting there and pair its own (earlier, smaller) usage against
	// the estimate of a wire it never departed on, corrupting `calibration` for that observation and
	// starving the run's actual FINAL reply (the very next `ingestFinishedMessage` call) of the
	// pairing it should have gotten. Only the run's FINAL assistant message may pair: it is the one
	// message in this array `message_end` had a chance to pair correctly too, so replaying it here is
	// exactly like `message_end`'s own normal case (usually a no-op — this id is already in Truth —
	// and otherwise correct). Every earlier message replays with calibration suppressed, never
	// touching `pendingWireEst`, which stays reserved for the final message's own pairing attempt.
	pi.on("agent_end", (event, ctx: ExtensionContext) => {
		latestCtx = ctx;
		nestedTaskEvents.clear();
		taskSession?.record();
		recordIdleVerdict(ctx);
		sendStream({ type: "stream", phase: "abort", kind: "text", contentIndex: -1 });
		const messages = event.messages as unknown as PiMessage[];
		let lastAssistantIdx = -1;
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i]?.role === "assistant") {
				lastAssistantIdx = i;
				break;
			}
		}
		messages.forEach((msg, i) => ingestFinishedMessage(msg, i === lastAssistantIdx));
	});

	// ── suppress pi's native compaction ONLY while folding is actually armed ────
	// Owner-approved policy: suppression is gated on `foldingEnabled`, NOT on `attached()`. A
	// connected client with folding OFF (a read-only mirror, or a preview with an attached conductor
	// but folding disarmed) leaves pi's own overflow safety net fully intact — whoever is actually
	// rewriting the wire owns overflow, not whoever merely has a socket open. While folding IS armed,
	// suppression stays unconditional (no hard-overflow escape valve) — Accordion's own budget/fold
	// state is the only thing standing between the session and overflow at that point, so pi's native
	// compaction must not race it. When a native compaction DOES run because folding was off, the
	// paired `session_compact` handler below immediately reconciles the Truth against the compacted
	// history (the same `ingestMessages` → `rebuildTruth` structural-divergence path the hooks use —
	// including conductor resync via `liveHost.dispatchResync()`) and then notifies.
	pi.on("session_before_compact", (event, ctx: ExtensionContext) => {
		if (!foldingEnabled) return;
		if (settings.compactMode === "native") return;
		const reason = (event as { reason?: string } | undefined)?.reason;
		if (reason === "manual" && settings.compactMode === "accordion") {
			const res = compactNow();
			const note = `${res.message} — native compaction suppressed.`;
			try { ctx.ui.notify(note, "info"); } catch { /* ignore */ }
			broadcast({ type: "notice", text: res.message });
			return { cancel: true };
		}
		if (reason === "overflow") {
			const res = compactNow();
			if (res.afterTokens < res.beforeTokens || settings.compactMode === "suppress") {
				const note = `${res.message} — native compaction suppressed.`;
				try { ctx.ui.notify(note, "info"); } catch { /* ignore */ }
				broadcast({ type: "notice", text: res.message });
				return { cancel: true };
			}
			const fallbackNote = "Accordion saturated on context overflow — falling back to native compaction.";
			try { ctx.ui.notify(fallbackNote, "warning"); } catch { /* ignore */ }
			broadcast({ type: "notice", text: fallbackNote });
			return;
		}
		if (settings.compactMode === "accordion" && truth) {
			const last = truth.blocks[truth.blocks.length - 1];
			liveHost.fireTurnCommitted(last ? last.turn : 0, truth.rev);
		}
		try {
			ctx.ui.notify("Accordion folding armed — native compaction suppressed.", "info");
		} catch {
			/* ignore */
		}
		return { cancel: true };
	});

	// ── native compaction ran while folding was off: rebuild NOW + notify ──────
	// Fires AFTER pi has actually saved a compaction (the one above did not cancel it, since folding
	// was off). Reconcile the Truth HERE rather than waiting for the next `agent_end`/`message_end`/
	// `context` pass: pi's MANUAL `/compact` path saves the compaction, emits this event, and returns
	// with NO follow-up model call, so an attached map would otherwise show pre-compaction history
	// until the human's next prompt — while the toast below claims it was rebuilt. `readSessionMessages`
	// resolves the post-compaction history via pi's own `buildSessionContext()` (collapses the
	// compaction to exactly what the next model call will see); `ingestMessages` detects the
	// structural divergence and rebuilds (forced client resnapshot + conductor resync). For the
	// AUTOMATIC (threshold/overflow) trigger a retry's `context` hook follows immediately and would
	// reconcile anyway — this same-path ingest just lands moments earlier and the retry's ingest
	// becomes a cheap no-divergence walk. Best-effort like all discovery I/O: an EMPTY read means the
	// session state could not be resolved — keep the current Truth and let the normal reconciliation
	// catch up, rather than rebuilding an empty map (a real post-compaction branch is never empty:
	// it always contains at least the compaction summary entry). Not the `context` hook path, so the
	// no-disk-I/O-on-hook invariant is untouched.
	//
	// The human-facing note then goes out two ways: `ctx.ui.notify` for whoever is watching pi's own
	// CLI/log, and — v17 — a `notice` broadcast (`core/protocol.ts`) to every connected GUI client,
	// so a browser-served tab or a desktop window that isn't looking at pi's terminal still sees why
	// the map just changed shape. The map itself already visibly changed on the forced resnapshot;
	// the notice is the accompanying explanation of why.
	pi.on("session_compact", (_event, ctx: ExtensionContext) => {
		latestCtx = ctx;
		const msgs = readSessionMessages(ctx);
		if (msgs.length > 0) ingestMessages(msgs);
		// issue #11 stage 1: native compaction rewrites the session's block set out from under any
		// in-flight `context` hook's wire estimate — drop it rather than risk pairing the NEXT
		// assistant reply's real usage against a now-stale pre-compaction estimate.
		pendingWireEst = null;
		pendingCalibrationThroughOrder = null;
		if (!attached()) return;
		const text = "pi compacted the session natively — Accordion's map has been rebuilt to match.";
		try {
			ctx.ui.notify(text, "info");
		} catch {
			/* ignore */
		}
		broadcast({ type: "notice", text });
	});

	pi.on("session_shutdown", () => {
		taskfoldRouting.current = null;
		taskWidget.detach();
		taskSession?.dispose();
		taskSession = null;
		releaseTaskClaims();
		// Tear the attached conductor down FIRST (while the Truth still exists): SIGTERM→grace→SIGKILL
		// any spawned runner, abort in-flight completions, release any pending hold. The freeze kill
		// switch runs against the live Truth before we null it below.
		liveHost.shutdown();
		conductorWs = null;
		if (heartbeat) {
			clearInterval(heartbeat);
			heartbeat = null;
		}
		// v16 (ADR 0024): stop the controller timers and RELEASE the door (close its listener) so a
		// standing-by extension's retry claims it — this also models release-on-exit explicitly rather
		// than relying on the OS to free the fixed port. The global controller.json lease is left on
		// disk; the holder's heartbeat simply stops, so it goes stale and any surface may re-claim.
		stopControllerTimers();
		closeDoor();
		deleteEntry(); // stop advertising — the app drops our row immediately
		// Tear down the Truth + its event forwarder, and close every client.
		if (unsubTruth) {
			unsubTruth();
			unsubTruth = null;
		}
		truth = null;
		nativeSurfaceId = null;
		sessionId = "";
		for (const remote of nativeRemotes) remote.close();
		nativeRemotes.clear();
		notifyNative();
		for (const ws of clients.keys()) {
			try {
				ws.close();
			} catch {
				/* ignore */
			}
		}
		clients.clear();
		try {
			wss?.close();
		} catch {
			/* ignore */
		}
		// Close the shared HTTP server too — it owns the ephemeral port the WS rode on,
		// so leaving it open would keep serving files (and hold the port) after shutdown.
		try {
			httpServer?.close();
		} catch {
			/* ignore */
		}
		httpServer = null;
		wss = null;
		latestCtx = null;
	});

	async function handleAccordionWebCommand(ctx: ExtensionCommandContext): Promise<void> {
		writeFocusRequest();
		const wasAttached = attached();
		const launch = wasAttached ? null : await launchAccordionApp(pi);
		const action = launchResultLine(launch);
		const portStatus = port ? String(port) : bindError ? `failed (${bindError})` : "starting";
		const blockCount = truth ? truth.blocks.length : 0;
		const lines = [
			action.text,
			`Live link: ${clients.size} client(s) · host ${displayWebHost()} · port ${portStatus} · ${blockCount} blocks · folding ${foldingEnabled ? "on" : "off"}`,
		];
		const dp = resolvedDoorPort();
		const host = displayWebHost();
		const tok = activeCustomToken();
		const doorUp = dp !== null && (tok || doorSecret !== "") && (doorHeld || (await probeDoor()) === "accordion");
		if (doorUp) {
			lines.push(`Browser: http://${host}:${dp}/?token=${tok || doorSecret}`);
		} else if (port && (tok || webToken)) {
			lines.push(`Browser: http://${host}:${port}/?token=${tok || webToken}`);
		} else if (bindError) {
			lines.push(`Browser: unavailable — ${bindError}`);
		} else {
			lines.push("Browser: starting…");
		}
		ctx.ui.notify(lines.join("\n"), action.type);
	}

	/**
	 * Claim the controller lease for a new Pi TUI surface, asking first when another fresh surface
	 * holds it. Null when the session changed meanwhile; `error` set when the claim did not land.
	 */
	async function claimNativeControl(ctx: ExtensionCommandContext, openedSessionId: string, purpose: string): Promise<{ surfaceId: string; error: string | null } | null> {
		const surfaceId = `tui-${crypto.randomBytes(16).toString("hex")}`;
		refreshControllerNow();
		const current = controllerLease;
		const contested = current && current.surfaceId !== lastNativeSurfaceId && isFreshLease(current, Date.now());
		// The safe choice comes first and is what Esc means: open without taking the lease.
		const take = "Take control";
		const takeControl = !contested || (await ctx.ui.select(`${current.label} controls Accordion. ${purpose} makes that surface read-only.`, ["Open read-only", take])) === take;
		if (sessionId !== openedSessionId) return null;
		let error: string | null = null;
		if (takeControl) {
			await claimWithControllerLeaseLock(() => {
				const now = Date.now();
				writeControllerLease({ registryProtocol: REGISTRY_PROTOCOL, surfaceId, label: "Pi TUI", claimedAt: now, heartbeatAt: now });
			}, () => sessionId === openedSessionId);
			if (sessionId !== openedSessionId) return null;
			refreshControllerNow();
			if (controllerLease?.surfaceId === surfaceId) {
				nativeSurfaceId = surfaceId;
				lastNativeSurfaceId = surfaceId;
			} else {
				error = "Control unavailable: the Accordion registry is busy or inaccessible";
				ctx.ui.notify(error, "warning");
			}
		}
		return { surfaceId, error };
	}

	/** Whether `surfaceId` holds a fresh controller lease for the session opened as `openedSessionId`. */
	function holdsControl(surfaceId: string, openedSessionId: string): boolean {
		return sessionId === openedSessionId && !!controllerLease && controllerLease.surfaceId === surfaceId && isFreshLease(controllerLease, Date.now());
	}

	/** The task inspection screens' host for this session, steering through `surfaceId`'s lease. */
	function taskViewsHost(surfaceId: string, openedSessionId: string): TaskViewsHost {
		scanTaskLists();
		const openedProject = latestCtx ? path.resolve(latestCtx.cwd) : null;
		const openedPiSession = latestCtx?.sessionManager.getSessionId();
		const current = () => sessionId === openedSessionId && !!latestCtx && path.resolve(latestCtx.cwd) === openedProject && latestCtx.sessionManager.getSessionId() === openedPiSession;
		return {
			truth: () => (current() ? truth : null),
			folding: () => foldingEnabled,
			verdict: (id) => taskfoldVerdicts.get(id),
			threshold: () => taskfoldVerdicts.threshold,
			lists: () => current() && taskListSnapshot?.project === openedProject && taskListSnapshot.session === openedPiSession ? taskListSnapshot.lists : [],
			invalid: () => current() ? taskListSnapshot?.invalid ?? [] : [],
			rescan: () => void scanTaskLists(),
			canSteer: () => {
				refreshControllerNow();
				return current() && holdsControl(surfaceId, openedSessionId);
			},
			apply: async (ops) => {
				refreshControllerNow();
				if (!current() || !holdsControl(surfaceId, openedSessionId)) return "Read-only: another surface controls Accordion.";
				const res = applyCommand({ kind: "ops", ops });
				const refused = res.results.flatMap((r) => r.perId?.filter((e) => e.reason).map((e) => e.reason!) ?? (r.clamped ? [r.clamped] : []));
				return refused.length ? refusalMessage(refused) : res.results.every((r) => r.applied) ? "Applied." : "Nothing changed.";
			},
			subscribe: (listener) => {
				nativeListeners.add(listener);
				return () => nativeListeners.delete(listener);
			},
		};
	}

	/**
	 * `/accordion tasks dump-transcript` — write this session's outgoing projection to disk.
	 *
	 * The projection is what the next `context` hook sends the model: every block in order, with
	 * folded spans standing in as their records. `transcriptDump.ts` renders one document in five
	 * formats from a single snapshot, so several files written at once always agree. The tree is the
	 * default; a file's extension picks the format, and `--format`/`--formats` overrides both.
	 */
	async function dumpTranscript(args: string, ctx: ExtensionCommandContext): Promise<void> {
		const words = args.trim().split(/\s+/).filter(Boolean);
		let spec: string | null = null;
		let target: string | null = null;
		const usage = "Usage: /accordion tasks dump-transcript [--format <tree|yaml|xml|md|flat> | --formats <a,b,…|all>] [file]";
		for (let i = 0; i < words.length; i++) {
			const flag = /^--(formats?)(?:=(.+))?$/.exec(words[i]);
			if (flag) {
				const value = flag[2] ?? words[++i];
				if (!value || value.startsWith("--")) {
					ctx.ui.notify(`--${flag[1]} needs a value: ${DUMP_FORMATS.join(", ")} or all.`, "warning");
					return;
				}
				spec = value;
				continue;
			}
			if (words[i].startsWith("--")) {
				ctx.ui.notify(`Unknown option ${words[i]}. ${usage}`, "warning");
				return;
			}
			if (target !== null) {
				ctx.ui.notify(`Give at most one file name. ${usage}`, "warning");
				return;
			}
			target = words[i];
		}
		if (!truth) {
			ctx.ui.notify("No session context yet — nothing to dump.", "warning");
			return;
		}
		let formats: DumpFormat[];
		if (spec !== null) {
			const parsed = parseFormatSpec(spec);
			if ("error" in parsed) {
				ctx.ui.notify(parsed.error, "warning");
				return;
			}
			formats = parsed.formats;
		} else formats = [target ? (formatOfPath(target) ?? "tree") : "tree"];

		const cwd = path.resolve(ctx.cwd);
		const at = new Date();
		// One name per format: an explicit single format keeps the caller's path verbatim, several
		// formats share its stem, and with no path each gets the session-stamped default name.
		const files = formats.map((format) =>
			target === null
				? path.join(cwd, dumpFileName(sessionId, format, at))
				: path.resolve(cwd, formats.length > 1 ? withExtension(target, format) : target),
		);
		const source = transcriptSource(truth, () => undefined, null, { folding: foldingEnabled });
		const scan = taskStoreFor(ctx).scan();
		const relevant = new Set(transcriptSpans(source).map((span) => span.list));
		source.lists = scan.lists.filter((list) => relevant.has(list.slug) || list.claim?.session === ctx.sessionManager.getSessionId());
		source.listIssues = scan.invalid;
		const system = source.blocks.find((b) => b.kind === "system");
		const doc = dumpDocument({
			source,
			meta: { sessionId, model: meta.model || model || "unknown-model" },
			system: system ? { tokens: system.full } : null,
			totals: { full: source.blocks.reduce((n, b) => n + b.full, 0), live: source.blocks.reduce((n, b) => n + b.live, 0), budget: truth.budget },
			generatedAt: at,
		});
		const written: string[] = [];
		const failures: string[] = [];
		formats.forEach((format, i) => {
			const file = files[i];
			try {
				fs.mkdirSync(path.dirname(file), { recursive: true });
				const rendered = renderDump(doc, format);
				fs.writeFileSync(file, rendered.endsWith("\n") ? rendered : `${rendered}\n`);
				written.push(path.relative(cwd, file) || file);
			} catch (error) {
				failures.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
			}
		});
		if (failures.length) ctx.ui.notify(`Could not write ${failures.join("; ")}`, "error");
		if (written.length) {
			const kinds = formats.length === 1 ? formats[0] : `${formats.length} formats`;
			ctx.ui.notify(`Wrote ${written.join(", ")} (${kinds} · ${doc.totals.live} tok live, ${doc.totals.full} tok full)`, "info");
		}
	}

	// ── /accordion : open the native context panel ─────────────────────────────
	const ACCORDION_USAGE = "[context | tasks tree | tasks lists | conductors | settings | sessions | compact | web | tasks | budget | tail]";
	const PANEL_TAB_ALIASES: Record<string, PanelTabId | undefined> = { context: "context", blocks: "context", "tasks tree": "tasks", "tasks open": "tasks", "tasks lists": "lists", "tasks list": "lists", lists: "lists", conductors: "conductors", conductor: "conductors", settings: "settings", config: "settings" };
	pi.registerCommand("accordion", {
		description: `${ACCORDION_USAGE} — open the Accordion context panel`,
		getArgumentCompletions: (text: string) => {
			const q = text.trim().toLowerCase();
			const items = [
				{ value: "context", label: "context", description: "Open the panel on the Context tab: map and block list" },
				{ value: "conductors", label: "conductors", description: "Open the panel on the Conductors tab" },
				{ value: "settings", label: "settings", description: "Open the panel on the Settings tab" },
				{ value: "sessions", label: "sessions", description: "Choose a live Pi session to inspect/steer" },
				{ value: "compact", label: "compact", description: "Run an immediate Accordion compression pass" },
				{ value: "web", label: "web", description: "Show the Browser URL and focus the desktop app" },
				{ value: "tasks", label: "tasks", description: "Expand or collapse the task list above the editor" },
				{ value: "budget ", label: "budget", description: "Set the token budget for this session, e.g. 200k, 1M or 85% (--default saves it for this model)" },
				{ value: "tail ", label: "tail", description: "Set the protected tail for this session, e.g. 20k (--default saves it for this model)" },
				{ value: "tasks lists", label: "tasks lists", description: "Browse the project's task lists: attach, release, start one, or drill into tasks and their folds" },
				{ value: "tasks tree", label: "tasks tree", description: "This session's transcript by task: spans, folds, kept user messages, untracked work" },
				{ value: "tasks adopt", label: "tasks adopt", description: "Adopt a session recorded before task events so its finished tasks fold; --dry-run only reports" },
				{ value: "tasks dump-transcript ", label: "tasks dump-transcript", description: "Write the outgoing projection to a file: [--format <tree|yaml|xml|md|flat> | --formats <a,b,…|all>] [file]" },
				...["expand", "collapse", "hide", "show"].map((v) => ({ value: `tasks ${v}`, label: `tasks ${v}`, description: `${v[0].toUpperCase()}${v.slice(1)} the task list above the editor` })),
			].filter((it) => it.value.startsWith(q));
			return items.length ? items : null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const argument = args.trim();
			if (argument === "web") {
				await handleAccordionWebCommand(ctx);
				return;
			}
			if (argument === "compact") {
				const res = compactNow();
				ctx.ui.notify(res.message, "info");
				return;
			}
			const dialArg = /^(budget|tail)(?:\s+(.*))?$/.exec(argument);
			if (dialArg) {
				const kind: DialKind = dialArg[1] === "budget" ? "budget" : "protect";
				const words = (dialArg[2] ?? "").split(/\s+/).filter(Boolean);
				const asDefault = words.includes("--default");
				const amount = words.filter((w) => w !== "--default").join("");
				const d = currentDials();
				const name = kind === "budget" ? "Budget" : "Protected tail";
				if (!amount) {
					const now = kind === "budget" ? truth?.budget : truth?.protectTokens;
					ctx.ui.notify(`${name}: ${now === undefined ? "–" : formatTokens(now)}${d ? ` (${describeSource(d.sources[kind])}${d.sources[kind].kind === "default" && (d.sources[kind] as { key: string }).key === d.model ? "" : ` for ${d.model}`})` : ""}. Usage: /accordion ${dialArg[1]} <200k | 1M | 85%> [--default]`, "info");
					return;
				}
				const value = parseTokens(amount, contextWindow);
				if (typeof value !== "number") {
					ctx.ui.notify(value.error, "warning");
					return;
				}
				if (!truth) {
					ctx.ui.notify("No session context yet", "warning");
					return;
				}
				applyCommand({ kind: kind === "budget" ? "setBudget" : "setProtect", value });
				const set = kind === "budget" ? truth.budget : truth.protectTokens;
				const clamped = set !== value ? ` (capped at the ${formatTokens(set)} context window)` : "";
				ctx.ui.notify(asDefault ? `${saveDialDefault(kind, value)}; this session uses ${formatTokens(set)}${clamped}.` : `${name} ${formatTokens(set)} for this session${clamped}.`, "info");
				return;
			}
			const tasksAdopt = /^tasks\s+adopt(\s+--dry-run)?\s*$/.exec(argument);
			if (tasksAdopt) {
				const next = needsAdoption(readSessionMessages(ctx), adoption) ? deriveFor(ctx) : null;
				if (!next || !Object.keys(next.events).length) ctx.ui.notify("Nothing to adopt: every task call in this session already records its events.", "info");
				else if (tasksAdopt[1]) ctx.ui.notify(`Dry run: adoption would add ${adoptionSummary(next)}. Nothing was written.`, "info");
				else {
					adopt(ctx, next);
					ctx.ui.notify(`Adopted: ${adoptionSummary(next)}.`, "info");
				}
				return;
			}
			const tasksDump = /^tasks\s+dump-transcript\b(.*)$/.exec(argument);
			if (tasksDump) {
				await dumpTranscript(tasksDump[1], ctx);
				return;
			}
			const tasksArg = PANEL_TAB_ALIASES[argument] ? null : /^tasks(?:\s+(\S+))?$/.exec(argument);
			if (tasksArg) {
				const verb = tasksArg[1] ?? "toggle";
				if (verb === "toggle") taskWidget.toggle();
				else if (verb === "expand" || verb === "show") taskWidget.setExpanded(verb === "expand" || !!settings.taskWidget.expanded);
				else if (verb === "collapse") taskWidget.setExpanded(false);
				else if (verb === "hide") taskWidget.hide();
				else {
					ctx.ui.notify("Usage: /accordion tasks [lists | tree | adopt [--dry-run] | dump-transcript | expand | collapse | hide | show]", "warning");
					return;
				}
				taskWidget.reload();
				const why = taskWidget.reason();
				if (why && verb !== "hide") ctx.ui.notify(`Task list not shown: ${why}.`, "info");
				return;
			}
			const startTab = PANEL_TAB_ALIASES[argument];
			if (argument && argument !== "sessions" && !startTab) {
				ctx.ui.notify(`Usage: /accordion ${ACCORDION_USAGE}`, "warning");
				return;
			}
			if (ctx.mode !== "tui" || !ctx.hasUI) {
				ctx.ui.notify(`Accordion: ${truth?.blocks.length ?? 0} blocks · folding ${foldingEnabled ? "on" : "off"}. Open /accordion in the Pi TUI to manage context.`, "info");
				return;
			}
			if (startTab === "lists" && !taskSession) {
				ctx.ui.notify("Task lists need a conductor that provides the tasks tool (Taskfold). Attach it in /accordion conductors.", "info");
				return;
			}
			const openedSessionId = sessionId;
			let target: SessionEntry | undefined;

			if (argument === "sessions") {
				let entries: SessionEntry[];
				try { entries = await discoverNativeSessions(); }
				catch (error) { ctx.ui.notify(`Cannot discover Accordion sessions: ${error instanceof Error ? error.message : String(error)}`, "error"); return; }
				if (sessionId !== openedSessionId) return;
				entries = entries.filter((entry) => entry.sessionId !== openedSessionId && entry.protocolVersion === PROTOCOL_VERSION);
				const safe = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ").slice(0, 120);
				const options = ["Current session", ...entries.map((entry) => `${safe(entry.title || "Pi session")} · ${safe(entry.cwd)} · ${safe(entry.sessionId)}`)];
				const selected = await ctx.ui.select("Accordion session", options);
				if (sessionId !== openedSessionId || selected === undefined) return;
				const index = options.indexOf(selected);
				if (index < 0) return;
				target = index > 0 ? entries[index - 1] : undefined;
			}
			const control = await claimNativeControl(ctx, openedSessionId, "Opening this panel for steering");
			if (!control) return;
			const { surfaceId, error: controlError } = control;
			let host: AccordionTuiHost = {
				truth: () => sessionId === openedSessionId ? truth : null,
				sessionLabel: () => "current session",
				sessionId: () => sessionId,
				folding: () => foldingEnabled,
				conductors: () => catalogMeta(readinessOf),
				activeConductor: () => liveHost.activeMeta(),
				conductorStatus: () => {
					const st = liveHost.cachedStatus();
					return st ? { text: st.text, metrics: st.metrics } : null;
				},
				canSteer: () => holdsControl(surfaceId, openedSessionId),
				controlMessage: () => controlError,
				supportsConditionalOps: () => true,
				thinkingLevel: () => pi.getThinkingLevel(),
				webInfo: () => ({
					url: currentWebUrl(),
					bindHost: displayWebHost(),
					port,
					doorPort: resolvedDoorPort(),
					token: activeBrowserToken(),
					clients: clients.size,
				}),
				settings: () => ({ ...settings, bindHost: displayWebHost(), doorPort: resolvedDoorPort() ?? 0, customToken: activeCustomToken() }),
				updateSettings: (patch) => {
					const prevHost = settings.bindHost;
					const prevDoor = settings.doorPort;
					settings = saveSettings(HOME, { ...settings, ...patch });
					if (patch.customToken !== undefined && settings.customToken) {
						webToken = settings.customToken;
					}
					if ((patch.bindHost !== undefined && settings.bindHost !== prevHost) || (patch.doorPort !== undefined && settings.doorPort !== prevDoor)) {
						closeDoor();
						doorForeign = false;
						tryBindDoor();
					}
					notifyNative();
					return settings;
				},
				regenerateToken: () => regenerateSharedToken(),
				dials: () => currentDials(),
				saveDialDefault: (kind, value) => saveDialDefault(kind, value),
				compactNow: () => compactNow(),
				listSessions: () => discoverNativeSessions(),
				tasks: { views: taskViewsHost(surfaceId, openedSessionId), lists: taskSession?.listsHost() ?? null },
				command: (command) => {
					refreshControllerNow();
					const lease = controllerLease;
					if (sessionId !== openedSessionId || !lease || lease.surfaceId !== surfaceId || !isFreshLease(lease, Date.now())) {
						return { results: [], rev: truth?.rev ?? 0, refused: "read-only" };
					}
					return applyCommand(command);
				},
				subscribe: (listener) => {
					nativeListeners.add(listener);
					return () => nativeListeners.delete(listener);
				},
			};
			let remote: Awaited<ReturnType<typeof connectRemoteSession>> | undefined;
			const resumeWidget = taskWidget.suspend();
			try {
				if (target) {
					const fresh = (await discoverNativeSessions()).find((entry) => entry.sessionId === target?.sessionId);
					if (!fresh) throw new Error("The selected session is no longer available; reopen /accordion sessions");
					target = fresh;
					remote = await connectRemoteSession(fresh, surfaceId);
					if (sessionId !== openedSessionId) return;
					nativeRemotes.add(remote);
					const localHost = host;
					const remoteHost = remote;
					host = {
						...remoteHost,
						truth: () => sessionId === openedSessionId ? remoteHost.truth() : null,
						sessionLabel: () => `${target?.title || "Pi session"} · ${target?.cwd || ""}`,
						sessionId: () => target?.sessionId ?? "",
						tasks: undefined,
						canSteer: () => !!localHost.canSteer?.() && !!remoteHost.canSteer?.(),
						controlMessage: () => localHost.controlMessage?.() ?? null,
						thinkingLevel: () => localHost.thinkingLevel?.() ?? null,
						webInfo: () => localHost.webInfo!(),
						settings: () => localHost.settings!(),
						updateSettings: (patch) => localHost.updateSettings!(patch),
						regenerateToken: () => localHost.regenerateToken!(),
						listSessions: () => localHost.listSessions!(),
						command: (command) => {
							refreshControllerNow();
							if (!localHost.canSteer?.()) return { results: [], rev: 0, refused: "read-only" };
							return remoteHost.command(command);
						},
						subscribe: (listener) => {
							const unsubscribeLocal = localHost.subscribe(listener);
							const unsubscribeRemote = remoteHost.subscribe(listener);
							return () => { unsubscribeLocal(); unsubscribeRemote(); };
						},
					};
				}
				await (dependencies.openPanel ?? openAccordionPanel)(ctx, host, startTab);
			} catch (error) {
				ctx.ui.notify(`Accordion session unavailable: ${error instanceof Error ? error.message : String(error)}`, "error");
			} finally {
				resumeWidget();
				if (remote) { nativeRemotes.delete(remote); remote.close(); }
				if (nativeSurfaceId === surfaceId) nativeSurfaceId = null;
			}
		},
	});

	pi.registerShortcut(settings.taskWidget.toggleKey as Parameters<typeof pi.registerShortcut>[0], {
		description: "Expand or collapse the Accordion task list",
		handler: () => taskWidget.toggle(),
	});

	pi.registerCommand("accordion-web", {
		description: "Open or focus the optional Accordion browser or desktop interface",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			await handleAccordionWebCommand(ctx);
		},
	});

	// ── unfold tool: let the live agent restore its own folded context ─────────
	// Phase B: resolved LOCALLY against the in-process Truth (no client needed). The unfolded
	// block becomes standing-open (sticky, provenance "agent") and its content returns to the
	// model on the NEXT `context` hook — it simply no longer appears in the fold serialization.

	pi.registerTool({
		name: "tasks",
		label: "Tasks",
		defaultActive: false,
		description:
			"Plan and track multi-step work as a persistent, nested task list for this project (.pig/tasks/<list>.json). A task's SPAN runs from its `start` call to the call that ends it; Accordion later folds a finished span into a compact record built from your report, so the report is all later turns see of that work.\n" +
			"Lifecycle: todo → start → doing → complete (done) | fail (failed) | abandon (abandoned); doing → block (blocked) → start again to resume.\n" +
			"- complete: the task's goal was reached.\n" +
			"- fail: you tried and the goal was not reached, and you are not pursuing it further. The report says what was tried and quotes the failing command or error.\n" +
			"- abandon: stopped on purpose without a verdict (no longer wanted, replaced, the user changed course). Works on unstarted and blocked tasks too. Pass supersededBy when another task replaces it.\n" +
			"- block: you cannot continue because of something outside your control; the task stays open and resumes with start. reason is one of user-decision (the user must choose), user-input (information, credentials or access only the user can give), third-party (an external service, review or release), dependency (another task must finish first; give blockedBy). detail says exactly what is awaited.\n" +
			"Rules: start a subtask and its parents start with it. Only one branch is in progress at a time; a blocked task frees you to start another. A parent completes only when none of its subtasks is unstarted or blocked; fail or abandon those first. fail/abandon on a parent abandons its unstarted and blocked subtasks. complete and fail are refused when nothing ran inside the task since its start.\n" +
			"Every list has 1–5 goals: together the end state the whole list delivers. A task may add up to 3 goals of its own. Give leaf tasks 1–3 acceptanceCriteria, checkable statements that are true when the task is finished. Ids follow position; inserting or moving renumbers only tasks not started yet, and ids of started tasks never change.\n" +
			"Results are one-line JSON: {\"ok\":true,…} with only what the tool decided, or {\"ok\":false,\"error\":<code>,\"message\"} when refused. Goals, criteria, pins and attachments carry ids (g1, c1, p1, a1) that stay fixed; results return the ids they assign. start returns the list goals and each entering task's goals, criteria, pins and attachment content once (parents: those of tasks already in progress above it that you can no longer see); keep them in mind, later results do not repeat them. claim returns the same for tasks already in progress. next: the task to start next (resume: true means start it again to resume). parentReady: all subtasks of that task are finished, so complete it now with its own report. resumable: a blocked parent can continue. alsoBlocked: parents that now wait too. After a user-decision, user-input or third-party block, tell the user exactly what you need.\n" +
			"Actions: create {list, title, goals: [texts], tasks}, list, claim {list, force?}, release {list}, add {list, parent?, before?|after?, tasks[{title, goals?, acceptanceCriteria?, subtasks?, supersedes?}]}, update {list, id?, title?, goals? (list without id, task with id), acceptanceCriteria? (task)} where goals/acceptanceCriteria take {add?: [texts], remove?: [ids], edit?: [{id, text}]}, move {list, id, parent?, before?|after?} (unstarted tasks only), pin|attach {list, id?, items}, unpin {list, id?, pins: [ids]}, detach {list, id?, attachments: [ids]}, status {list}, start {list, id}, block {list, id, reason, detail, blockedBy?}, complete|fail|abandon {list, id, report, supersededBy? (abandon)}.",
		promptSnippet: "tasks(action, …) — persistent nested task lists; start before the work, then complete, fail, abandon or block with a reason.",
		promptGuidelines: [
			"Use the `tasks` tool for work with more than one step; a single question or a one-step change needs no list. Create or claim a list, then call `start` BEFORE the first tool call of a task's work and end the task right AFTER its last one. Work done while no task is in progress belongs to no record; if new work comes up, `add` a task for it and start it first.",
			"Use `tasks` to split broad features into child tasks with independently verifiable outcomes before starting their work; do not bundle several substantial features into one leaf. For example, a transcript feature can have separate children for branches, filters and previews. Start, work on and finish each child so completed work can fold while its parent stays open. If a leaf grows broader than expected, add children before continuing; avoid splitting trivial steps just to increase task count.",
			"Never start and end a task back to back without work in between. After the last subtask, complete the parent with its own report that sums up the whole branch. A reply to the user is not a separate task: if an unfinished task needs the user's approval or choice, block it with user-decision before replying, then resume it when the answer resolves the block.",
			"Pick the ending that is true: `complete` when the goal was reached; `fail` when you tried and it was not reached (quote the failing command or error in the report); `abandon` when the task is no longer wanted or another task replaces it (pass `supersededBy`, or add the new task with `supersedes`). Never complete a task whose goal was not reached.",
			"When you cannot continue, `block` the task instead of leaving it in progress or failing it: `user-decision`, `user-input` or `third-party` when you wait on something outside your control, with a `detail` that states exactly what you need; then ask the user for it, continue with work that does not depend on it, and stop only if nothing else is left. `dependency` (with `blockedBy`) means another task comes first: work on that task now. Stop only when the list is finished or every remaining task is waiting on user-decision, user-input or third-party.",
			"Reports become the folded record: `outcome` is what was achieved in one or two sentences, `decisions` are `choice — reason` lines, `open` lists anything unresolved. Files changed and checks run are recorded automatically.",
		],
		parameters: Type.Object({
			action: Type.Union(
				TASK_ACTIONS.map((a) => Type.Literal(a)),
				{ description: "What to do." },
			),
			list: Type.Optional(Type.String({ description: 'List slug, e.g. "auth-refactor" (lowercase, digits, dashes).' })),
			title: Type.Optional(Type.String({ description: "For create: the list title. For update: the new title of the list or of task id." })),
			goals: Type.Optional(
				Type.Union([Type.Array(Type.String()), Type.Object({ add: Type.Optional(Type.Array(Type.String())), remove: Type.Optional(Type.Array(Type.String())), edit: Type.Optional(Type.Array(Type.Object({ id: Type.String(), text: Type.String() }))) })], {
					description: "For create: 1–5 goal texts, together the end state the whole list delivers. For update: {add?: [texts], remove?: [ids], edit?: [{id, text}]} on the list's goals (no id) or a task's goals (id).",
				}),
			),
			acceptanceCriteria: Type.Optional(Type.Object({ add: Type.Optional(Type.Array(Type.String())), remove: Type.Optional(Type.Array(Type.String())), edit: Type.Optional(Type.Array(Type.Object({ id: Type.String(), text: Type.String() }))) }, { description: "For update with id: {add?: [texts], remove?: [ids], edit?: [{id, text}]} on the task's checkable acceptance criteria." })),
			tasks: Type.Optional(
				Type.Array(
					Type.Object({
						title: Type.String(),
						goals: Type.Optional(Type.Array(Type.String(), { description: "Up to 3 goals of this subtree beyond its criteria." })),
						acceptanceCriteria: Type.Optional(Type.Array(Type.String(), { description: "1–3 checkable statements that are true when the task is finished." })),
						pins: Type.Optional(Type.Array(Type.Any())),
						attachments: Type.Optional(Type.Array(Type.Any())),
						subtasks: Type.Optional(Type.Array(Type.Any())),
						supersedes: Type.Optional(Type.String({ description: "For add: id of an earlier task this one replaces; it is abandoned if still open." })),
					}),
					{ description: "Tasks to create or add: [{ title, goals?, acceptanceCriteria?, subtasks?: [{ title, … }], supersedes? }]." },
				),
			),
			items: Type.Optional(Type.Array(Type.Any(), { description: 'For pin: [{kind, text, source}]; attach: [{path, section? | symbol? | quote? | lines?, note?}] (one anchor: a Markdown heading path "A > B", a declaration "Class.method", exact text, or a line range turned into a quote). Omit id for list scope.' })),
			pins: Type.Optional(Type.Array(Type.String(), { description: "For unpin: pin ids to remove." })),
			attachments: Type.Optional(Type.Array(Type.String(), { description: "For detach: attachment ids to remove." })),
			parent: Type.Optional(Type.String({ description: "Parent task id for add or move, e.g. \"2\" or \"2.1\"." })),
			before: Type.Optional(Type.String({ description: "For add and move: place before this sibling task id." })),
			after: Type.Optional(Type.String({ description: "For add and move: place after this sibling task id." })),
			id: Type.Optional(Type.String({ description: 'Task id, e.g. "1.2".' })),
			report: Type.Optional(
				Type.Object(
					{
						outcome: Type.String({ description: "What this task achieved, or for fail what was tried and what went wrong, in one or two sentences." }),
						decisions: Type.Optional(Type.Array(Type.String(), { description: '"choice — reason" lines.' })),
						open: Type.Optional(Type.Array(Type.String(), { description: "Anything left unresolved." })),
					},
					{ description: "Required for complete, fail and abandon." },
				),
			),
			reason: Type.Optional(
				Type.Union(BLOCK_REASONS.map((r) => Type.Literal(r)), {
					description: "For block: user-decision | user-input | third-party (waiting outside your control) | dependency (another task first; give blockedBy).",
				}),
			),
			detail: Type.Optional(Type.String({ description: 'For block: exactly what is awaited, e.g. "the user must choose between Postgres and SQLite".' })),
			blockedBy: Type.Optional(Type.String({ description: 'For block with reason dependency: the id of the task this one waits for.' })),
			supersededBy: Type.Optional(Type.String({ description: "For abandon: the id of the task that replaces this one." })),
			force: Type.Optional(Type.Boolean({ description: "For claim: take over a list another session holds. Ask the user first." })),
		}),
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			const store = taskStoreFor(ctx);
			const args = params as TasksArgs;
			const read = (): TaskList | null => {
				try {
					return args.list ? store.read(args.list) : null;
				} catch {
					return null;
				}
			};
			const sizeBefore = args.action === "add" ? read()?.tasks.length : undefined;
			try {
				if ((args.action === "complete" || args.action === "fail") && args.list && args.id && tasksToolActive() && taskCoach.spanWork(args.list, args.id) === 0) {
					const ended = read()?.tasks.filter((t) => t.endedAt && t.id !== args.id && !t.id.startsWith(`${args.id}.`)).sort((a, b) => b.endedAt!.localeCompare(a.endedAt!))[0];
					throw new TaskError("empty_span", emptySpanRefusal(args.list, args.id, ended?.id ?? null));
				}
				await warmSymbols(symbolFiles(args, read()));
				const userTexts = ["pin", "create", "add"].includes(args.action) ? readSessionMessages(ctx).filter((m) => m.role === "user").map((m) => typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((p) => p.type === "text" ? p.text ?? "" : "").join("\n") : "") : [];
				const run = runTasksTracked(store, args, userTexts, { ...PIN_LIMITS, ...settings.tasks.pins, maxLines: settings.tasks.attachments.maxLines, roots: settings.tasks.attachments.roots });
				if (run.started.length && args.list) taskCoach.started(args.list, run.started);
				if (run.finished && args.list) taskCoach.finished(args.list, run.finished);
				const list = read();
				// Task context rides once in the result that starts the work, so it folds with the span.
				const result: Record<string, unknown> = { ...run.result };
				let delivered: string[] = [];
				// Keys are scoped by list: pin and attachment ids repeat across lists.
				const scoped = (key: string) => `${args.list}/${key}`;
				if (list && args.list && (args.action === "start" || args.action === "claim")) {
					// A doing ancestor's context applies to the task starting under it; resend it if folding hid it.
					const parents = args.action === "start" ? [...new Set(run.started.flatMap((id) => id.split(".").slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join("."))))].filter((id) => !run.started.includes(id) && list.tasks.some((t) => t.id === id && t.status === "doing")) : [];
					const entering = args.action === "start" ? [...parents, ...run.started] : list.tasks.filter((t) => t.status === "doing").map((t) => t.id);
					const current = truth;
					const live = current ? liveDeliveryKeys(current.blocks, (b) => foldingEnabled && current.isFolded(b as Block)) : new Set<string>();
					const delivery = deliverContext(list, entering, true, (key) => live.has(scoped(key)), ctx.cwd, settings.tasks.attachments.render, settings.tasks.attachments.maxLines, settings.tasks.attachments.roots);
					delivered = delivery.delivered.map(scoped);
					if (Object.keys(delivery.seen).length) store.recordSeen(args.list, delivery.seen);
					const byId = new Map(delivery.tasks.map((t) => [t.id, t]));
					const withContext = (ref: unknown) => {
						const id = typeof ref === "string" ? ref : (ref as { id: string }).id;
						const c = byId.get(id);
						return c && (c.criteria || c.pins || c.attachments) ? c : ref;
					};
					if (args.action === "claim") {
						if (delivery.tasks.length) result.active = delivery.tasks.map((c) => (c.criteria || c.pins || c.attachments ? c : { id: c.id, title: c.title }));
					} else {
						if (run.result.started) result.started = run.result.started.map(withContext);
						if (run.result.resumed) result.resumed = run.result.resumed.map(withContext);
						const missing = parents.flatMap((id) => {
							const c = byId.get(id);
							return c && (c.goals || c.criteria || c.pins || c.attachments) ? [c] : [];
						});
						if (missing.length) {
							const { ok: _ok, ...rest } = result;
							for (const k of Object.keys(result)) delete result[k];
							Object.assign(result, { ok: true, parents: missing }, rest);
						}
					}
					if (delivery.list) {
						const { ok: _ok, ...rest } = result;
						for (const k of Object.keys(result)) delete result[k];
						Object.assign(result, { ok: true, list: delivery.list }, rest);
					}
				}
				const text = JSON.stringify(result);
				const details: TasksDetails = {
					...tasksDetails(args, list, sizeBefore === undefined ? undefined : (list?.tasks.length ?? sizeBefore) - sizeBefore, args.action === "list" ? store.lists().length : undefined, run.renumbered),
					...(run.started.length ? { started: run.started } : {}),
					...(run.closed.length ? { closed: run.closed.map(({ id, title, status, report, acceptanceCriteria, pins }) => ({ id, title, status, report, acceptanceCriteria: acceptanceCriteria?.map((c) => c.text), pins })) } : {}),
					...(run.cascaded.length ? { cascaded: run.cascaded.map(({ id, title, status, report, acceptanceCriteria, pins }) => ({ id, title, status, report, acceptanceCriteria: acceptanceCriteria?.map((c) => c.text), pins })) } : {}),
				};
				const event = taskEventOf(args, list, run);
				if (event && !nestedTaskEvents.queue(toolCallId, event)) details.taskEvents = [event];
				// The agent wrote a pin's text, so a direct pin result counts as delivering it.
				if (args.action === "pin" && Array.isArray(run.result.pins)) delivered = (run.result.pins as string[]).map((id) => scoped(deliveryKey.pin(id)));
				if (delivered.length) details.delivered = delivered;
				return { content: [{ type: "text", text }], details };
			} catch (err) {
				// Pi turns a thrown error into an error result whose text is the message: the JSON envelope.
				if (err instanceof TaskError) throw new Error(err.toResult());
				if (err instanceof PinError) throw new Error(new TaskError(err.code, err.message).toResult());
				throw new Error(JSON.stringify({ ok: false, error: "internal", message: err instanceof Error ? err.message : String(err) }));
			} finally {
				if (latestCtx?.sessionManager.getSessionId() === ctx.sessionManager.getSessionId()) {
					taskSession?.markSeen();
					taskWidget.reload();
					notifyNative();
				}
			}
		},
		...toolRowRenderers((theme, args, state, details, text, expanded) => tasksRow(theme, args, state, details as TasksDetails | undefined, text, expanded)),
	});

	pi.registerTool({
		name: "unfold",
		label: "Unfold Context",
		description:
			"Restore folded context. Accordion (the live context manager attached to this session) may replace older parts of YOUR OWN context with a short summary tagged like `{#3f9a2c FOLDED}`. The original content is preserved, not lost. Call this tool with the short code(s) from those tags to restore the full content. The restored content reappears in your context on your NEXT turn (your past context changes) and stays in every later request; this call confirms what was scheduled. Use it only for a small block you will keep referring to. A large fold is refused: look things up in it with `recall` instead.",
		promptSnippet: "unfold(codes) — restore context folded by Accordion (blocks tagged {#<code> FOLDED}).",
		promptGuidelines: [
			"When you see a `{#<code> FOLDED}` marker in your context (e.g. `{#3f9a2c FOLDED}`), that block was compacted by Accordion to save tokens — the full content is preserved, not lost. If the summary is not enough for your current task, call `unfold` with the code(s) from the marker(s) to restore them; the content returns on your next turn.",
		],
		parameters: Type.Object({
			codes: Type.Array(Type.String({ description: 'A fold code copied verbatim from a {#<code> FOLDED} tag, e.g. "3f9a2c". Always a string (codes may have leading zeros).' }), {
				description: "One or more fold codes to restore to full content.",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const codes = Array.isArray(params.codes)
				? params.codes.map((s) => String(s).trim()).filter((s) => s.length > 0)
				: [];
			if (!codes.length) {
				return { content: [{ type: "text", text: 'No fold codes given. Pass the code(s) from a {#<code> FOLDED} tag, e.g. unfold({codes:["3f9a2c"]}).' }] };
			}
			// Nothing rides the wire folded unless folding is armed, so there is nothing to unfold.
			if (!truth || !foldingEnabled) {
				return { content: [{ type: "text", text: "Accordion isn't folding your context right now, so nothing is folded to restore — it is already full." }] };
			}
			// LOCAL: mutates the Truth (broadcasts to clients). Bounded: a fold too large to stand in the
			// context stays folded and the agent is pointed at `recall` (SPEC-0003 §6).
			const ceiling = truth.budget > 0 ? settings.taskfold.high * truth.budget : Number.POSITIVE_INFINITY;
			const res = resolveUnfoldBounded(truth, codes.map((c) => c.replace(/^#/, "")), { maxTokens: settings.recall.unfoldTokens, ceiling });
			const lines: string[] = [];
			for (const r of res.refused) {
				const why = r.reason === "size" ? `more than one unfold may add (${settings.recall.unfoldTokens.toLocaleString("en-US")})` : "more than the context has room for";
				lines.push(`#${r.code} stays folded: unfolding it would add ~${Math.round(r.tokens).toLocaleString("en-US")} tokens to every later request, ${why}. Look up what you need instead: recall({codes:["${r.code}"]}) for its report or entry list, recall({codes:["${r.code}"], query:"text"}) to search it.`);
			}
			if (res.restored.length) {
				lines.push(`Unfolded ${res.restored.length} block(s); full content returns on your next turn:`);
				for (const r of res.restored) lines.push(`  • ${r?.label ?? "block"} (#${r?.code ?? "?"})`);
			}
			if (res.missing.length) {
				lines.push(`No folded block for: ${res.missing.map((c) => "#" + c).join(", ")} (already full, or not in this session's context).`);
			}
			// Every input code resolves to restored, missing or refused, so `lines` is always non-empty.
			return { content: [{ type: "text", text: lines.join("\n") }], details: res };
		},
		...toolRowRenderers((theme, args, state, details, text, expanded) => foldToolRow(theme, "unfold", args, state, details as { restored?: unknown[]; missing?: unknown[] } | undefined, text, expanded)),
	});

	/**
	 * Note the facts of folded tasks that have no ledger yet (SPEC-0003 §8), newest first, one task at
	 * a time and off the request path. A task is stored once all its parts answered; a failure leaves
	 * it without rows until the next start.
	 */
	async function noteFacts(): Promise<void> {
		if (ledgerBusy || !settings.recall.ledger.enabled || !truth || !foldingEnabled || truth.rev === ledgerIdleRev) return;
		ledgerBusy = true;
		const session = sessionId;
		try {
			for (;;) {
				const t = truth;
				if (!t || session !== sessionId || !settings.recall.ledger.enabled) return;
				const reportOf = taskReports(t);
				const next = foldedTasks(t).find((f) => !factLedger.has(f.task) && !ledgerTried.has(f.task) && reportOf(f.task)?.status);
				const title = next ? (reportOf(next.task)?.title ?? "").slice(0, 120) : "";
				if (!next) {
					ledgerIdleRev = t.rev;
					return;
				}
				ledgerTried.add(next.task);
				if (next.entries.reduce((n, b) => n + b.tokens, 0) < LEDGER_MIN_TOKENS) {
					factLedger.set(next.task, []);
					continue;
				}
				const blocked = await askModelAllowed(false);
				if (blocked) throw new Error(blocked);
				const rows: FactRow[] = [];
				for (const chunk of ledgerChunks(next.entries).chunks) {
					const res = await runCompletion({ system: LEDGER_SYSTEM, prompt: chunk.prompt, maxOutputTokens: LEDGER_OUTPUT_TOKENS }, new AbortController().signal, "recall");
					const found = verifiedRows(res.text, chunk, (id) => t.get(id)?.text ?? "");
					if (!found) throw new Error("the model returned no row list");
					rows.push(...found);
				}
				if (session !== sessionId) return;
				factLedger.set(next.task, rows, title);
				pi.appendEntry(LEDGER_ENTRY, ledgerData(next.task, rows, title));
			}
		} catch (err) {
			if (!ledgerWarned && session === sessionId) {
				ledgerWarned = true;
				latestCtx?.ui.notify(`Accordion could not note the facts of a folded task (recall.ledger): ${err instanceof Error ? err.message : String(err)}`, "warning");
			}
		} finally {
			ledgerBusy = false;
		}
	}

	/** May the recall side model receive session content? The session's own model and local models may. */
	async function askModelAllowed(interactive = true): Promise<string | null> {
		const ctx = latestCtx;
		let m: any;
		try {
			m = ctx ? resolveChatModel("recall", undefined) : null;
		} catch (err) {
			return err instanceof Error ? err.message : String(err);
		}
		if (!ctx || !m) return "no model available";
		const own = latestModelObj ?? (ctx.model as any);
		if ((own && m.provider === own.provider && m.id === own.id) || isLoopbackUrl(m.baseUrl) || settings.privacyConsent.recall) return null;
		const refused = `the recall model ${m.provider}/${m.id} is a remote model other than this session's and has no consent`;
		if (!interactive || !ctx.hasUI) return refused;
		const session = sessionId;
		const accepted = await ctx.ui.confirm("Recall: privacy notice", `recall({ask}) sends task reports and excerpts of this session's folded context to ${m.provider}/${m.id}. When the fact ledger is enabled, it also sends folded task entries to the same model automatically in the background.\n\nAccept once and allow both?`).catch(() => false);
		if (!accepted || session !== sessionId) return refused;
		settings = saveSettings(HOME, { ...settings, privacyConsent: { ...settings.privacyConsent, recall: new Date().toISOString() } });
		return null;
	}

	/** `recall({ask})`: one bounded side-model completion; without an answer, the closest hits (SPEC-0003 §7). */
	async function answerRecall(t: Truth, callId: string, question: string, codes: string[], query: string | undefined, signal: AbortSignal | undefined) {
		let grant = recallAccount.grant(t);
		if (grant < recallAccount.minGrant(t)) {
			releaseRecall(true);
			grant = recallAccount.grant(t);
		}
		if (grant < recallAccount.minGrant(t)) return { content: [{ type: "text" as const, text: recallRefusal(recallAccount.outstanding(t), recallAccount.policy) }], details: { restored: [], missing: [], refused: true } };
		const material = askMaterial(t, { question, codes, query, reportOf: taskReports(t), facts: factLedger.all(), inputTokens: settings.recall.ask.inputTokens });
		let text: string;
		let answered = false;
		const blocked = !settings.recall.ask.enabled ? "recall.ask is turned off in ~/.accordion/config.json" : !material.text ? "nothing folded matches" : await askModelAllowed();
		if (blocked) text = askFallback(blocked, material, grant);
		else {
			try {
				// Room for a reasoning model's thinking; the answer itself is cut to its limit below.
				const res = await runCompletion({ system: ASK_SYSTEM, prompt: askPrompt(question, material.text), maxOutputTokens: ASK_ANSWER_TOKENS * 4 }, signal ?? new AbortController().signal, "recall");
				const answer = res.text.trim().slice(0, Math.min(ASK_ANSWER_TOKENS, grant) * 4);
				if (!answer) throw new Error("the model returned no text");
				text = askAnswer(question, answer, material.addresses).text;
				answered = true;
			} catch (err) {
				text = askFallback(err instanceof Error ? err.message : String(err), material, grant);
			}
		}
		recallAccount.reserve(callId, estTokens(text));
		if (!answered && material.ids.length) {
			broadcast({ type: "recall", ids: material.ids, by: "agent" });
			liveHost.dispatchRecall(material.ids, "agent");
		}
		return { content: [{ type: "text" as const, text }], details: { restored: [], missing: [], answered } };
	}

	// ── recall tool: an UNBLOCKABLE, BOUNDED READ of folded content (ADR 0011, SPEC-0003) ──
	// recall returns folded content AS a tool result THIS turn (like read_file) without changing
	// what is standing in the agent's context. A task code returns its report; transcript is reached
	// by search or entry address, and one session account bounds all of it (`core/recallAccount.ts`).
	// Phase B: resolved LOCALLY against the Truth (a pure read, never a mutation). Because it
	// changes no state it is never lockable — the net that keeps a locked `unfold` from blinding
	// the agent. A `recall` observation is broadcast so clients/conductors can see the read.
	pi.registerTool({
		name: "recall",
		label: "Recall Folded Content",
		description:
			"Look something up in folded context WITHOUT changing what's standing in your context. Accordion may replace older parts of YOUR OWN context with a short summary tagged like `{#3f9a2c FOLDED}`; the original is preserved. A task's code returns its REPORT (outcome, decisions, open items, files changed, checks run, subtask codes), never its transcript. To find a value, path, number or error, search: `query` alone searches everything folded, `query` with codes searches those folds; all terms must occur in one entry, `\"a phrase\"` is literal, `/re/` is a regular expression. Each hit has an address like `3f9a2c.12`; pass it as a code to read that entry. `3f9a2c.entries` lists a fold's entries. Recalled text is limited per call (~8k tokens) and in total (~24k tokens standing in your context); beyond that a call is refused, so ask for the one thing you need, not for whole tasks. For a question that needs reading and combining (why, how, what happened with X), pass `ask`: you get a short cited answer instead of the material.",
		promptSnippet: "recall(codes?, query?, page?, ask?) — look up folded content: a task code gives its report, `query` searches (all folds when no codes), `code.N` reads one entry, `ask` answers a question with citations.",
		promptGuidelines: [
			"When you need something from a `{#<code> FOLDED}` marker, call `recall`. For what a finished task achieved or decided, recall its code: you get its report. For an exact value, search with `query` (no codes needed) and read the hit's `code.N`. Do not recall many tasks to re-read their work: recalled text has a session limit and further calls are refused. Use `unfold` only when a small block must stay open across turns.",
		],
		parameters: Type.Object({
			codes: Type.Optional(Type.Array(Type.String({ description: 'A fold code from a {#<code> FOLDED} tag, e.g. "3f9a2c", or an entry address from a recall index, e.g. "3f9a2c.12". Always a string (codes may have leading zeros).' }), {
				description: "Fold codes or entry addresses to read. Omit it with `query` to search all folded content.",
			})),
			query: Type.Optional(Type.String({ description: 'Search text: whitespace-separated terms that must all occur in one entry (case-insensitive), "a phrase" in double quotes, or /regex/. Returns excerpts with entry addresses.' })),
			page: Type.Optional(Type.Integer({ minimum: 1, description: "1-based page of an index, entry or search result, as named in the previous result." })),
			ask: Type.Optional(Type.String({ description: "A question in plain words about earlier folded work, e.g. \"Why did we drop the retry wrapper?\". Another model reads the relevant reports and excerpts and returns a short answer with entry addresses as citations. `codes` narrows it to those folds; `query` sets the search terms used to pick excerpts." })),
		}),
		async execute(toolCallId, params, signal, _onUpdate, _ctx) {
			const codes = Array.isArray(params.codes)
				? params.codes.map((s) => String(s).trim().replace(/^#/, "")).filter((s) => s.length > 0)
				: [];
			const query = typeof params.query === "string" && params.query.trim() ? params.query : undefined;
			const ask = typeof params.ask === "string" && params.ask.trim() ? params.ask.trim().slice(0, 1000) : undefined;
			if (!codes.length && !query && !ask) {
				return { content: [{ type: "text", text: 'Nothing to recall: pass codes from {#<code> FOLDED} tags, e.g. recall({codes:["3f9a2c"]}), or a query to search all folded content, e.g. recall({query:"ECONNREFUSED"}).' }] };
			}
			if (!truth) {
				return { content: [{ type: "text", text: "Accordion isn't attached, so nothing in your context is folded right now — it is already full." }] };
			}
			if (ask) return answerRecall(truth, toolCallId, ask, codes, query, signal);
			// LOCAL read — never mutates fold state. The account bounds what all calls together may add.
			const served = serveRecall(truth, recallAccount, toolCallId, { codes, reportOf: taskReports(truth), facts: factLedger.all(), query, page: typeof params.page === "number" ? params.page : undefined }, () => releaseRecall(true));
			if (!served.view) return { content: [{ type: "text", text: served.text }], details: { restored: [], missing: [], refused: true } };
			const view = served.view;
			const ids = view.items.flatMap((r) => r.ids);
			if (ids.length) {
				broadcast({ type: "recall", ids, by: "agent" });
				liveHost.dispatchRecall(ids, "agent");
			}
			// Details stay small: they are persisted with the tool result and must not duplicate the text.
			const details = { restored: view.items.map(({ code, label, mode, ids: shown }) => ({ code, label, mode, ids: shown.length })), missing: view.missing, truncated: view.truncated };
			return { content: [{ type: "text", text: view.text }], details };
		},
		...toolRowRenderers((theme, args, state, details, text, expanded) => foldToolRow(theme, "recall", args, state, details as { restored?: unknown[]; missing?: unknown[]; answered?: boolean } | undefined, text, expanded)),
	});

	// ── skill discovery: expose the unfold skill to pi's skill loader ──────────
	// The skill directory is written by a separate agent; we just point pi at it.
	// Best-effort: a missing directory or any unexpected error must NEVER crash a session.
	pi.on("resources_discover", () => {
		try {
			const here = path.dirname(fileURLToPath(import.meta.url));
			const skillPaths: string[] = [];
			for (const name of ["accordion-context-folding", "accordion-context-recall"]) {
				const dir = path.join(here, "skills", name);
				if (fs.existsSync(dir)) skillPaths.push(dir);
			}
			if (skillPaths.length) return { skillPaths };
		} catch {
			/* best-effort — never break a session over skill discovery */
		}
		return {};
	});
}
