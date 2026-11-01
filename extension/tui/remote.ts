import { readdir, open } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { isLiveEntry, REGISTRY_DIR, SESSIONS_SUBDIR, type SessionEntry } from "../../app/src/lib/live/registry";
import { PROTOCOL_VERSION, isWireBlock, sanitizeSurfaceId, type ActiveConductorMeta, type SnapshotState, type WireEvent, type WireCommand, type WireBlock } from "../../core/protocol";
import { isValidOp, type OpResult } from "../../core/ops";
import { hydrateSnapshot, applyWireEvent } from "../../core/replica";
import type { SessionMeta } from "../../core/types";
import type { Truth } from "../../core/truth";
import type { AccordionTuiHost } from "./host";

const MAX_FRAME = 16 * 1024 * 1024;
const TIMEOUT = 10_000;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const rev = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");
const actor = (v: unknown) => v === "you" || v === "agent" || v === "auto";
const optional = (v: unknown, check: (v: unknown) => boolean) => v === undefined || check(v);
const nullable = (v: unknown, check: (v: unknown) => boolean) => v === null || check(v);
const string = (v: unknown) => typeof v === "string";
const bool = (v: unknown) => typeof v === "boolean";
const portValid = (port: number) => Number.isInteger(port) && port >= 1 && port <= 65535;

function validEntry(v: unknown): v is SessionEntry {
	return isLiveEntry(v, Date.now()) && portValid(v.port) && num(v.protocolVersion) &&
		Number.isFinite(v.heartbeatAt) && num(v.pid) && string(v.cwd) && string(v.title) && string(v.model) &&
		nullable(v.tokens, num) && nullable(v.contextWindow, num) && num(v.startedAt);
}

/** Return fresh, dialable session descriptors without modifying the registry. */
export async function listLiveSessions(): Promise<SessionEntry[]> {
	const dir = join(homedir(), REGISTRY_DIR, SESSIONS_SUBDIR);
	let names: Dirent[];
	try { names = await readdir(dir, { withFileTypes: true }); } catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const entries = await Promise.all(names.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map(async (entry) => {
		try {
			const file = await open(join(dir, entry.name), "r");
			try {
				const bytes = Buffer.alloc(65537);
				const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
				if (bytesRead > 65536) return null;
				const value: unknown = JSON.parse(bytes.toString("utf8", 0, bytesRead));
				return validEntry(value) ? value : null;
			} finally { await file.close(); }
		} catch { return null; }
	}));
	return entries.filter((entry): entry is SessionEntry => entry !== null);
}

function conductor(v: unknown): v is ActiveConductorMeta {
	if (!record(v) || !record(v.readiness)) return false;
	return string(v.id) && string(v.label) && optional(v.description, string) && strings(v.locks) && num(v.tailTokens) && num(v.holdWireUpToMs) && bool(v.remote) &&
		(v.readiness.state === "ready" || (v.readiness.state === "unavailable" && string(v.readiness.reason) && optional(v.readiness.remediation, string)));
}
function wireBlock(b: unknown): b is WireBlock {
	return isWireBlock(b) && num(b.turn) && num(b.order) && num(b.tokens) && optional(b.toolName, string) && optional(b.callId, string) && optional(b.model, string) && optional(b.isError, bool) && optional(b.signed, bool);
}
function snapshot(v: unknown): v is SnapshotState {
	if (!record(v)) return false;
	return Array.isArray(v.blocks) && v.blocks.every(wireBlock) &&
		Array.isArray(v.overlay) && v.overlay.every((o: unknown) => record(o) && string(o.id) && [null, "pinned", "folded", "unfolded"].includes(o.override as never) && bool(o.autoFolded) && nullable(o.by, actor) && optional(o.subst, string)) &&
		Array.isArray(v.groups) && v.groups.every((g: unknown) => record(g) && string(g.id) && strings(g.memberIds) && bool(g.folded) && optional(g.by, actor) && optional(g.digest, (x) => nullable(x, string))) &&
		num(v.budget) && nullable(v.contextWindow, num) && num(v.protectTokens) && strings(v.locks) && nullable(v.lockHolder, string) && num(v.tailTokens) && num(v.sentThroughOrder) && bool(v.wireAttached) && bool(v.foldingEnabled) && strings(v.birthFolded) && optional(v.carriedSent, strings) && optional(v.calibration, num) && optional(v.calibrationThroughOrder, (x) => nullable(x, num)) && optional(v.systemPromptCalibrated, bool) && rev(v.rev);
}
function event(v: unknown): v is WireEvent {
	if (!record(v) || !rev(v.rev)) return false;
	switch (v.kind) {
		case "appended": return Array.isArray(v.blocks) && v.blocks.every(wireBlock);
		case "ops": return actor(v.by) && Array.isArray(v.ops) && v.ops.every(isValidOp);
		case "config": return optional(v.budget, num) && optional(v.contextWindow, (x) => nullable(x, num)) && optional(v.protectTokens, num) && optional(v.calibration, num) && optional(v.calibrationThroughOrder, num) && optional(v.systemPromptCalibrated, bool) && optional(v.systemPrompt, (x) => record(x) && string(x.text) && num(x.tokens));
		case "locks": return strings(v.locks) && nullable(v.holder, string) && num(v.tailTokens);
		case "sent": return num(v.throughOrder);
		case "reset": return actor(v.by);
		default: return false;
	}
}
function result(v: unknown): v is OpResult {
	return record(v) && isValidOp(v.op) && bool(v.applied) && optional(v.clamped, string) && optional(v.detail, string) && optional(v.perId, (x) => Array.isArray(x) && x.every((p: unknown) => record(p) && string(p.id) && bool(p.applied) && optional(p.reason, string)));
}

/** Connect a read-only replica; control is claimed only through the returned claim method. */
export async function connectRemoteSession(entry: SessionEntry, surfaceId: string): Promise<AccordionTuiHost & { claim(): void; close(): void }> {
	if (!validEntry(entry)) throw new Error("Invalid or stale session entry");
	if (entry.protocolVersion !== PROTOCOL_VERSION) throw new Error("Protocol mismatch");
	if (sanitizeSurfaceId(surfaceId) !== surfaceId) throw new Error("Invalid surface id");
	const url = new URL(`ws://127.0.0.1:${entry.port}/`);
	url.searchParams.set("surface", surfaceId);
	url.searchParams.set("label", "Pi TUI");
	const ws = new WebSocket(url, { maxPayload: MAX_FRAME, handshakeTimeout: TIMEOUT });
	let truth: Truth | null = null, meta: SessionMeta | null = null;
	let folding = false, catalog: ActiveConductorMeta[] = [], active: ActiveConductorMeta | null = null;
	let waiting = true, closed = false, controlling = false, seq = 0;
	const listeners = new Set<() => void>();
	const pending = new Map<number, { resolve: (result: { results: OpResult[]; rev: number; refused?: "read-only" }) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
	let readyResolve: (host: AccordionTuiHost & { claim(): void; close(): void }) => void = () => {};
	let readyReject: (error: Error) => void = () => {};
	const ready = new Promise<AccordionTuiHost & { claim(): void; close(): void }>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
	let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => fail(new Error("Snapshot timeout")), TIMEOUT);
	const notify = () => { for (const listener of listeners) { try { listener(); } catch { /* isolate panel callbacks */ } } };
	function fail(error: Error) {
		if (closed) return;
		closed = true;
		if (timer) clearTimeout(timer);
		for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); }
		pending.clear();
		readyReject(error);
		truth = null;
		notify();
		listeners.clear();
		ws.removeAllListeners();
		ws.on("error", () => {});
		ws.terminate();
	}
	function send(value: unknown) {
		if (closed || ws.readyState !== WebSocket.OPEN) throw new Error("Remote session disconnected");
		ws.send(JSON.stringify(value));
	}
	const host: AccordionTuiHost & { claim(): void; close(): void } = {
		truth: () => truth, folding: () => folding, conductors: () => catalog, activeConductor: () => active,
		canSteer: () => !closed && controlling,
		subscribe: (listener) => { if (!closed) listeners.add(listener); return () => { listeners.delete(listener); }; },
		claim: () => send({ type: "claimController" }), close: () => fail(new Error("Remote session closed")),
		command: (cmd: WireCommand) => new Promise((resolve, reject) => {
			if (closed || ws.readyState !== WebSocket.OPEN) { reject(new Error("Remote session disconnected")); return; }
			if (waiting) { reject(new Error("Remote session is resynchronizing")); return; }
			const id = ++seq;
			const timeout = setTimeout(() => { pending.delete(id); reject(new Error("Command timeout")); }, TIMEOUT);
			pending.set(id, { resolve, reject, timer: timeout });
			try { send({ type: "command", seq: id, cmd }); } catch (error) { clearTimeout(timeout); pending.delete(id); reject(error); }
		}),
	};
	ws.on("error", (error) => fail(error));
	ws.on("close", () => fail(new Error("Remote session disconnected")));
	ws.on("message", (data, binary) => {
		try {
			if (binary) throw new Error("Invalid binary frame");
			const msg: unknown = JSON.parse(data.toString());
			if (!record(msg) || typeof msg.type !== "string") throw new Error("Invalid frame");
			if (msg.type === "hello") {
				if (meta || msg.protocolVersion !== PROTOCOL_VERSION || msg.role !== "gui" || (msg.sessionId !== undefined && msg.sessionId !== entry.sessionId) || !record(msg.meta) || msg.meta.format !== "pi" || !string(msg.meta.title) || !string(msg.meta.cwd) || !string(msg.meta.model) || !nullable(msg.meta.contextWindow, num) || (msg.conductors !== undefined && (!Array.isArray(msg.conductors) || !msg.conductors.every(conductor)))) throw new Error("Protocol mismatch or invalid hello");
				meta = msg.meta as unknown as SessionMeta;
				catalog = (msg.conductors ?? []) as ActiveConductorMeta[];
				controlling = record(msg.controller) && msg.controller.surfaceId === surfaceId && msg.controller.fresh === true;
			} else if (msg.type === "snapshot") {
				if (!meta || !snapshot(msg.state)) throw new Error("Invalid snapshot");
				truth = hydrateSnapshot(meta, msg.state); folding = msg.state.foldingEnabled; waiting = false;
				if (timer) { clearTimeout(timer); timer = null; }
				readyResolve(host); notify();
			} else if (msg.type === "event") {
				if (waiting || !truth) return;
				if (!event(msg.event)) throw new Error("Invalid event");
				if (msg.event.kind !== "reset") applyWireEvent(truth, msg.event);
				if (msg.event.kind === "reset" || truth.rev !== msg.event.rev) {
					waiting = true; truth = null; notify(); send({ type: "resnapshot" });
					timer = setTimeout(() => fail(new Error("Resnapshot timeout")), TIMEOUT);
				} else notify();
			} else if (msg.type === "folding") {
				if (!bool(msg.enabled)) throw new Error("Invalid folding frame");
				folding = msg.enabled as boolean; notify();
			} else if (msg.type === "conductorState") {
				if (msg.active !== null && !conductor(msg.active)) throw new Error("Invalid conductor frame");
				active = msg.active as ActiveConductorMeta | null; notify();
			} else if (msg.type === "controller") {
				if (!string(msg.surfaceId) || !string(msg.label)) throw new Error("Invalid controller frame");
				controlling = msg.surfaceId === surfaceId; notify();
			} else if (msg.type === "commandResult") {
				if (!rev(msg.seq) || !rev(msg.rev) || !Array.isArray(msg.results) || !msg.results.every(result) || (msg.refused !== undefined && msg.refused !== "read-only")) throw new Error("Invalid command result");
				const p = pending.get(msg.seq as number);
				if (p) { pending.delete(msg.seq as number); clearTimeout(p.timer); p.resolve({ results: msg.results, rev: msg.rev as number, ...(msg.refused ? { refused: "read-only" as const } : {}) }); }
			}
		} catch (error) { fail(error instanceof Error ? error : new Error("Invalid remote frame")); }
	});
	return ready;
}
