import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { decodeKittyPrintable, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { WireCommand } from "../../core/protocol";
import type { Op } from "../../core/ops";
import type { AccordionTuiHost } from "./host";

const clean = (text: string): string => text.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ");

type Screen = "blocks" | "inspect" | "help" | "conductors" | "consent" | "budget" | "protect";

/** Open the current session's interactive context panel in Pi's TUI. */
export async function openAccordionPanel(ctx: ExtensionContext, host: AccordionTuiHost): Promise<void> {
	if (ctx.mode !== "tui" || !ctx.hasUI) return;
	await ctx.ui.custom<void>((tui, theme, keys, done) => {
		let selectedId: string | undefined;
		let index = 0;
		let screen: Screen = "blocks";
		let conductorIndex = 0;
		let consentId: string | null = null;
		let consentLocks: string[] = [];
		let rangeId: string | undefined;
		let inspectOffset = 0;
		let inspectDigest = false;
		let numberInput = "";
		let message = "";
		let readOnly = host.canSteer ? !host.canSteer() : false;
		let pending = false;
		let disposed = false;
		const update = () => {
			if (disposed) return;
			if (host.canSteer && !host.canSteer()) readOnly = true;
			tui.requestRender();
		};
		const unsubscribe = host.subscribe(update);
		const conductorChoices = () => host.conductors().filter((entry) => entry.id !== "none");
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
			if (pending) { message = "Command pending"; update(); return; }
			pending = true;
			message = "Command pending";
			update();
			try {
				const result = await host.command(command);
				if (disposed) return;
				if (result.refused === "read-only") {
					readOnly = true;
					message = "read-only: close and reopen /accordion to request control again";
				} else {
					const failures = result.results.flatMap((item) => item.perId?.some((entry) => entry.reason)
						? item.perId.filter((entry) => entry.reason).map((entry) => `${entry.id}: ${entry.reason}`)
						: item.clamped ? [item.clamped] : []);
					message = failures.length ? `Refused: ${failures.join(", ")}` : "Command sent";
				}
			} catch (error) {
				if (!disposed) message = `Command failed: ${error instanceof Error ? error.message : String(error)}`;
			} finally {
				pending = false;
				update();
			}
		};
		const op = (operation: Op) => { void send({ kind: "ops", ops: [operation] }); };
		const line = (s: string, width: number) => truncateToWidth(clean(s), Math.max(0, width));
		return {
			render(width: number): string[] {
				const truth = host.truth();
				const block = current();
				const bodyRows = Math.max(1, Math.min(12, tui.terminal.rows - 9));
				const stats = truth?.stats();
				const header = readOnly ? "READ-ONLY · Accordion" : `Accordion · folding ${host.folding() ? "on" : "off"} · conductor ${host.activeConductor()?.label ?? "none"}`;
				const summary = stats ? `Tokens ${stats.liveTokens}/${stats.fullTokens} · budget ${stats.budget} · tail ${stats.protectTokens}${stats.contextWindow === null ? "" : ` · window ${stats.contextWindow}`}` : "No session context yet";
				let body: string[] = [];
				let hint = "↑↓ select · enter inspect · f fold · p pin · a auto · o folding · g group · c conductor · b budget · t tail · esc close";
				if (screen === "blocks") {
					const blocks = truth?.blocks ?? [];
					const start = Math.max(0, Math.min(index - Math.floor(bodyRows / 2), blocks.length - bodyRows));
					body = blocks.slice(start, start + bodyRows).map((b, i) => {
						const group = truth?.groupOf(b);
						const state = truth?.isFolded(b) ? "folded" : "live";
						const flags = [state, b.kind === "system" ? "bolted" : truth?.isProtected(b) ? "protected" : "", b.override === "pinned" ? "pinned" : b.override ? `held:${b.override}` : "", group ? `group:${group.folded ? "folded" : "open"}` : "", rangeId === b.id ? "range-start" : ""].filter(Boolean).join(" ");
						return `${start + i === index ? "❯" : " "} ${b.kind} ${flags} · ${b.tokens} tok · ${b.toolName ?? b.id} · ${b.text}`;
					});
					if (!body.length) body = ["  No blocks yet"];
					if (rangeId) hint = "↑↓ select end · g create group · r cancel range · esc close";
					else if (block && truth?.groupOf(block)) hint = "↑↓ select · enter inspect · f fold · p pin · a auto · x group expand/collapse · d delete group · r range · c conductor · o folding · b budget · t tail · esc close";
					else hint = "↑↓ select · enter inspect · f fold · p pin · a auto · r range · c conductor · o folding · b budget · t tail · esc close";
					hint = `? help · ${hint}`;
				} else if (screen === "help") {
					const lines = ["↑/↓ select block · Enter inspect text; v toggles digest", "f fold/unfold · p pin/unpin · a return to auto", "o toggle folding on/off", "r mark range start · move · g create group", "x expand/collapse selected group · d delete group", "b set budget · t set protected tail", "c choose or detach conductor · Esc close/back"]
						.flatMap((row) => wrapTextWithAnsi(clean(row), Math.max(1, width)));
					inspectOffset = Math.min(inspectOffset, Math.max(0, lines.length - bodyRows));
					body = lines.slice(inspectOffset, inspectOffset + bodyRows);
					hint = "↑↓ scroll · esc back";
				} else if (screen === "inspect") {
					const content = !block ? "Block no longer available" : inspectDigest && truth?.isFolded(block) ? truth.digestOf(block) : block.text;
					const lines = content.split(/\r?\n/).flatMap((part) => wrapTextWithAnsi(clean(part), Math.max(1, width)));
					inspectOffset = Math.min(inspectOffset, Math.max(0, lines.length - bodyRows));
					body = lines.slice(inspectOffset, inspectOffset + bodyRows);
					hint = `↑↓ scroll · v ${inspectDigest ? "original" : "digest"} · esc back · ${inspectOffset + 1}-${Math.min(lines.length, inspectOffset + bodyRows)}/${lines.length}`;
				} else if (screen === "conductors") {
					const choices = conductorChoices();
					conductorIndex = Math.min(conductorIndex, choices.length);
					const rows = ["Detach conductor", ...choices.map((c) => `${c.label} · ${c.readiness.state === "ready" ? "ready" : `unavailable: ${c.readiness.reason}`} · locks: ${c.locks.join(", ") || "none"}`)];
					const start = Math.max(0, Math.min(conductorIndex - bodyRows + 1, rows.length - bodyRows));
					body = rows.slice(start, start + bodyRows).map((row, i) => `${start + i === conductorIndex ? "❯" : " "} ${row}`);
					hint = "↑↓ select · enter choose · esc back";
				} else if (screen === "consent") {
					const conductor = host.conductors().find((entry) => entry.id === consentId);
					const lines = conductor ? [`Attach ${conductor.label}?`, `This conductor requests locks: ${consentLocks.join(", ")}`, "Enter grants consent; Esc cancels."].flatMap((row) => wrapTextWithAnsi(clean(row), Math.max(1, width))) : ["Conductor is no longer available."];
					inspectOffset = Math.min(inspectOffset, Math.max(0, lines.length - bodyRows));
					body = lines.slice(inspectOffset, inspectOffset + bodyRows);
					hint = "↑↓ scroll · enter consent · esc cancel";
				} else {
					body = [`Set ${screen === "budget" ? "budget" : "protected tail"} tokens: ${numberInput}`];
					hint = "digits · backspace · enter apply · esc cancel";
				}
				while (body.length < bodyRows) body.push("");
				return [theme.fg("accent", line(header, width)), theme.fg("muted", line(summary, width)), ...body.map((row) => row.startsWith("❯") ? theme.fg("accent", line(row, width)) : line(row, width)), theme.fg(message ? "warning" : "dim", line(message || (readOnly ? host.controlMessage?.() ?? "Close and reopen /accordion to request control" : ""), width)), theme.fg("dim", line(hint, width))];
			},
			handleInput(data: string): void {
				if (matchesKey(data, "ctrl+c")) { done(); return; }
				const cancel = keys.matches(data, "tui.select.cancel");
				const confirm = keys.matches(data, "tui.select.confirm");
				const up = keys.matches(data, "tui.select.up");
				const down = keys.matches(data, "tui.select.down");
				const key = decodeKittyPrintable(data) ?? data;
				if (cancel) {
					if (screen === "blocks") { done(); return; }
					screen = screen === "consent" ? "conductors" : "blocks"; message = ""; update(); return;
				}
				if (pending) { message = "Command pending"; update(); return; }
				message = "";
				const truth = host.truth();
				const block = current();
				if (screen === "inspect" || screen === "help") {
					if (up) inspectOffset = Math.max(0, inspectOffset - 1);
					if (down) inspectOffset++;
					if (screen === "inspect" && key === "v") { inspectDigest = !inspectDigest; inspectOffset = 0; }
				} else if (screen === "conductors") {
					const choices = conductorChoices();
					if (up) conductorIndex = Math.max(0, conductorIndex - 1);
					else if (down) conductorIndex = Math.min(choices.length, conductorIndex + 1);
					else if (confirm && conductorIndex === 0) { void send({ kind: "selectConductor", id: null }); screen = "blocks"; }
					else if (confirm) {
						const choice = choices[conductorIndex - 1];
						if (choice?.readiness.state === "unavailable") message = `Unavailable: ${choice.readiness.reason}`;
						else if (choice && choice.locks.length) { consentId = choice.id; consentLocks = [...choice.locks]; inspectOffset = 0; screen = "consent"; }
						else if (choice) { void send({ kind: "selectConductor", id: choice.id }); screen = "blocks"; }
					}
				} else if (screen === "consent") {
					if (up) inspectOffset = Math.max(0, inspectOffset - 1);
					else if (down) inspectOffset++;
					else if (confirm) {
						const choice = host.conductors().find((entry) => entry.id === consentId);
						if (choice?.readiness.state !== "ready") message = "Conductor is unavailable";
						else if (choice.locks.length !== consentLocks.length || choice.locks.some((lock, i) => lock !== consentLocks[i])) { screen = "conductors"; message = "Conductor locks changed; review again"; }
						else { void send({ kind: "selectConductor", id: choice.id }); screen = "blocks"; }
					}
				} else if (screen === "budget" || screen === "protect") {
					if (/^\d$/.test(key) && numberInput.length < 12) numberInput += key;
					else if (matchesKey(data, "backspace")) numberInput = numberInput.slice(0, -1);
					else if (confirm && numberInput) { void send({ kind: screen === "budget" ? "setBudget" : "setProtect", value: Number(numberInput) }); screen = "blocks"; }
				} else if (up || down) {
					const blocks = truth?.blocks ?? [];
					index = Math.max(0, Math.min(blocks.length - 1, index + (up ? -1 : 1)));
					selectedId = blocks[index]?.id;
				} else if (confirm && block) { screen = "inspect"; inspectOffset = 0; inspectDigest = false; }
				else if (key === "?") { screen = "help"; inspectOffset = 0; }
				else if (key === "o") void send({ kind: "setFolding", value: !host.folding() });
				else if (key === "c") { conductorIndex = 0; screen = "conductors"; }
				else if (key === "b" || key === "t") { screen = key === "b" ? "budget" : "protect"; numberInput = ""; }
				else if (block && truth) {
					if (key === "f") op({ kind: truth.isFolded(block) ? "unfold" : "fold", ids: [block.id] });
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
			dispose() { if (!disposed) { disposed = true; unsubscribe(); } },
		};
	});
}
