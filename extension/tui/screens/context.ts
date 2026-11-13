import { matchesKey, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Op } from "../../../core/ops";
import type { Block } from "../../../core/types";
import { bindingHint, clean, fitSegments, type Hint, rawHint } from "../chrome";
import { buildContextMap, colorKind, kindGlyph, renderCategoryBar } from "../map";
import { buildTimeline, clampCell, timelineColumns, type TimelineRow } from "../timeline";
import type { PanelTab, Shell, TabView } from "./types";
import { formatTokens } from "../../dials";

const PREVIEW_CHARS = 240;

/** The Context tab: the block map or list, and the block inspector as its drill-in. */
export function createContextTab(shell: Shell): PanelTab {
	const { host } = shell;
	let selectedId: string | undefined;
	let lastIndex = 0;
	/** `timeline` groups by turn; `grid` and `list` are the flat views. */
	let mode: "timeline" | "grid" | "list" = "timeline";
	let rowIndex = 0;
	let cellIndex = 0;
	let mapColumns = 1;
	let rangeId: string | undefined;
	let query = "";
	let inspecting = false;
	let inspectTop = 0;
	let inspectDigest = false;
	let pageRows = 1;

	const mapView = () => mode !== "list";
	const blocks = () => host.truth()?.blocks ?? [];
	const filtered = (): readonly Block[] => {
		const q = query.trim().toLowerCase();
		if (!q) return blocks();
		return blocks().filter((b) => b.kind.includes(q) || b.id.toLowerCase().includes(q) || (b.toolName ?? "").toLowerCase().includes(q) || b.text.toLowerCase().includes(q));
	};
	/** The selected block; a vanished selection falls back to the block now at its position. */
	const current = (): Block | undefined => {
		const visible = filtered();
		const found = visible.findIndex((b) => b.id === selectedId);
		if (found >= 0) lastIndex = found;
		const block = visible[Math.max(0, Math.min(lastIndex, visible.length - 1))];
		selectedId = block?.id;
		return block;
	};
	const stateOf = (b: Block): string => {
		const truth = host.truth();
		const group = truth?.groupOf(b);
		const folded = !!truth?.isFolded(b);
		const eff = truth ? truth.effTokens(b) : b.tokens;
		const saved = folded && b.tokens > 0 ? Math.max(0, Math.round(((b.tokens - eff) / b.tokens) * 100)) : 0;
		return [
			folded ? "folded" : "live",
			saved > 0 ? `−${saved}%` : "",
			b.kind === "system" ? "bolted" : truth?.isProtected(b) ? "protected" : "",
			b.override === "pinned" ? "pinned" : b.override ? `held:${b.override}` : "",
			group ? `group:${group.folded ? "folded" : "open"}` : "",
			rangeId === b.id ? "range start" : "",
		].filter(Boolean).join(" ");
	};
	const row = (b: Block, selected: boolean, width: number): string => {
		const theme = shell.theme();
		const truth = host.truth();
		const name = clean(b.toolName ?? b.id);
		const identity = `${kindGlyph(b.kind, !!truth?.isFolded(b), !!truth?.groupOf(b)?.folded)} ${b.kind} ${name}`;
		const sep = theme.fg("dim", " · ");
		return fitSegments(
			[`${selected ? theme.fg("accent", "→") : " "} ${selected ? theme.bold(identity) : identity}`, `${sep}${stateOf(b)}`, `${sep}${theme.fg("muted", `${b.tokens} tok`)}`, `${sep}${theme.fg("dim", clean(b.text.slice(0, PREVIEW_CHARS)))}`],
			width,
		);
	};
	const describe = (b: Block | undefined): string => (b ? `${b.kind} ${clean(b.toolName ?? b.id)} · ${stateOf(b)} · ${b.tokens} tok` : "No blocks yet.");
	const op = (operation: Op) => void shell.send({ kind: "ops", ops: [operation] });

	const editDigest = (kind: "edit" | "default") => {
		const truth = host.truth();
		const block = current();
		if (!truth || !block) return;
		const group = truth.groupOf(block);
		const foldedGroup = group?.folded ? group : undefined;
		if (shell.readOnly()) return shell.say("read-only: cannot edit digest");
		if (!foldedGroup && !truth.isFolded(block)) return shell.say("Select a folded block or group");
		shell.editDigest({
			kind,
			truth,
			rev: truth.rev,
			blockId: block.id,
			groupId: foldedGroup?.id,
			members: foldedGroup ? [...foldedGroup.memberIds] : undefined,
			text: foldedGroup ? (truth.isDropGroup(foldedGroup) ? "" : truth.groupSummary(foldedGroup)) : truth.digestOf(block),
		});
	};

	const inspectView = (width: number, rows: number): TabView => {
		const theme = shell.theme();
		const keys = shell.keys();
		const truth = host.truth();
		const block = blocks().find((b) => b.id === selectedId);
		const group = block && truth?.groupOf(block);
		const content = !block
			? "Block no longer available"
			: inspectDigest && group?.folded
				? `Group summary: ${truth?.groupSummary(group) || "(empty group summary)"}`
				: inspectDigest && truth?.isFolded(block)
					? truth.digestOf(block)
					: block.text;
		const lines = content.split(/\r?\n/).flatMap((part) => wrapTextWithAnsi(clean(part), Math.max(1, width - 1))).map((line) => ` ${line}`);
		inspectTop = Math.max(0, Math.min(inspectTop, lines.length - rows));
		return {
			body: lines.slice(inspectTop, inspectTop + rows),
			crumbs: ["Inspector"],
			description: `${describe(block)} · showing ${inspectDigest ? "digest" : "original"}`,
			hints: [rawHint(theme, "↑↓", "scroll", 2), rawHint(theme, "alt+v", inspectDigest ? "original" : "digest", 3), rawHint(theme, "alt+e", "edit digest", 4), bindingHint(theme, keys, "tui.select.pageDown", "pageDown", "page", 6)],
			above: inspectTop,
			below: Math.max(0, lines.length - inspectTop - rows),
		};
	};

	const hints = (block: Block | undefined): Hint[] => {
		const theme = shell.theme();
		const inGroup = !!(block && host.truth()?.groupOf(block));
		return [
			bindingHint(theme, shell.keys(), "tui.select.confirm", "enter", "inspect", 2),
			...(rangeId ? [rawHint(theme, "alt+n", "group range", 2), rawHint(theme, "alt+m", "cancel range", 3)] : []),
			rawHint(theme, "alt+f", "fold", 3),
			rawHint(theme, "alt+p", "pin", 4),
			rawHint(theme, "alt+u", "auto", 5),
			rawHint(theme, "alt+v", mode === "timeline" ? "grid" : mode === "grid" ? "list" : "timeline", 6),
			rawHint(theme, "alt+e", "edit digest", 7),
			rawHint(theme, "alt+r", "engine digest", 11),
			...(inGroup ? [rawHint(theme, "alt+g", "fold group", 8), rawHint(theme, "alt+d", "delete group", 9)] : []),
			...(rangeId ? [] : [rawHint(theme, "alt+m", "mark range", 10)]),
			rawHint(theme, "alt+o", "folding on/off", 12),
			rawHint(theme, "alt+c", "compact", 13),
		];
	};

	/** Keep the timeline's row/cell cursor on the block `selectedId` names. */
	const syncTimelineSelection = (rows: TimelineRow[]): void => {
		for (let r = 0; r < rows.length; r++) {
			const at = rows[r].cells.findIndex((c) => c.blockId === selectedId);
			if (at >= 0) {
				rowIndex = r;
				cellIndex = at;
				return;
			}
		}
		rowIndex = Math.max(0, Math.min(rowIndex, rows.length - 1));
		cellIndex = clampCell(cellIndex, rows[rowIndex]);
		selectedId = rows[rowIndex]?.cells[cellIndex]?.blockId;
	};

	/** The turn timeline: header, one line per turn, then the selected cell's detail. */
	const timelineView = (truth: NonNullable<ReturnType<typeof host.truth>>, width: number, rows: number): TabView => {
		const theme = shell.theme();
		const cols = timelineColumns(width);
		const all = buildTimeline(truth);
		syncTimelineSelection(all);
		const header = fitSegments(
			[
				[
					theme.fg("muted", "turn".padStart(cols.turn)),
					...(cols.prompt ? [theme.fg("muted", "prompt".padEnd(cols.prompt))] : []),
					theme.fg("muted", "blocks"),
					theme.fg("muted", "live".padStart(cols.live)),
					...(cols.full ? [theme.fg("muted", "full".padStart(cols.full))] : []),
				].join(" "),
			],
			width,
		);
		const detailRows = 2;
		const listRows = Math.max(1, rows - detailRows - 1);
		const top = Math.max(0, Math.min(rowIndex - Math.floor(listRows / 2), all.length - listRows));
		const visible = all.slice(top, top + listRows);
		const body = [header];
		for (let i = 0; i < visible.length; i++) {
			const row = visible[i]!;
			const selected = top + i === rowIndex;
			const mark = selected ? "›" : " ";
			const turn = row.system ? "⛨" : String(row.turn);
			const strip = timelineStrip(row, cols.blocks, selected ? cellIndex : -1, theme);
			const segments = [
				theme.fg(selected ? "accent" : "dim", `${mark}${turn.padStart(cols.turn - 1)}`),
				...(cols.prompt ? [fitSegments([clean(row.label)], cols.prompt)] : []),
				strip,
				theme.fg("muted", formatTokens(row.live).padStart(cols.live)),
				...(cols.full ? [theme.fg("dim", formatTokens(row.full).padStart(cols.full))] : []),
			];
			body.push(fitSegments([segments.filter(Boolean).join(" ")], width));
		}
		const current = all[rowIndex]?.cells[cellIndex];
		const block = current ? truth.get(current.blockId) : undefined;
		body.push(theme.fg("dim", "─".repeat(Math.max(1, width))));
		body.push(fitSegments([` ${current && block ? describe(block) : "No block selected"}`], width));
		body.push(fitSegments([` ${block ? clean((block.subst ?? block.text).split("\n").find((l) => l.trim()) ?? "") : ""}`], width));
		return {
			body,
			crumbs: [],
			description: "One row per turn: U user · A answer · H thinking · ▣ folded group · ! system · ┃ protected tail",
			hints: hints(block),
			above: top,
			below: Math.max(0, all.length - top - listRows),
		};
	};

	/** A row's cell strip, windowed around the selected cell when it does not fit. */
	const timelineStrip = (row: TimelineRow, width: number, selectedCell: number, theme: ReturnType<Shell["theme"]>): string => {
		const glyphs = row.cells.map((cell, i) => {
			const group = cell.groupId ? host.truth()?.groups.find((g) => g.id === cell.groupId) : undefined;
			const painted = cell.glyph === "▣" ? theme.fg("accent", "▣") : colorKind(cell.kind, cell.glyph, cell.folded, !!group?.folded);
			return `${cell.boundary ? theme.fg("warning", "┃") : ""}${i === selectedCell ? (theme.inverse?.(painted) ?? painted) : painted}`;
		});
		const joined = glyphs.join("");
		const plain = row.cells.length;
		if (plain <= width) return fitSegments([joined], width);
		const start = Math.max(0, Math.min(selectedCell - Math.floor(width / 2), plain - width));
		return `${theme.fg("dim", start > 0 ? "‹" : "")}${fitSegments([glyphs.slice(start, start + width).join("")], width)}${theme.fg("dim", start + width < plain ? "›" : "")}`;
	};

	return {
		id: "context",
		title: "Context",
		view(width, rows) {
			pageRows = Math.max(1, rows - 1);
			if (inspecting) return inspectView(width, rows);
			const theme = shell.theme();
			const truth = host.truth();
			const block = current();
			const visible = filtered();
			if (mode === "timeline" && truth && rows >= 3 && !query) return timelineView(truth, width, rows);
			if (mode === "grid" && truth && rows >= 3 && !query) {
				const bar = rows >= 5 ? renderCategoryBar(truth, width, (text) => theme.fg("dim", text)) : [];
				const map = buildContextMap(truth, selectedId, width, Math.max(1, rows - bar.length - 1), { colored: true });
				mapColumns = map.columns;
				return { body: [...bar, block ? row(block, true, width) : "  No blocks yet", ...map.lines], crumbs: [], description: "S system · U user · A answer · H thinking · C call · R result · lowercase folded · ! bolted · * pin · P tail · G group", hints: hints(block), above: 0, below: 0 };
			}
			mapColumns = 1;
			const at = Math.max(0, visible.findIndex((b) => b.id === selectedId));
			const top = Math.max(0, Math.min(at - Math.floor(rows / 2), visible.length - rows));
			const body = visible.slice(top, top + rows).map((b) => row(b, b.id === selectedId, width));
			return {
				body: body.length ? body : [theme.fg("dim", query ? "  No block matches the filter; ctrl+u clears it." : "  No blocks yet: the session has not sent a request.")],
				crumbs: [],
				description: query ? `${visible.length} of ${blocks().length} blocks match · ${describe(block)}` : describe(block),
				hints: hints(block),
				above: top,
				below: Math.max(0, visible.length - top - rows),
			};
		},
		key(data) {
			const keys = shell.keys();
			const up = keys.matches(data, "tui.select.up");
			const down = keys.matches(data, "tui.select.down");
			const pageUp = keys.matches(data, "tui.select.pageUp");
			const pageDown = keys.matches(data, "tui.select.pageDown");
			if (inspecting) {
				if (up) inspectTop = Math.max(0, inspectTop - 1);
				else if (down) inspectTop++;
				else if (pageUp) inspectTop = Math.max(0, inspectTop - pageRows);
				else if (pageDown) inspectTop += pageRows;
				else if (matchesKey(data, "alt+v")) {
					inspectDigest = !inspectDigest;
					inspectTop = 0;
				} else if (matchesKey(data, "alt+e")) editDigest("edit");
				else return false;
				return true;
			}
			const truth = host.truth();
			const block = current();
			const leftKey = matchesKey(data, "left");
			const rightKey = matchesKey(data, "right");
			if (mode === "timeline" && truth && !query) {
				const all = buildTimeline(truth);
				syncTimelineSelection(all);
				if (up || down || leftKey || rightKey || pageUp || pageDown) {
					if (up) rowIndex = Math.max(0, rowIndex - 1);
					else if (down) rowIndex = Math.min(all.length - 1, rowIndex + 1);
					else if (pageUp) rowIndex = Math.max(0, rowIndex - Math.max(1, pageRows - 3));
					else if (pageDown) rowIndex = Math.min(all.length - 1, rowIndex + Math.max(1, pageRows - 3));
					else if (leftKey) cellIndex = clampCell(cellIndex - 1, all[rowIndex]);
					else cellIndex = clampCell(cellIndex + 1, all[rowIndex]);
					cellIndex = clampCell(cellIndex, all[rowIndex]);
					selectedId = all[rowIndex]?.cells[cellIndex]?.blockId;
					return true;
				}
				if (matchesKey(data, "home")) { rowIndex = 0; cellIndex = 0; selectedId = all[0]?.cells[0]?.blockId; return true; }
				if (matchesKey(data, "end")) { rowIndex = all.length - 1; cellIndex = 0; selectedId = all[rowIndex]?.cells[0]?.blockId; return true; }
				if (matchesKey(data, "alt+v")) { mode = "grid"; return true; }
				if (keys.matches(data, "tui.select.confirm")) {
					if (!block) return true;
					inspecting = true;
					inspectTop = 0;
					inspectDigest = false;
					return true;
				}
			}
			const grid = mode === "grid" && !query;
			const left = grid && leftKey;
			const right = grid && rightKey;
			if (up || down || left || right || pageUp || pageDown) {
				const visible = filtered();
				const at = Math.max(0, visible.findIndex((b) => b.id === selectedId));
				const page = pageRows * (grid ? mapColumns : 1);
				const step = up ? -(grid ? mapColumns : 1) : down ? (grid ? mapColumns : 1) : left ? -1 : right ? 1 : pageUp ? -page : page;
				selectedId = visible[Math.max(0, Math.min(visible.length - 1, at + step))]?.id;
				return true;
			}
			if (keys.matches(data, "tui.select.confirm")) {
				if (!block) return true;
				inspecting = true;
				inspectTop = 0;
				inspectDigest = false;
			} else if (matchesKey(data, "alt+v")) mode = mode === "timeline" ? "grid" : mode === "grid" ? "list" : "timeline";
			else if (matchesKey(data, "alt+o")) void shell.send({ kind: "setFolding", value: !host.folding() });
			else if (matchesKey(data, "alt+c")) {
				const compact = host.compact?.bind(host);
				if (!compact) shell.say("Compaction is not available on this host");
				else {
					const preview = host.compactPreview?.() ?? null;
					const saved = (n: number | null, unknown: string) => (n === null ? unknown : n > 0 ? `−${formatTokens(n)}` : "nothing");
					shell.confirm({
						crumb: "Compact",
						title: [
							"Compact the context now?",
							`pass         Taskfold decides              ${saved(preview?.pass ?? null, "conductor decides")}`,
							`aggressive   fold every eligible block     ${saved(preview?.aggressive ?? null, "unknown")}`,
							`bake         permanent summary, no recall  ${saved(preview?.bake ?? null, "unknown")}`,
							`native       pi summarizes (model call)    unknown`,
						].join("\n"),
						options: ["pass", "aggressive", "bake", "native"],
						then: (choice) => {
							const strategy = choice === null ? undefined : (["pass", "aggressive", "bake", "native"] as const)[choice];
							if (!strategy) return;
							void shell.run(`Compacting (${strategy})…`, async () => (await compact(strategy)).message);
						},
					});
				}
			} else if (matchesKey(data, "alt+e")) editDigest("edit");
			else if (matchesKey(data, "alt+r")) editDigest("default");
			else if (!block || !truth) return false;
			else if (matchesKey(data, "alt+f")) op({ kind: truth.isFolded(block) ? "unfold" : "fold", ids: [block.id] });
			else if (matchesKey(data, "alt+p")) op({ kind: block.override === "pinned" ? "unpin" : "pin", ids: [block.id] });
			else if (matchesKey(data, "alt+u")) op({ kind: "auto", ids: [block.id] });
			else if (matchesKey(data, "alt+m")) rangeId = rangeId ? undefined : block.id;
			else if (matchesKey(data, "alt+n")) {
				if (!rangeId) shell.say("Mark the range start first (alt+m)");
				else {
					const all = truth.blocks;
					const from = all.findIndex((b) => b.id === rangeId);
					const to = all.findIndex((b) => b.id === block.id);
					if (from < 0) shell.say("Range start no longer exists");
					else op({ kind: "group", ids: all.slice(Math.min(from, to), Math.max(from, to) + 1).map((b) => b.id) });
					rangeId = undefined;
				}
			} else if (matchesKey(data, "alt+g") || matchesKey(data, "alt+d")) {
				const group = truth.groupOf(block);
				if (!group) shell.say("The selected block is not in a group");
				else if (matchesKey(data, "alt+g")) op({ kind: group.folded ? "unfoldGroup" : "foldGroup", groupId: group.id });
				else
					shell.confirm({
						crumb: "Delete group",
						title: `Delete this group of ${group.memberIds.length} blocks?\nIts blocks return to their own fold state; a summary you wrote for the group is lost.`,
						options: ["Keep group", "Delete group"],
						then: (choice) => {
							if (choice === 1) op({ kind: "ungroup", groupId: group.id });
						},
					});
			} else return false;
			return true;
		},
		typing: () => false,
		query: () => (inspecting ? null : query),
		setFilter(next) {
			query = next;
			const visible = filtered();
			if (next && !visible.some((b) => b.id === selectedId)) selectedId = visible[0]?.id;
		},
		back() {
			if (!inspecting) return false;
			inspecting = false;
			return true;
		},
		dirty: () => 0,
		discard() {},
		legend: () => [
			"Map cells: S system, U user, A answer, H thinking, C call, R result; lowercase is folded.",
			"The digit is the token weight (1 ≤100, 2 ≤500, 3 ≤1.5k, 4 ≤5k, 5 ≤15k, 6 above).",
			"Flags: ! bolted, * pinned, P protected tail, G grouped. [ ] marks the selected cell.",
			"Typing filters the block list by kind, id, tool name and text (substring match).",
			"A range runs from the marked block to the selected one; alt+n groups it.",
			"A digest you write cannot be unfolded by the agent; alt+r restores the engine's digest.",
		],
	};
}
