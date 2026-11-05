import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { decodeKittyPrintable, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { WireCommand } from "../../core/protocol";
import type { Op, OpResult } from "../../core/ops";
import { EMPTY_DIGEST, stripFoldTags } from "../../core/digest";
import type { CompactMode } from "../settings";
import type { AccordionTuiHost } from "./host";
import { buildContextMap, formatCompactTokens, kindGlyph, renderCategoryBar } from "./map";
import { statusLevel } from "./status";
import { describeSource, formatTokens, parseTokens } from "../dials";

const clean = (text: string): string => text.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ");

type Screen = "blocks" | "inspect" | "help" | "conductors" | "consent" | "settings" | "budget" | "protect" | "doorPort" | "bindHost" | "customToken";
type DigestAction = {
	kind: "edit" | "default";
	truth: NonNullable<ReturnType<AccordionTuiHost["truth"]>>;
	rev: number;
	blockId: string;
	groupId?: string;
	members?: string[];
	text: string;
};

const DEFAULT_CONDUCTOR_CYCLE = ["keel-lite", "keel-note", "doorman", "thermocline", "triptych", "compaction-naive", "handoff", "none"] as const;
const COMPACT_MODE_CYCLE: readonly CompactMode[] = ["accordion", "suppress", "native"];

function commandMessage(result: { results: OpResult[]; refused?: "read-only" }): string {
	if (result.refused === "read-only") return "read-only: close and reopen /accordion to request control again";
	const failures = result.results.flatMap((item) =>
		item.perId?.some((entry) => entry.reason)
			? item.perId.filter((entry) => entry.reason).map((entry) => `${entry.id}: ${entry.reason}`)
			: item.clamped
				? [item.clamped]
				: [],
	);
	return failures.length ? `Refused: ${failures.join(", ")}` : "Command sent";
}

function renderRule(width: number, leftText: string, rightText = ""): string {
	const w = Math.max(0, Math.floor(width));
	if (w <= 0) return "";
	const left = leftText ? `── ${clean(leftText)} ` : "──";
	const right = rightText ? ` ${clean(rightText)} ──` : "──";
	const fill = Math.max(1, w - visibleWidth(left) - visibleWidth(right));
	return truncateToWidth(`${left}${"─".repeat(fill)}${right}`, w);
}

/** Open the current session's interactive context panel in Pi's TUI. */
export async function openAccordionPanel(ctx: ExtensionContext, host: AccordionTuiHost): Promise<void> {
	if (ctx.mode !== "tui" || !ctx.hasUI) return;
	let selectedId: string | undefined;
	let index = 0;
	let screen: Screen = "blocks";
	let conductorIndex = 0;
	let settingsIndex = 0;
	let consentId: string | null = null;
	let consentLocks: string[] = [];
	let rangeId: string | undefined;
	let inspectOffset = 0;
	let inspectDigest = false;
	let numberInput = "";
	// Where Esc/Enter return from the budget or tail input.
	let dialReturn: Screen = "blocks";
	let textInput = "";
	let searchQuery = "";
	let searching = false;
	let message = "";
	let readOnly = host.canSteer ? !host.canSteer() : false;
	let mapMode = true;
	let mapColumns = 1;
	const digestDrafts = new Map<string, string>();

	while (true) {
		const action = await ctx.ui.custom<DigestAction | undefined>((tui, theme, keys, done) => {
			let pending = false;
			let disposed = false;
			const update = () => {
				if (disposed) return;
				if (host.canSteer && !host.canSteer()) readOnly = true;
				tui.requestRender();
			};
			const unsubscribe = host.subscribe(update);
			const conductorChoices = () => host.conductors().filter((entry) => entry.id !== "none");
			const filteredBlocks = () => {
				const all = host.truth()?.blocks ?? [];
				const q = searchQuery.trim().toLowerCase();
				if (!q) return all;
				return all.filter(
					(b) =>
						b.kind.toLowerCase().includes(q) ||
						b.id.toLowerCase().includes(q) ||
						(b.toolName ?? "").toLowerCase().includes(q) ||
						b.text.toLowerCase().includes(q),
				);
			};
			const current = () => {
				const blocks = host.truth()?.blocks ?? [];
				const existing = blocks.findIndex((block) => block.id === selectedId);
				if (existing >= 0) index = existing;
				index = Math.max(0, Math.min(index, blocks.length - 1));
				const block = blocks[index];
				selectedId = block?.id;
				return block;
			};
			const send = async (command: WireCommand): Promise<void> => {
				if (pending) {
					message = "Command pending";
					update();
					return;
				}
				pending = true;
				message = "Command pending";
				update();
				try {
					const result = await host.command(command);
					if (disposed) return;
					if (result.refused === "read-only") readOnly = true;
					message = commandMessage(result);
				} catch (error) {
					if (!disposed) message = `Command failed: ${error instanceof Error ? error.message : String(error)}`;
				} finally {
					pending = false;
					update();
				}
			};
			const runCompact = async (): Promise<void> => {
				if (!host.compactNow) {
					message = "Compaction is not available on this host";
					update();
					return;
				}
				if (pending) {
					message = "Command pending";
					update();
					return;
				}
				pending = true;
				message = "Compacting context…";
				update();
				try {
					const res = await host.compactNow();
					if (!disposed) message = res.message;
				} catch (error) {
					if (!disposed) message = `Compaction failed: ${error instanceof Error ? error.message : String(error)}`;
				} finally {
					pending = false;
					update();
				}
			};
			const op = (operation: Op) => {
				void send({ kind: "ops", ops: [operation] });
			};
			const line = (s: string, width: number) => truncateToWidth(clean(s), Math.max(0, width));
			const dialSource = (kind: "budget" | "protect") => {
				const d = host.dials?.();
				return d ? describeSource(d.sources[kind]) : "this session";
			};
			const ansiLine = (s: string, width: number) => truncateToWidth(s, Math.max(0, width));

			return {
				render(width: number): string[] {
					const truth = host.truth();
					const block = current();
					const bodyRows = Math.max(2, Math.min(14, tui.terminal.rows - 9));
					const stats = truth?.stats();
					const tabLabel =
						screen === "conductors" || screen === "consent"
							? "Conductors"
							: screen === "settings" || screen === "budget" || screen === "protect" || screen === "doorPort" || screen === "bindHost" || screen === "customToken"
								? "Settings"
								: screen === "inspect"
									? "Inspector"
									: screen === "help"
										? "Help"
										: mapMode
											? "Context"
											: "Blocks";
					const tabsCompact = `[1 ${mapMode && screen === "blocks" ? "●" : ""}Context] [2 ${!mapMode && screen === "blocks" ? "●" : ""}Blocks] [3 ${screen === "conductors" ? "●" : ""}Conductors] [4 ${screen === "settings" ? "●" : ""}Settings]`;
					const headerLeft = readOnly
						? `READ-ONLY · folding ${host.folding() ? "on" : "off"} · ${host.sessionLabel?.() ?? "Accordion"}`
						: `Accordion › ${tabLabel} · folding ${host.folding() ? "on" : "off"} · ${host.sessionLabel?.() ?? "session"} · conductor ${host.activeConductor()?.label ?? "none"}`;
					const headerRight = stats ? `${formatCompactTokens(stats.liveTokens)}/${formatCompactTokens(stats.budget)} tok` : "";
					const topRule = renderRule(width, headerLeft, width >= 90 ? `${tabsCompact} · ${headerRight}` : headerRight);
					const conductorStatus = host.conductorStatus?.() ?? null;
					const level = statusLevel(conductorStatus?.metrics);
					const alertMark = level === "info" ? "" : level === "error" ? "✗ " : "⚠ ";
					const summary = stats
						? `Tokens ${stats.liveTokens}/${stats.fullTokens} · budget ${stats.budget} · tail ${stats.protectTokens}${stats.contextWindow === null ? "" : ` · window ${stats.contextWindow}`}${conductorStatus?.text ? ` · ${alertMark}${conductorStatus.text}` : ""}`
						: "No session context yet";

					let body: string[] = [];
					let bottomCenter = "";
					let hint = "↑↓ select · enter inspect · f fold · p pin · a auto · o folding · C compact · c conductor · s settings · esc close";

					if (screen === "blocks") {
						const blocks = filteredBlocks();
						const allBlocks = truth?.blocks ?? [];
						const start = Math.max(0, Math.min(index - Math.floor(bodyRows / 2), allBlocks.length - bodyRows));
						const formatRow = (b: (typeof allBlocks)[number], isSelected: boolean) => {
							const group = truth?.groupOf(b);
							const folded = !!truth?.isFolded(b);
							const state = folded ? "folded" : "live";
							const eff = truth ? truth.effTokens(b) : b.tokens;
							const savedPct = folded && b.tokens > 0 ? Math.max(0, Math.round(((b.tokens - eff) / b.tokens) * 100)) : 0;
							const flags = [
								state,
								savedPct > 0 ? `−${savedPct}%` : "",
								b.kind === "system" ? "bolted" : truth?.isProtected(b) ? "protected" : "",
								b.override === "pinned" ? "pinned" : b.override ? `held:${b.override}` : "",
								group ? `group:${group.folded ? "folded" : "open"}` : "",
								rangeId === b.id ? "range-start" : "",
							]
								.filter(Boolean)
								.join(" ");
							const glyph = kindGlyph(b.kind, folded, !!group?.folded);
							return `${isSelected ? "❯" : " "} ${glyph} ${b.kind} ${flags} · ${b.tokens} tok · ${b.toolName ?? b.id} · ${clean(b.text)}`;
						};

						if (mapMode && truth && bodyRows >= 3) {
							const barLines = bodyRows >= 5 ? renderCategoryBar(truth, width) : [];
							const selectedRow = block ? formatRow(block, true) : "  No blocks yet";
							const legendRow = "S system · U user · A answer · H thinking · C call · R result · ! bolted · * pin · P tail · G group";
							const mapRows = Math.max(1, bodyRows - barLines.length - 2);
							const map = buildContextMap(truth, selectedId, width, mapRows, { colored: true });
							mapColumns = map.columns;
							body = [...barLines, selectedRow, legendRow, ...map.lines];
						} else {
							mapColumns = 1;
							const listRows = searching || searchQuery ? Math.max(1, bodyRows - 1) : bodyRows;
							const selIdxInFiltered = Math.max(0, blocks.findIndex((b) => b.id === selectedId));
							const fStart = Math.max(0, Math.min(selIdxInFiltered - Math.floor(listRows / 2), blocks.length - listRows));
							const rows = blocks.slice(fStart, fStart + listRows).map((b) => formatRow(b, b.id === selectedId));
							if (searching || searchQuery) {
								body = [`  ⌕ ${searchQuery || "(type to filter blocks)"} (${blocks.length}/${allBlocks.length})`, ...(rows.length ? rows : ["  No matching blocks"])];
							} else {
								body = rows.length ? rows : ["  No blocks yet"];
							}
							const hiddenAbove = fStart;
							const hiddenBelow = Math.max(0, blocks.length - (fStart + listRows));
							bottomCenter = [hiddenAbove > 0 ? `↑ ${hiddenAbove} more` : "", hiddenBelow > 0 ? `↓ ${hiddenBelow} more` : ""].filter(Boolean).join(" · ");
						}
						if (searching) {
							hint = "type filter · backspace · enter done · esc clear";
						} else if (rangeId) {
							hint = "↑↓ select end · g create group · r cancel range · esc close";
						} else if (block && truth?.groupOf(block)) {
							hint = "↑↓ select · enter inspect · f fold · p pin · a auto · x group expand/collapse · d delete group · r range · C compact · c conductor · s settings · esc close";
						} else {
							hint = "↑↓ select · enter inspect · f fold · p pin · a auto · / search · r range · C compact · c conductor · o folding · b budget · t tail · s settings · esc close";
						}
						hint = `m ${mapMode ? "list" : "map"} · e edit · D auto · ? help · ${hint}`;
					} else if (screen === "help") {
						const lines = [
							"1-4 or Tab switch tabs (Context Map · Blocks · Conductors · Settings)",
							"m switch map/list · arrows select · / filter blocks · Enter inspect",
							"Map: S system, U user, A answer, H thinking, C call, R result (colored Spectrum palette)",
							"1–6 token weight · lowercase folded · ! bolted · * pinned · P protected · G grouped",
							"v toggles original text and digest in the inspector",
							"e edit folded digest · D restore engine digest · C run immediate compaction pass",
							"Human-authored summaries cannot be unfolded by the agent.",
							"f fold/unfold · p pin/unpin · a return to auto · o toggle folding on/off",
							"r mark range start · move · g create group · x expand/collapse group · d delete group",
							"b set budget · t set protected tail · c conductors · s settings · Esc close/back",
						].flatMap((row) => wrapTextWithAnsi(clean(row), Math.max(1, width)));
						inspectOffset = Math.min(inspectOffset, Math.max(0, lines.length - bodyRows));
						body = lines.slice(inspectOffset, inspectOffset + bodyRows);
						hint = "↑↓ scroll · esc back";
					} else if (screen === "inspect") {
						const group = block && truth?.groupOf(block);
						const content = !block
							? "Block no longer available"
							: inspectDigest && group?.folded
								? `Group summary: ${truth?.groupSummary(group) || "(empty group summary)"}`
								: inspectDigest && truth?.isFolded(block)
									? truth.digestOf(block)
									: block.text;
						const lines = content.split(/\r?\n/).flatMap((part) => wrapTextWithAnsi(clean(part), Math.max(1, width)));
						inspectOffset = Math.min(inspectOffset, Math.max(0, lines.length - bodyRows));
						body = lines.slice(inspectOffset, inspectOffset + bodyRows);
						hint = `↑↓ scroll · v ${inspectDigest ? "original" : "digest"} · esc back · ${inspectOffset + 1}-${Math.min(lines.length, inspectOffset + bodyRows)}/${lines.length}`;
					} else if (screen === "conductors") {
						const choices = conductorChoices();
						conductorIndex = Math.min(conductorIndex, choices.length);
						const activeId = host.activeConductor()?.id ?? null;
						const rows = [
							`◯ Detach conductor (raw context)${activeId === null ? " ✔" : ""}`,
							...choices.map((c) => {
								const badge = c.readiness.state === "ready" ? "\x1b[38;2;68;160;28m●\x1b[39m ready" : `\x1b[38;2;255;75;75m✗\x1b[39m unavailable: ${c.readiness.reason}`;
								const activeMark = activeId === c.id ? " ✔" : "";
								return `${activeId === c.id ? "◉" : "◯"} ${c.label}${activeMark} · ${badge} · locks: ${c.locks.join(", ") || "none"}`;
							}),
						];
						const start = Math.max(0, Math.min(conductorIndex - bodyRows + 1, rows.length - bodyRows));
						body = rows.slice(start, start + bodyRows).map((row, i) => `${start + i === conductorIndex ? "❯" : " "} ${row}`);
						if (conductorStatus?.text && body.length < bodyRows) {
							body.push("", `${alertMark}${host.activeConductor()?.label ?? "Conductor"} status: ${conductorStatus.text}`);
						}
						hint = "↑↓ select · enter choose · esc back";
					} else if (screen === "consent") {
						const conductor = host.conductors().find((entry) => entry.id === consentId);
						const lines = conductor
							? [
									`Attach ${conductor.label}?`,
									`This conductor requests locks: ${consentLocks.join(", ")}`,
									"While locked, those controls are owned by the conductor until detached.",
									"Sacred controls (observation, budget, agent recall, detach) remain yours.",
									"Enter grants consent; Esc cancels.",
								].flatMap((row) => wrapTextWithAnsi(clean(row), Math.max(1, width)))
							: ["Conductor is no longer available."];
						inspectOffset = Math.min(inspectOffset, Math.max(0, lines.length - bodyRows));
						body = lines.slice(inspectOffset, inspectOffset + bodyRows);
						hint = "↑↓ scroll · enter consent · esc cancel";
					} else if (screen === "settings") {
						const cfg = host.settings?.() ?? {
							autoArm: true,
							defaultConductor: "keel-lite",
							compactMode: "accordion" as const,
							bindHost: "127.0.0.1",
							doorPort: 24317,
							customToken: null,
						};
						const web = host.webInfo?.();
						const rows = [
							`Folding Armed              ${host.folding() ? "● on" : "○ off"}`,
							`Auto-Arm on Startup        ${cfg.autoArm ? "☑ on" : "☐ off"}`,
							`Default Conductor          ${cfg.defaultConductor}`,
							`/compact Behavior          ${cfg.compactMode} (accordion pass | suppress | native)`,
							`Token Budget               ${formatTokens(stats?.budget ?? 70000)} (${dialSource("budget")})`,
							`Protected Working Tail     ${formatTokens(stats?.protectTokens ?? 20000)} (${dialSource("protect")})`,
							`Web UI Bind Address        ${cfg.bindHost} (enter edit · h toggle 127.0.0.1/0.0.0.0)`,
							`Web UI Door Port           ${cfg.doorPort} (0 disables shared door)`,
							`Web Access Token           ${web?.token ?? cfg.customToken ?? "(8-char)"} (${cfg.customToken ? "custom" : "memorable 8-char"} · enter custom · g regenerate)`,
						];
						settingsIndex = Math.max(0, Math.min(settingsIndex, rows.length - 1));
						const maxRows = Math.max(1, bodyRows - 2);
						const start = Math.max(0, Math.min(settingsIndex - maxRows + 1, rows.length - maxRows));
						body = [
							...rows.slice(start, start + maxRows).map((row, i) => `${start + i === settingsIndex ? "❯" : " "} ${row}`),
							`  Browser URL: ${web?.url ?? "starting…"} (${web?.clients ?? 0} connected)`,
						];
						hint = "↑↓ select · enter change/edit · g new 8-char token · h toggle host · esc back";
					} else if (screen === "bindHost" || screen === "customToken") {
						const label = screen === "bindHost" ? "Web UI bind address (e.g. 127.0.0.1, 0.0.0.0, Tailscale IP)" : "Custom web token (3–64 URL-safe chars, or empty for memorable 8-char)";
						body = [`${label}: ${textInput}█`];
						hint = "type text · backspace · enter apply · esc cancel";
					} else if (screen === "budget" || screen === "protect") {
						const kind = screen;
						const label = kind === "budget" ? "Token budget" : "Protected tail";
						const current = kind === "budget" ? stats?.budget : stats?.protectTokens;
						const parsed = numberInput ? parseTokens(numberInput, stats?.contextWindow ?? null) : null;
						const model = host.dials?.()?.model;
						body = [
							`${label}: ${numberInput}█`,
							parsed === null ? "  e.g. 200k, 272k, 1M, 0.5M, 200000 or 85% of the context window" : typeof parsed === "number" ? `  = ${parsed.toLocaleString("en-US")} tokens` : `  ✗ ${parsed.error}`,
							`  now ${current === undefined ? "–" : formatTokens(current)} (${dialSource(kind)})${stats?.contextWindow ? ` · window ${formatTokens(stats.contextWindow)}` : ""}${model ? ` · ${model}` : ""}`,
						];
						hint = `enter this session · ctrl+s also save as default${model ? ` for ${model}` : ""} · esc cancel`;
					} else {
						body = [`Set door port (0 disables): ${numberInput}█`];
						hint = "digits · backspace · enter apply · esc cancel";
					}

					while (body.length < bodyRows) body.push("");
					const statusLine = message || (readOnly ? host.controlMessage?.() ?? "Close and reopen /accordion to request control" : bottomCenter ? `── ${bottomCenter} ──` : "");
					return [
						theme.fg("accent", line(topRule, width)),
						theme.fg(level === "info" ? "muted" : level, line(summary, width)),
						...body.slice(0, bodyRows).map((row) => (row.startsWith("❯") ? theme.fg("accent", ansiLine(row, width)) : ansiLine(row, width))),
						theme.fg(message ? "warning" : "dim", line(statusLine, width)),
						theme.fg("dim", line(hint, width)),
					];
				},
				handleInput(data: string): void {
					if (matchesKey(data, "ctrl+c")) {
						done(undefined);
						return;
					}
					const cancel = keys.matches(data, "tui.select.cancel");
					const confirm = keys.matches(data, "tui.select.confirm");
					const up = keys.matches(data, "tui.select.up");
					const down = keys.matches(data, "tui.select.down");
					const key = decodeKittyPrintable(data) ?? data;

					if (searching) {
						if (cancel) {
							searching = false;
							searchQuery = "";
							update();
							return;
						}
						if (confirm) {
							searching = false;
							update();
							return;
						}
						if (matchesKey(data, "backspace")) {
							searchQuery = searchQuery.slice(0, -1);
							update();
							return;
						}
						if (key && key.length === 1 && key >= " " && key <= "~") {
							searchQuery += key;
							const matches = filteredBlocks();
							if (matches.length) selectedId = matches[0]?.id;
							update();
						}
						return;
					}

					if (cancel) {
						if (screen === "blocks") {
							if (searchQuery) {
								searchQuery = "";
								update();
								return;
							}
							done(undefined);
							return;
						}
						screen = screen === "consent" ? "conductors" : screen === "budget" || screen === "protect" ? dialReturn : screen === "doorPort" || screen === "bindHost" || screen === "customToken" ? "settings" : "blocks";
						message = "";
						update();
						return;
					}
					if (pending) {
						message = "Command pending";
						update();
						return;
					}
					message = "";
					const truth = host.truth();
					const block = current();

					if (screen !== "budget" && screen !== "protect" && screen !== "doorPort" && screen !== "bindHost" && screen !== "customToken") {
						if (key === "1") {
							screen = "blocks";
							mapMode = true;
							update();
							return;
						}
						if (key === "2") {
							screen = "blocks";
							mapMode = false;
							update();
							return;
						}
						if (key === "3") {
							conductorIndex = 0;
							screen = "conductors";
							update();
							return;
						}
						if (key === "4") {
							screen = "settings";
							update();
							return;
						}
						if (matchesKey(data, "tab")) {
							if (screen === "blocks" && mapMode) {
								mapMode = false;
							} else if (screen === "blocks" && !mapMode) {
								conductorIndex = 0;
								screen = "conductors";
							} else if (screen === "conductors") {
								screen = "settings";
							} else {
								screen = "blocks";
								mapMode = true;
							}
							update();
							return;
						}
					}

					if (screen === "inspect" || screen === "help") {
						if (up) inspectOffset = Math.max(0, inspectOffset - 1);
						if (down) inspectOffset++;
						if (screen === "inspect" && key === "v") {
							inspectDigest = !inspectDigest;
							inspectOffset = 0;
						}
					} else if (screen === "conductors") {
						const choices = conductorChoices();
						if (up) conductorIndex = Math.max(0, conductorIndex - 1);
						else if (down) conductorIndex = Math.min(choices.length, conductorIndex + 1);
						else if (confirm && conductorIndex === 0) {
							void send({ kind: "selectConductor", id: null });
							screen = "blocks";
						} else if (confirm) {
							const choice = choices[conductorIndex - 1];
							if (choice?.readiness.state === "unavailable") message = `Unavailable: ${choice.readiness.reason}`;
							else if (choice && choice.locks.length) {
								consentId = choice.id;
								consentLocks = [...choice.locks];
								inspectOffset = 0;
								screen = "consent";
							} else if (choice) {
								void send({ kind: "selectConductor", id: choice.id });
								screen = "blocks";
							}
						}
					} else if (screen === "consent") {
						if (up) inspectOffset = Math.max(0, inspectOffset - 1);
						else if (down) inspectOffset++;
						else if (confirm) {
							const choice = host.conductors().find((entry) => entry.id === consentId);
							if (choice?.readiness.state !== "ready") message = "Conductor is unavailable";
							else if (choice.locks.length !== consentLocks.length || choice.locks.some((lock, i) => lock !== consentLocks[i])) {
								screen = "conductors";
								message = "Conductor locks changed; review again";
							} else {
								void send({ kind: "selectConductor", id: choice.id });
								screen = "blocks";
							}
						}
					} else if (screen === "settings") {
						const cfg = host.settings?.() ?? {
							autoArm: true,
							defaultConductor: "keel-lite",
							compactMode: "accordion" as const,
							bindHost: "127.0.0.1",
							doorPort: 24317,
							customToken: null,
						};
						if (up) settingsIndex = Math.max(0, settingsIndex - 1);
						else if (down) settingsIndex = Math.min(8, settingsIndex + 1);
						else if (key === "g") {
							const nextTok = host.regenerateToken?.();
							if (nextTok) message = `Generated new 8-char token: ${nextTok}`;
						} else if (key === "h") {
							const nextHost = cfg.bindHost === "127.0.0.1" ? "0.0.0.0" : "127.0.0.1";
							void Promise.resolve(host.updateSettings?.({ bindHost: nextHost })).then(() => {
								message = `Web bind host set to ${nextHost}`;
								update();
							});
						} else if (confirm) {
							if (settingsIndex === 0) void send({ kind: "setFolding", value: !host.folding() });
							else if (settingsIndex === 1) {
								void Promise.resolve(host.updateSettings?.({ autoArm: !cfg.autoArm })).then(() => {
									message = `Auto-arm ${!cfg.autoArm ? "enabled" : "disabled"}`;
									update();
								});
							} else if (settingsIndex === 2) {
								const idx = DEFAULT_CONDUCTOR_CYCLE.indexOf(cfg.defaultConductor as (typeof DEFAULT_CONDUCTOR_CYCLE)[number]);
								const next = DEFAULT_CONDUCTOR_CYCLE[(idx + 1) % DEFAULT_CONDUCTOR_CYCLE.length];
								void Promise.resolve(host.updateSettings?.({ defaultConductor: next })).then(() => {
									message = `Default conductor set to ${next}`;
									update();
								});
							} else if (settingsIndex === 3) {
								const idx = COMPACT_MODE_CYCLE.indexOf(cfg.compactMode);
								const next = COMPACT_MODE_CYCLE[(idx + 1) % COMPACT_MODE_CYCLE.length];
								void Promise.resolve(host.updateSettings?.({ compactMode: next })).then(() => {
									message = `/compact behavior set to ${next}`;
									update();
								});
							} else if (settingsIndex === 4) {
								numberInput = "";
								dialReturn = "settings";
								screen = "budget";
							} else if (settingsIndex === 5) {
								numberInput = "";
								dialReturn = "settings";
								screen = "protect";
							} else if (settingsIndex === 6) {
								textInput = cfg.bindHost;
								screen = "bindHost";
							} else if (settingsIndex === 7) {
								numberInput = String(cfg.doorPort);
								screen = "doorPort";
							} else if (settingsIndex === 8) {
								textInput = cfg.customToken ?? "";
								screen = "customToken";
							}
						}
					} else if (screen === "bindHost" || screen === "customToken") {
						if (matchesKey(data, "backspace")) textInput = textInput.slice(0, -1);
						else if (confirm) {
							if (screen === "bindHost") {
								const nextHost = textInput.trim() || "127.0.0.1";
								void Promise.resolve(host.updateSettings?.({ bindHost: nextHost })).then(() => {
									message = `Web bind host set to ${nextHost}`;
									update();
								});
							} else {
								const trimmed = textInput.trim();
								void Promise.resolve(host.updateSettings?.({ customToken: trimmed ? trimmed : null })).then((updated) => {
									message = updated?.customToken ? `Custom token set to ${updated.customToken}` : "Restored memorable 8-char token";
									update();
								});
							}
							screen = "settings";
						} else if (key && key.length === 1 && key >= " " && key <= "~" && textInput.length < 64) {
							textInput += key;
						}
					} else if (screen === "budget" || screen === "protect") {
						const kind = screen;
						const save = matchesKey(data, "ctrl+s");
						if (matchesKey(data, "backspace")) numberInput = numberInput.slice(0, -1);
						else if ((confirm || save) && numberInput) {
							const value = parseTokens(numberInput, host.truth()?.stats().contextWindow ?? null);
							if (typeof value !== "number") message = value.error;
							else {
								void send({ kind: kind === "budget" ? "setBudget" : "setProtect", value }).then(() => {
									if (!save || disposed) return;
									message = host.saveDialDefault ? host.saveDialDefault(kind, value) : "Defaults can only be saved for this Pi session's own model";
									update();
								});
								screen = dialReturn;
							}
						} else if (key && key.length === 1 && /[0-9.,_kKmM%]/.test(key) && numberInput.length < 16) numberInput += key;
					} else if (screen === "doorPort") {
						if (/^\d$/.test(key) && numberInput.length < 12) numberInput += key;
						else if (matchesKey(data, "backspace")) numberInput = numberInput.slice(0, -1);
						else if (confirm && numberInput) {
							void Promise.resolve(host.updateSettings?.({ doorPort: Number(numberInput) })).then(() => {
								message = `Door port set to ${numberInput}`;
								update();
							});
							screen = "settings";
						}
					} else if (up || down || (mapMode && (matchesKey(data, "left") || matchesKey(data, "right")))) {
						const blocks = filteredBlocks();
						if (blocks.length) {
							const curFilteredIdx = Math.max(0, blocks.findIndex((b) => b.id === selectedId));
							const step = up ? -mapColumns : down ? mapColumns : matchesKey(data, "left") ? -1 : 1;
							const nextFilteredIdx = Math.max(0, Math.min(blocks.length - 1, curFilteredIdx + step));
							selectedId = blocks[nextFilteredIdx]?.id;
							const all = truth?.blocks ?? [];
							const allIdx = all.findIndex((b) => b.id === selectedId);
							if (allIdx >= 0) index = allIdx;
						}
					} else if (confirm && block) {
						screen = "inspect";
						inspectOffset = 0;
						inspectDigest = false;
					} else if (key === "?") {
						screen = "help";
						inspectOffset = 0;
					} else if (key === "/") {
						mapMode = false;
						searching = true;
					} else if (key === "m") {
						mapMode = !mapMode;
						mapColumns = 1;
					} else if (key === "o") void send({ kind: "setFolding", value: !host.folding() });
					else if (key === "C") void runCompact();
					else if (key === "c") {
						conductorIndex = 0;
						screen = "conductors";
					} else if (key === "s") {
						screen = "settings";
					} else if (key === "b" || key === "t") {
						screen = key === "b" ? "budget" : "protect";
						dialReturn = "blocks";
						numberInput = "";
					} else if (block && truth) {
						if (key === "e" || key === "D") {
							const group = truth.groupOf(block);
							const foldedGroup = group?.folded ? group : undefined;
							if (readOnly || (host.canSteer && !host.canSteer())) message = "read-only: cannot edit digest";
							else if (!foldedGroup && !truth.isFolded(block)) message = "Select a folded block or group";
							else {
								done({
									kind: key === "e" ? "edit" : "default",
									truth,
									rev: truth.rev,
									blockId: block.id,
									groupId: foldedGroup?.id,
									members: foldedGroup ? [...foldedGroup.memberIds] : undefined,
									text: foldedGroup ? (truth.isDropGroup(foldedGroup) ? "" : truth.groupSummary(foldedGroup)) : truth.digestOf(block),
								});
								return;
							}
						} else if (key === "f") op({ kind: truth.isFolded(block) ? "unfold" : "fold", ids: [block.id] });
						else if (key === "p") op({ kind: block.override === "pinned" ? "unpin" : "pin", ids: [block.id] });
						else if (key === "a") op({ kind: "auto", ids: [block.id] });
						else if (key === "r") rangeId = rangeId ? undefined : block.id;
						else if (key === "g" && rangeId) {
							const start = truth.blocks.findIndex((item) => item.id === rangeId);
							if (start >= 0) op({ kind: "group", ids: truth.blocks.slice(Math.min(start, index), Math.max(start, index) + 1).map((item) => item.id) });
							else message = "Range start no longer exists";
							rangeId = undefined;
						} else if (key === "x" || key === "d") {
							const group = truth.groupOf(block);
							if (group) op({ kind: key === "d" ? "ungroup" : group.folded ? "unfoldGroup" : "foldGroup", groupId: group.id });
						}
					}
					update();
				},
				invalidate() {},
				dispose() {
					if (!disposed) {
						disposed = true;
						unsubscribe();
					}
				},
			};
		});
		if (!action) return;
		const draftKey = action.groupId ? `group:${action.groupId}` : `block:${action.blockId}`;
		let draft: string | undefined;
		if (action.kind === "edit") {
			draft = await ctx.ui.editor("Edit digest · human text cannot be unfolded by the agent", digestDrafts.get(draftKey) ?? action.text);
			if (draft === undefined) {
				message = "Edit cancelled";
				continue;
			}
			if (draft === action.text) {
				digestDrafts.delete(draftKey);
				message = "No changes";
				continue;
			}
			digestDrafts.set(draftKey, draft);
			if (action.groupId && !stripFoldTags(draft.trim()).trim()) {
				const confirmed = await ctx.ui.confirm("Drop group content?", "An empty summary removes group messages from the wire where safe; tool-pair and role safety may retain content. Continue?");
				if (!confirmed) {
					message = "Edit cancelled";
					continue;
				}
			}
		}
		const truth = host.truth();
		const block = truth?.blocks.find((item) => item.id === action.blockId);
		const group = block && truth?.groupOf(block);
		if (
			truth !== action.truth ||
			truth?.rev !== action.rev ||
			!block ||
			(action.groupId ? group?.id !== action.groupId || !group.folded || group.memberIds.join("\0") !== action.members?.join("\0") : !!group?.folded || !truth.isFolded(block))
		) {
			message = "Context changed while editing; retry";
			continue;
		}
		if (host.canSteer && !host.canSteer()) {
			readOnly = true;
			message = "read-only: cannot edit digest";
			continue;
		}
		const text = draft === undefined ? undefined : stripFoldTags(draft.trim()).trim();
		const ops: Op[] =
			action.groupId && action.members
				? [{ kind: "ungroup", groupId: action.groupId }, { kind: "group", ids: [action.members[0], action.members[action.members.length - 1]], ...(text === undefined ? {} : { summary: text || null }) }]
				: [{ kind: "fold", ids: [action.blockId], ...(text === undefined ? {} : { digest: text || EMPTY_DIGEST }) }];
		try {
			const result = await host.command({ kind: "ops", ops, baseRev: action.rev });
			if (result.refused === "read-only") readOnly = true;
			if (!result.refused && result.results.every((item) => item.applied && !item.clamped)) digestDrafts.delete(draftKey);
			message = commandMessage(result);
		} catch (error) {
			message = `Command failed: ${error instanceof Error ? error.message : String(error)}`;
		}
	}
}
