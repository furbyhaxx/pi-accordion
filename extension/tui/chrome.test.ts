import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { bindingHint, bodyRowsFor, CHROME_ROWS, type ChromeTheme, crumbText, hintRow, makeChrome, rawHint, renderFrame, ruleLine, tabBar } from "./chrome";

const theme: ChromeTheme = { fg: (_token, text) => text, bold: (text) => `*${text}*`, inverse: (text) => text };
const chrome = makeChrome(theme, null);
const WIDTHS = [36, 57, 80, 140];
const hints = [rawHint(theme, "alt+f", "fold", 2), rawHint(theme, "alt+p", "pin", 3), rawHint(theme, "alt+e", "edit digest", 4), rawHint(theme, "tab", "next tab", 20), rawHint(theme, "f1", "help", 1), rawHint(theme, "escape", "close", 0)];

function frame(width: number, over: Partial<Parameters<typeof renderFrame>[0]> = {}) {
	return renderFrame({
		width, theme, chrome, crumbs: ["Accordion", "Context", "Inspector"], state: ["READ-ONLY", "105.1k/372.0k tok", "● folding", "Taskfold ✓"], above: 3, below: 12,
		tabs: ["Context", "Conductors", "Settings"], active: 1, query: "", filterable: true, body: ["x".repeat(200), "row"], bodyRows: 6,
		description: "d".repeat(200), message: "", messageLevel: "warning", hints, ...over,
	});
}

describe("dashboard chrome", () => {
	test("every line fits every width and the height never changes", () => {
		for (const width of WIDTHS) {
			for (const over of [{}, { query: "needle" }, { body: [] }, { message: "Refused: protected" }, { crumbs: ["Accordion", "Settings", "Web UI bind address"] }]) {
				const lines = frame(width, over);
				expect(lines).toHaveLength(6 + CHROME_ROWS);
				for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
	});

	test("rules span the whole width", () => {
		for (const width of WIDTHS) {
			expect(visibleWidth(ruleLine(width, (t) => t))).toBe(width);
			expect(visibleWidth(ruleLine(width, (t) => t, "Accordion › Context", "↑ 3 more", "READ-ONLY"))).toBe(width);
		}
	});

	test("hints drop from the lowest priority and esc survives", () => {
		expect(hintRow(theme, 140, hints)).toContain("next tab");
		const narrow = hintRow(theme, 36, hints);
		expect(narrow).toContain("esc close");
		expect(narrow).toContain("f1 help");
		expect(narrow).not.toContain("next tab");
		expect(hintRow(theme, 12, hints)).toContain("esc");
	});

	test("the active tab stays visible when the bar scrolls", () => {
		const titles = ["Overview", "Context", "Conductors", "Settings", "Compaction", "Help"];
		for (let active = 0; active < titles.length; active++) {
			const bar = tabBar(chrome, theme, 36, titles, active);
			expect(bar).toContain(`*${` ${titles[active]} `}*`);
			expect(bar).toContain(`${active + 1}/${titles.length}`);
			expect(visibleWidth(bar)).toBeLessThanOrEqual(36);
		}
		expect(tabBar(chrome, theme, 140, titles, 0)).not.toContain("/6");
	});

	test("breadcrumbs drop the earliest level first", () => {
		expect(crumbText(theme, ["Accordion", "Settings", "Token budget"], 80)).toBe("Accordion › Settings › *Token budget*");
		expect(crumbText(theme, ["Accordion", "Settings", "Token budget"], 30)).toBe("… › Settings › *Token budget*");
		expect(crumbText(theme, ["Accordion", "Settings", "Token budget"], 20)).toBe("… › *Token budget*");
	});

	test("a message replaces the description and carries a glyph", () => {
		expect(frame(80, { message: "Refused: protected" })[6 + CHROME_ROWS - 3]).toBe(" ▲ Refused: protected");
	});

	test("hints take their key from the user's binding", () => {
		const keys = { matches: () => false, getKeys: (binding: string) => (binding === "tui.select.cancel" ? ["ctrl+g"] : []) };
		expect(bindingHint(theme, keys, "tui.select.cancel", "escape", "close", 0).text).toBe("ctrl+g close");
		expect(bindingHint(theme, keys, "tui.select.confirm", "enter", "inspect", 1).text).toBe("enter inspect");
	});

	test("body height is fixed per terminal size", () => {
		expect(bodyRowsFor(16)).toBe(4);
		expect(bodyRowsFor(50)).toBe(14);
		expect(bodyRowsFor(8)).toBe(3);
	});
});
