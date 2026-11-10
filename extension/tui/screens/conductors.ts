import type { ActiveConductorMeta } from "../../../core/protocol";
import { bindingHint, clean, fitSegments } from "../chrome";
import { statusLevel } from "../status";
import type { PanelTab, Shell } from "./types";

/** The Conductors tab: attach one, or none. Exclusive conductors ask for consent first. */
export function createConductorsTab(shell: Shell): PanelTab {
	const { host } = shell;
	let selected = 0;

	const choices = (): ActiveConductorMeta[] => host.conductors().filter((entry) => entry.id !== "none");
	const attach = (id: string | null) => void shell.send({ kind: "selectConductor", id });

	return {
		id: "conductors",
		title: "Conductors",
		view(width, rows) {
			const theme = shell.theme();
			const list = choices();
			selected = Math.max(0, Math.min(selected, list.length));
			const activeId = host.activeConductor()?.id ?? null;
			const sep = theme.fg("dim", " · ");
			const line = (index: number, attached: boolean, label: string, rest: string[]) => {
				const mark = attached ? theme.fg("success", "◉") : theme.fg("dim", "◯");
				const name = index === selected ? theme.bold(clean(label)) : clean(label);
				return fitSegments([`${index === selected ? theme.fg("accent", "→") : " "} ${mark} ${name}`, ...(attached ? [`${sep}${theme.fg("success", "attached")}`] : []), ...rest.map((part) => `${sep}${part}`)], width);
			};
			const all = [
				line(0, activeId === null, "None", [theme.fg("dim", "raw context, no strategy")]),
				...list.map((c, i) =>
					line(i + 1, activeId === c.id, c.label, [
						c.readiness.state === "ready" ? `${theme.fg("success", "●")} ready` : `${theme.fg("error", "✗")} unavailable: ${clean(c.readiness.reason)}`,
						theme.fg("muted", `locks: ${c.locks.join(", ") || "none"}`),
					]),
				),
			];
			const top = Math.max(0, Math.min(selected - rows + 1, all.length - rows));
			const pick = selected === 0 ? null : list[selected - 1];
			const status = host.conductorStatus?.() ?? null;
			const level = statusLevel(status?.metrics);
			const attachedStatus = pick && pick.id === activeId && status?.text ? `${level === "error" ? "✗ " : level === "warning" ? "▲ " : ""}${status.text}` : "";
			return {
				body: all.slice(top, top + rows),
				crumbs: [],
				description: attachedStatus || (pick ? (pick.description ?? `${pick.label}: no description.`) : "Detach the conductor: folds it made become yours and stay."),
				hints: [bindingHint(theme, shell.keys(), "tui.select.confirm", "enter", selected === 0 ? "detach" : "attach", 2)],
				above: top,
				below: Math.max(0, all.length - top - rows),
			};
		},
		key(data) {
			const keys = shell.keys();
			const list = choices();
			if (keys.matches(data, "tui.select.up")) selected = Math.max(0, selected - 1);
			else if (keys.matches(data, "tui.select.down")) selected = Math.min(list.length, selected + 1);
			else if (keys.matches(data, "tui.select.confirm")) {
				const choice = selected === 0 ? null : list[selected - 1];
				if (selected === 0) attach(null);
				else if (!choice) return true;
				else if (choice.readiness.state === "unavailable") shell.say(`Unavailable: ${choice.readiness.reason}`);
				else if (!choice.locks.length) attach(choice.id);
				else {
					const shown = [...choice.locks];
					shell.confirm({
						crumb: "Consent",
						title: `Attach ${choice.label}?\nIt takes over: ${shown.join(", ")}.\nThose controls are the conductor's until you detach it.\nObservation, budget, agent recall and detach stay yours.`,
						options: ["Cancel", `Attach ${choice.label}`],
						then: (answer) => {
							if (answer !== 1) return;
							const now = host.conductors().find((entry) => entry.id === choice.id);
							if (now?.readiness.state !== "ready") shell.say("Conductor is unavailable");
							else if (now.locks.length !== shown.length || now.locks.some((lock, i) => lock !== shown[i])) shell.say("Conductor locks changed; review again");
							else attach(now.id);
						},
					});
				}
			} else return false;
			return true;
		},
		typing: () => false,
		query: () => null,
		setFilter() {},
		back: () => false,
		dirty: () => 0,
		discard() {},
		legend: () => [
			"◉ attached, ◯ not attached. ● ready, ✗ unavailable with the reason.",
			"Locks are the steering controls a conductor takes over while attached: human-steering, agent-unfold, tail-size.",
			"A conductor with locks asks for consent first. Detaching freezes its folds into yours.",
		],
	};
}
