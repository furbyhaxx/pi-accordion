/*
 * thinning.ts — Taskfold's experimental thinning of the context outside finished task spans:
 * Keel-lite's first rungs (fold old thinking, fold stale reads, trim bash output, skeleton code
 * reads), optionally with Keel-note's progress note, and Doorman's birth skeletons for large code
 * reads. The inner conductors run against a proxy host that marks everything they must not touch
 * as held: finished task spans (Taskfold folds those whole), document and rule-file reads (the
 * evidence orientation needs verbatim), and, in `orientation` scope, everything after orientation.
 * Experiment: .project/analyses/orientation-modes/.
 */
import type { Conductor, ConductorHost, HostEvent, ViewBlock } from "../../../core/conductor/contract";
import { messageKey } from "../../../core/groupShape";
import { KeelLiteConductor } from "../keel-lite/keel-lite";
import { KeelNoteConductor } from "../keel-note/keel-note";
import { DoormanConductor } from "../doorman/doorman";
import { classifyCodeRead } from "../doorman/classify";

/** Where thinning applies: nowhere, before the first task, or everywhere outside finished task spans. */
export type ThinScope = "off" | "orientation" | "open";

export interface ThinningOptions {
	scope: ThinScope;
	/** Keel-note's model-written progress note on top of the rungs. */
	note: boolean;
	/** Doorman's skeletons for large code reads before they are first sent. */
	birthSkeleton: boolean;
	high: number;
	low: number;
}

/** Reads whose text stays whole: documents and rule files. */
export const DOC_PATH_RE = /\.(md|mdx|markdown|rst|txt|adoc)$/i;

type Listener = (e: HostEvent) => void | Promise<void>;

interface CallInfo {
	tool: string;
	path?: string;
}

function callInfo(b: ViewBlock | undefined, textOf: (id: string) => string | null): CallInfo | null {
	if (!b || b.kind !== "tool_call") return null;
	const text = textOf(b.id) ?? b.text ?? "";
	const sp = text.indexOf(" ");
	try {
		const args = JSON.parse(sp < 0 ? "{}" : text.slice(sp + 1)) as Record<string, unknown>;
		return { tool: b.toolName ?? "", path: typeof args.path === "string" ? args.path : undefined };
	} catch {
		return { tool: b.toolName ?? "" };
	}
}

/**
 * Indices `[start, end]` of every finished task span, and the index of the first block after
 * orientation (the message holding the first `tasks start`); `spans` comes from Taskfold's scanner.
 */
export interface Regions {
	finished: ReadonlyArray<readonly [number, number]>;
	orientationEnd: number;
}

export class Thinning {
	private keel: Conductor | null = null;
	private keelListener: Listener | null = null;
	private doorman: DoormanConductor | null = null;
	private doormanListener: Listener | null = null;

	constructor(
		private readonly opts: ThinningOptions,
		private readonly regions: (blocks: readonly ViewBlock[]) => Regions,
	) {}

	get active(): boolean {
		return this.opts.scope !== "off";
	}

	attach(host: ConductorHost): void {
		if (!this.active) return;
		const keelOpts = { maxRung: 4, high: this.opts.high, low: this.opts.low };
		this.keel = this.opts.note ? new KeelNoteConductor({ keel: keelOpts }) : new KeelLiteConductor(keelOpts);
		this.keel.attach(this.proxy(host, (l) => (this.keelListener = l), false));
		if (this.opts.birthSkeleton) {
			this.doorman = new DoormanConductor();
			this.doorman.attach(this.proxy(host, (l) => (this.doormanListener = l), true));
		}
	}

	detach(): void {
		this.keel?.detach();
		this.doorman?.detach();
		this.keel = this.doorman = null;
		this.keelListener = this.doormanListener = null;
	}

	/** Pass a host event on: Keel after Taskfold has handled it, Doorman for wire departures. */
	forward(e: HostEvent): void | Promise<void> {
		if (e.type === "wire-departing") return this.doormanListener?.(e);
		return this.keelListener?.(e);
	}

	/** Ids the inner conductors must leave alone in `blocks`. */
	private untouchable(blocks: readonly ViewBlock[], host: ConductorHost, codeOnly: boolean): Set<string> {
		const out = new Set<string>();
		const r = this.regions(blocks);
		for (const [s, e] of r.finished) for (let i = s; i <= e; i++) out.add(blocks[i].id);
		if (this.opts.scope === "orientation") for (let i = Math.max(0, r.orientationEnd); i < blocks.length; i++) out.add(blocks[i].id);
		const calls = new Map<string, ViewBlock>();
		for (const b of blocks) if (b.kind === "tool_call" && b.callId) calls.set(b.callId, b);
		for (const b of blocks) {
			if (b.kind !== "tool_result") continue;
			const call = b.callId ? calls.get(b.callId) : undefined;
			const info = callInfo(call, (id) => host.textOf(id));
			if (info?.path && DOC_PATH_RE.test(info.path)) out.add(b.id);
			// Doorman folds non-code results it cannot skeletonize; here it may only skeletonize code.
			else if (codeOnly && !classifyCodeRead(b, calls)) out.add(b.id);
		}
		return out;
	}

	private proxy(host: ConductorHost, listen: (l: Listener | null) => void, codeOnly: boolean): ConductorHost {
		let cache: { rev: number; n: number; ids: Set<string> } | null = null;
		const masked = (): Set<string> => {
			const st = host.stats();
			const blocks = host.blocks();
			if (cache && cache.rev === st.rev && cache.n === blocks.length) return cache.ids;
			cache = { rev: st.rev, n: blocks.length, ids: this.untouchable(blocks, host, codeOnly) };
			return cache.ids;
		};
		const mask = (b: ViewBlock | undefined): ViewBlock | undefined => (b && !b.held && masked().has(b.id) ? { ...b, held: true } : b);
		return {
			on: (fn) => {
				listen(fn);
				return () => listen(null);
			},
			get: (id) => mask(host.get(id)),
			blocks: () => host.blocks().map((b) => mask(b)!),
			groups: () => host.groups(),
			textOf: (id) => host.textOf(id),
			stats: () => host.stats(),
			systemPrompt: () => host.systemPrompt(),
			countTokens: (t) => host.countTokens(t),
			digestOf: (id) => host.digestOf(id),
			complete: (req) => host.complete(req),
			// Taskfold owns the status line.
			setStatus: () => {},
			propose: (txn) => host.propose(txn),
		};
	}
}

/** The index of the first block of the message that holds the first `tasks start` call; blocks.length when none. */
export function orientationEndIndex(blocks: readonly ViewBlock[], isStart: (b: ViewBlock) => boolean): number {
	const first = blocks.findIndex(isStart);
	if (first < 0) return blocks.length;
	let i = first;
	while (i > 0 && messageKey(blocks[i - 1].id) === messageKey(blocks[first].id)) i--;
	return i;
}
