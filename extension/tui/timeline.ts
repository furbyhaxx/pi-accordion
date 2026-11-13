/*
 * timeline.ts — the Context tab's turn timeline (SPEC-0001 §5.4), pure over a `Truth`.
 *
 * One row per turn, one cell per block, so a session reads as prompt → answer → folded group per
 * turn instead of a flat grid. Rendering lives in the screen; everything decidable is here.
 */
import type { Block, BlockKind } from "../../core/types";
import type { Truth } from "../../core/truth";
import { taskKeyOfSummary } from "../../conductors/in-process/taskfold/records";

/** One block in a row's cell strip. */
export interface TimelineCell {
	blockId: string;
	glyph: string;
	kind: BlockKind;
	folded: boolean;
	groupId?: string;
	/** The protected-tail boundary sits before this cell. */
	boundary?: boolean;
}

/** One turn of the session. */
export interface TimelineRow {
	turn: number;
	label: string;
	cells: TimelineCell[];
	live: number;
	full: number;
	protected: boolean;
	system: boolean;
	folded: boolean;
}

const KIND_LETTER: Partial<Record<BlockKind, string>> = { user: "U", thinking: "H", text: "A" };

/** Weight glyph from calibrated full tokens: `▪` < 500, `■` < 5 000, `█` otherwise. */
export function weightGlyph(tokens: number): string {
	return tokens < 500 ? "▪" : tokens < 5_000 ? "■" : "█";
}

/** The letter (or glyph) a cell shows for a block. */
export function cellGlyph(truth: Truth, b: Block): string {
	const group = truth.groupOf(b);
	if (group?.folded) return "▣";
	const letter = KIND_LETTER[b.kind];
	if (letter) return letter;
	if (b.kind === "tool_call" || b.kind === "tool_result") return "▪";
	return "▪";
}

/** The first line of a turn's prompt, cleaned and cut to `max` characters. */
function promptLabel(truth: Truth, blocks: readonly Block[], max = 32): string {
	const first = blocks.find((b) => b.kind === "user") ?? blocks[0];
	const text = (first?.subst ?? first?.text ?? "").split("\n").find((line) => line.trim()) ?? "";
	const clean = text.replace(/\s+/g, " ").trim();
	return clean.length > max ? `${clean.slice(0, Math.max(1, max - 1))}…` : clean;
}

/** A row's label: the prompt, a folded task's key and title, or the protected tail. */
function rowLabel(truth: Truth, blocks: readonly Block[], lastTurn: number, maxPrompt: number): string {
	const groups = new Set(blocks.map((b) => truth.groupOf(b)?.id).filter((id): id is string => !!id));
	if (groups.size === 1 && blocks.every((b) => truth.groupOf(b)?.folded)) {
		const group = truth.groupOf(blocks[0]!)!;
		const key = taskKeyOfSummary(group.digest);
		if (key) return `▣ task ${key}`;
		return `▣ folded group`;
	}
	const turn = blocks[0]?.turn ?? 0;
	if (turn === lastTurn && blocks.every((b) => truth.isProtected(b) || b.kind === "system")) return "tail (protected)";
	return promptLabel(truth, blocks, maxPrompt);
}

/** Build the timeline: one row per turn, cells in wire order. */
export function buildTimeline(truth: Truth, opts: { promptWidth?: number } = {}): TimelineRow[] {
	const maxPrompt = opts.promptWidth ?? 32;
	const blocks = truth.blocks;
	const lastTurn = blocks.length ? blocks[blocks.length - 1].turn : 0;
	const rows: TimelineRow[] = [];
	// The `┃` boundary is drawn once: on the first protected block after any unprotected one.
	let sawUnprotected = false;
	for (const b of blocks) {
		const protectedBlock = truth.isProtected(b);
		let row = rows[rows.length - 1];
		if (!row || row.turn !== b.turn) {
			row = {
				turn: b.turn,
				label: "",
				cells: [],
				live: 0,
				full: 0,
				protected: protectedBlock,
				system: b.kind === "system",
				folded: truth.isFolded(b),
			};
			rows.push(row);
		}
		const group = truth.groupOf(b);
		const cell: TimelineCell = {
			blockId: b.id,
			glyph: cellGlyph(truth, b),
			kind: b.kind,
			folded: truth.isFolded(b),
			...(group ? { groupId: group.id } : {}),
		};
		if (protectedBlock && sawUnprotected) { cell.boundary = true; sawUnprotected = false; }
		if (!protectedBlock) sawUnprotected = true;
		row.cells.push(cell);
		row.live += truth.calBlockTokens(b, truth.effTokens(b));
		row.full += truth.calBlockTokens(b, b.tokens);
		row.protected = row.protected && protectedBlock;
		row.folded = row.folded && truth.isFolded(b);
	}
	return rows.map((row) => ({ ...row, label: rowLabel(truth, blocks.filter((b) => b.turn === row.turn), lastTurn, maxPrompt) }));
}

/** Column widths for a width, per §5.4: `full` drops below 80 columns, prompt shrinks below 57. */
export function timelineColumns(width: number): { turn: number; prompt: number; live: number; full: number; blocks: number } {
	const turn = 4;
	const live = 7;
	const full = width >= 80 ? 7 : 0;
	const prompt = width >= 80 ? Math.min(32, Math.max(12, Math.round(width * 0.3))) : width >= 57 ? 12 : 0;
	const blocks = Math.max(8, width - turn - prompt - live - full - (prompt ? 1 : 0));
	return { turn, prompt, live, full, blocks };
}

/** The cell index the arrow keys land on after a move within a row's strip. */
export function clampCell(index: number, row: TimelineRow | undefined): number {
	if (!row || !row.cells.length) return 0;
	return Math.max(0, Math.min(row.cells.length - 1, index));
}
