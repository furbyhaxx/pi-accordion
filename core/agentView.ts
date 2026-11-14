/*
 * agentView.ts — the live agent's `unfold` / `recall` resolution, run LOCALLY against the
 * authoritative Truth (Phase B). Previously this lived app-side (live/plan.ts, resolving against
 * the store over a WS round trip); it now resolves in-process in the extension so unfold/recall
 * work with zero clients connected. Framework-free, pure over a `Truth`.
 *
 *   unfold — MUTATES: holds each matched folded block open (sticky, provenance "agent"); the
 *            content returns to the model on its next context hook. The agent can only unfold what
 *            is actually folded — never downgrade a human pin.
 *   recall — READ-ONLY: returns a folded block's ORIGINAL full content (never the digest); never
 *            touches fold state. The safe-by-construction read that keeps a locked unfold from
 *            blinding the agent.
 */
import type { Block, Group } from "./types";
import type { Truth } from "./truth";
import { foldCode, wireFoldable, hasOwnFoldTag } from "./digest";
import { isDurableId } from "./wire";

/** One block/group restored by `resolveUnfold`. */
export interface UnfoldRestored {
	code: string;
	kind: Block["kind"];
	label: string;
	/** The block ids this restore actually touched (≥1; >1 on a hash collision or a group unfold). */
	ids: string[];
}

/** One block/group's original content returned by `resolveRecall`. */
export interface RecallContent {
	code: string;
	label: string;
	/** The block's ORIGINAL full text (NOT the folded digest) — for a group, its members joined. */
	text: string;
	ids: string[];
}

/** Short, human-readable label for a confirmation (e.g. "tool_result read_file · turn 12"). */
export function blockLabel(b: Block): string {
	const where = b.turn > 0 ? `turn ${b.turn}` : "preamble";
	const kind = b.kind === "custom" ? "extension message" : b.kind;
	return b.toolName ? `${kind} ${b.toolName} · ${where}` : `${kind} · ${where}`;
}

/**
 * Is this folded BLOCK reachable by an agent handle at all?
 *
 * The wire text the model receives is the only place a `{#code FOLDED}` tag ever appears, so a
 * digest not carrying THIS BLOCK'S OWN tag is one the agent was never handed a working code for — a human-authored digest, or a
 * conductor's non-recoverable `replace`. Without this guard a `foldCode` hash collision with some
 * OTHER block's visible tag would restore (or read out) content the human deliberately replaced
 * with their own words. `foldCode` is a 6-char base36 hash, so collisions are rare but real, and
 * `resolveUnfold` restores EVERY match for a code by design — exactly the path a collision rides.
 *
 * Mirrors the rest of the match set (`isFolded` / `wireFoldable` / `isDurableId`) so unfold, recall,
 * and the wire serialization all agree on which blocks carry a handle.
 */
function agentReachable(truth: Truth, b: Block): boolean {
	return hasOwnFoldTag(truth.digestOf(b), b.id);
}

/**
 * Is this folded GROUP reachable by an agent handle?
 *
 * The same tag-presence rule as `agentReachable`, over the summary the group actually emits — a
 * VERBATIM summary is reachable exactly when whoever wrote it included a tag. A conductor
 * routinely does (see `plan.groups` — a custom summary carrying `{#code FOLDED}` is a supported,
 * tested shape); a human typing into the digest editor does not, which is what makes their words
 * invisible to `unfold`/`recall`.
 *
 * The one carve-out is a DROP group whose collapse is RIGHT NOW manifesting as a role-floor-forced
 * `roleFloorRecap` stub on the wire (`Truth.isDegradedDropGroup`) — the role-validity floor can
 * degrade a drop run to a stub that deliberately carries `foldTag(g.id)`, precisely so an agent
 * `unfold`/`recall` of that stub resolves back to this group. A drop group is NOT unconditionally
 * reachable just because it IS a drop: `groupSummary` is `""` for every drop, degraded or not, so
 * without checking the degrade condition a plain human drop — which puts nothing at all on the
 * wire — would be just as reachable as a genuine role-floor stub, handing the agent a working
 * `recall`/`unfold` handle to content the human deliberately removed. That would make the
 * strongest human curation action (drop) MORE reachable than a weaker one (a custom summary,
 * which correctly stays unreachable via `hasOwnFoldTag`) — the exact inversion this predicate
 * exists to prevent.
 */
function groupAgentReachable(truth: Truth, g: Group): boolean {
	return truth.isDegradedDropGroup(g) || hasOwnFoldTag(truth.groupSummary(g), g.id);
}

/**
 * Resolve an agent `unfold` request against the Truth. For each code (read from a `{#<code> FOLDED}`
 * tag) restore EVERY folded block/group carrying it, and record it; a code matching nothing folded
 * is reported in `missing`. A group is unfolded whole (its members reflow next context). Every
 * restore is VERIFIED to have taken effect — the engine can refuse (agent-unfold lock, already
 * open) — so a refused code falls through to `missing`, never a false "restored".
 */
export function resolveUnfold(truth: Truth, codes: string[]): { restored: UnfoldRestored[]; missing: string[] } {
	const restored: UnfoldRestored[] = [];
	const missing: string[] = [];
	for (const code of codes) {
		let hit = false;
		const handles = truth.groups.flatMap((g) => (g.handles ?? []).filter((h) => foldCode(h.id) === code && truth.canRecallHandle(g, h)).map((h) => ({ group: g, handle: h })));
		for (const { group, handle } of handles) {
			const groups = new Map<string, Group>([[group.id, group]]);
			for (const id of handle.memberIds) {
				const block = truth.get(id);
				const owner = block ? truth.groupOf(block) : undefined;
				if (owner?.folded) groups.set(owner.id, owner);
			}
			truth.apply([...groups.values()].map((g) => ({ kind: "unfoldGroup" as const, groupId: g.id, handleId: handle.id })), "agent");
			if ([...groups.keys()].some((id) => truth.groupById(id)?.folded)) continue;
			const ids = [...new Set([...groups.values()].flatMap((g) => g.memberIds))];
			restored.push({ code, kind: "text", label: `task ${handle.id}`, ids });
			hit = true;
		}
		// A GROUP code restores the WHOLE range. Checked first; a code can in principle match both a
		// group and a block (rare collision) → restore both.
		for (const g of truth.groups) {
			if (g.folded && groupAgentReachable(truth, g) && foldCode(g.id) === code) {
				truth.apply([{ kind: "unfoldGroup", groupId: g.id }], "agent");
				if (!truth.groupById(g.id)?.folded) {
					restored.push({ code, kind: "text", label: `group · ${g.memberIds.length} blocks`, ids: g.memberIds.slice() });
					hit = true;
				}
			}
		}
		// Mirror EXACTLY the set the wire serialization folds: folded, a foldable kind, a durable id.
		const matches = truth.blocks.filter(
			(b) => truth.isFolded(b) && wireFoldable(b) && isDurableId(b.id) && agentReachable(truth, b) && foldCode(b.id) === code,
		);
		for (const b of matches) {
			const grp = truth.groupOf(b);
			const grpFolded = grp?.folded ?? false;
			if (grpFolded) truth.apply([{ kind: "unfoldGroup", groupId: grp!.id }], "agent");
			else truth.apply([{ kind: "unfold", ids: [b.id] }], "agent");
			const stillFolded = grpFolded ? (truth.groupById(grp!.id)?.folded ?? false) : truth.isFolded(b);
			if (stillFolded) continue;
			restored.push({ code, kind: b.kind, label: blockLabel(b), ids: grpFolded ? grp!.memberIds.slice() : [b.id] });
			hit = true;
		}
		if (!hit) missing.push(code);
	}
	return { restored, missing };
}

/** A code `resolveUnfoldBounded` left folded, and the tokens unfolding it would have added. */
export interface UnfoldRefused {
	code: string;
	tokens: number;
	reason: "size" | "budget";
}

/**
 * `resolveUnfold` for the agent's tool (SPEC-0003 §6): a code is unfolded only when it adds at most
 * `maxTokens` and leaves the projection below `ceiling`. A refused code changes nothing. Codes are
 * decided in order, each against the projection the earlier ones left.
 */
export function resolveUnfoldBounded(truth: Truth, codes: string[], limits: { maxTokens: number; ceiling: number }): { restored: UnfoldRestored[]; missing: string[]; refused: UnfoldRefused[] } {
	const restored: UnfoldRestored[] = [];
	const missing: string[] = [];
	const refused: UnfoldRefused[] = [];
	for (const code of codes) {
		const ids = new Set(resolveRecall(truth, [code]).restored.flatMap((r) => r.ids));
		let tokens = 0;
		for (const id of ids) {
			const b = truth.get(id);
			if (b) tokens += Math.max(0, b.tokens - truth.effTokens(b));
		}
		if (ids.size && tokens > limits.maxTokens) refused.push({ code, tokens, reason: "size" });
		else if (ids.size && truth.liveTokens() + tokens >= limits.ceiling) refused.push({ code, tokens, reason: "budget" });
		else {
			const r = resolveUnfold(truth, [code]);
			restored.push(...r.restored);
			missing.push(...r.missing);
		}
	}
	return { restored, missing, refused };
}

/**
 * Resolve an agent `recall` request against the Truth — a pure READ. Returns each matched folded
 * block's ORIGINAL full content (never the digest, never a mutation). Same match set as
 * `resolveUnfold` / the wire fold; a group returns its members' full text joined.
 */
type RecallMetadata = Omit<RecallContent, "text">;
const recallIndexes = new WeakMap<Truth, { rev: number; codes: Map<string, RecallMetadata[]> }>();

/** Fold metadata indexed once per Truth revision, without materializing transcript text. */
export function recallIndex(truth: Truth): Map<string, RecallMetadata[]> {
	const cached = recallIndexes.get(truth);
	if (cached?.rev === truth.rev) return cached.codes;
	const codes = new Map<string, RecallMetadata[]>();
	const add = (id: string, label: string, ids: string[]) => {
		const code = foldCode(id);
		const item = { code, label, ids };
		const entries = codes.get(code);
		if (entries) entries.push(item);
		else codes.set(code, [item]);
	};
	for (const g of truth.groups) {
		for (const h of g.handles ?? []) {
			if (truth.canRecallHandle(g, h)) add(h.id, `task ${h.id}`, h.memberIds);
		}
		if (g.folded && groupAgentReachable(truth, g)) add(g.id, `group · ${g.memberIds.length} blocks`, g.memberIds);
	}
	for (const b of truth.blocks) {
		if (truth.isFolded(b) && wireFoldable(b) && isDurableId(b.id) && agentReachable(truth, b) && !truth.groupOf(b)?.folded) {
			add(b.id, blockLabel(b), [b.id]);
		}
	}
	recallIndexes.set(truth, { rev: truth.rev, codes });
	return codes;
}

export function resolveRecall(truth: Truth, codes: string[]): { restored: RecallContent[]; missing: string[] } {
	const index = recallIndex(truth);
	const restored: RecallContent[] = [];
	const missing: string[] = [];
	for (const code of codes) {
		const entries = index.get(code);
		if (!entries) {
			missing.push(code);
			continue;
		}
		for (const entry of entries) {
			const text = entry.ids.map((id) => truth.get(id)?.text ?? "").filter((t) => t.length > 0).join("\n\n");
			restored.push({ ...entry, ids: entry.ids.slice(), text });
		}
	}
	return { restored, missing };
}
