import type { WireCommand } from "../../../core/protocol";
import type { ChromeKeys, ChromeTheme, Hint } from "../chrome";
import type { AccordionTuiHost } from "../host";

/** What one screen of a tab shows inside the frame. */
export interface TabView {
	/** Styled body lines; the frame cuts them to the width and pads to the fixed height. */
	body: string[];
	/** Breadcrumb levels after the tab title, for drill-in screens. */
	crumbs: string[];
	description: string;
	/** The screen's own hints in priority order; the frame adds its own. */
	hints: Hint[];
	above: number;
	below: number;
}

/** A confirm screen: `title`'s first line is the question, the rest are facts. The safe option comes first. */
export interface ConfirmSpec {
	crumb: string;
	title: string;
	options: string[];
	/** An optional one-line text input under the options: its label. Printable keys type into it. */
	input?: string;
	/** Called with the chosen option index (null when cancelled) and the typed text. */
	then(choice: number | null, text: string): void;
}

/** A digest edit, carried out of the custom component because Pi's editor is a separate dialog. */
export interface DigestAction {
	kind: "edit" | "default";
	truth: NonNullable<ReturnType<AccordionTuiHost["truth"]>>;
	rev: number;
	blockId: string;
	groupId?: string;
	members?: string[];
	text: string;
}

/** What the panel shell offers its tabs. */
export interface Shell {
	host: AccordionTuiHost;
	theme(): ChromeTheme;
	keys(): ChromeKeys;
	readOnly(): boolean;
	/** Show a refusal (default) or a result in the description line until the next key. */
	say(message: string, level?: "info" | "warning" | "error"): void;
	/** Send a steering command; one at a time. Resolves when the host answered. */
	send(command: WireCommand): Promise<void>;
	/** Run a longer action that reports its own result text. */
	run(started: string, action: () => string | Promise<string>): Promise<void>;
	confirm(spec: ConfirmSpec): void;
	/** Switch to another tab by id (Overview's jump keys). */
	openTab?(id: string): void;
	/** Ask the Settings tab to select the first row in `section` (Conductors › alt+i). */
	focusSettings?(section: string): void;
	/** Take the pending Settings section, if any. */
	takeSettingsFocus?(): string | null;
	editDigest(action: DigestAction): void;
	update(): void;
}

/** One dashboard section. */
export interface PanelTab {
	id: string;
	title: string;
	view(width: number, rows: number): TabView;
	/** Handle a key the frame did not take; report whether it was used. */
	key(data: string): boolean;
	/** True while an inline input is open, so printable keys go to `key` instead of the filter. */
	typing(): boolean;
	/** The current filter text, or null when the current screen has no filter. */
	query(): string | null;
	setFilter(query: string): void;
	/** Esc: leave one drill-in level; false at the tab's root. */
	back(): boolean;
	/** Staged edits that closing would discard. */
	dirty(): number;
	discard(): void;
	/** Extra help lines below the key list. */
	legend(): string[];
	/** Release subscriptions when the panel closes for good. */
	dispose?(): void;
}
