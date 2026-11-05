import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PIN_ENTRY, PinError, activePins, checkCaps, makePin, pinsOf, refreshFilePin, workingSet, type Pin } from "./pins";
import type { TaskList } from "./tasks";

function repo() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pins-"));
	fs.writeFileSync(path.join(dir, "AGENTS.md"), "# Rules\n\nNever modify vendor/ — it is generated.\nConstants live in config.py.\n");
	fs.writeFileSync(path.join(dir, "config.py"), Array.from({ length: 60 }, (_, i) => (i === 11 ? "BURST_LIMIT = 37" : `x${i} = ${i}`)).join("\n"));
	return dir;
}

const ctx = (cwd: string, existing: Pin[] = [], scope = "session") => ({ cwd, userTexts: ["Finish the rate limiter. Do not add dependencies."], existing, scope, now: "2026-11-05T16:00:00Z" });

describe("pins", () => {
	test("text pins must be verbatim quotes of their source", () => {
		const dir = repo();
		expect(makePin({ kind: "rule", text: "Never modify vendor/ — it is generated.", source: "AGENTS.md:3" }, ctx(dir), "p1").text).toBe("Never modify vendor/ — it is generated.");
		expect(makePin({ kind: "constraint", text: "Do not add dependencies.", source: "user" }, ctx(dir), "p2").source).toBe("user");
		expect(makePin({ kind: "rule", text: "Never modify vendor/ — it is generated.", source: "AGENTS.md:3-4" }, ctx(dir), "p6").source).toBe("AGENTS.md:3-4");
		expect(() => makePin({ kind: "rule", text: "Do not touch vendor.", source: "AGENTS.md" }, ctx(dir), "p3")).toThrow(/not a paraphrase/);
		expect(() => makePin({ kind: "constraint", text: "Finish the rate limiter. Do not add dependencies.", source: "user" }, ctx(dir), "p4")).toThrow(/whole user message/);
		expect(() => makePin({ kind: "fact", text: "x".repeat(301), source: "user" }, ctx(dir), "p5")).toThrow(/at most 300/);
		expect(() => makePin({ kind: "fact", text: "BURST_LIMIT = 37" }, ctx(dir), "p6")).toThrow(/needs "source"/);
	});

	test("file pins resolve a short range and refuse whole files", () => {
		const dir = repo();
		const p = makePin({ kind: "file", ref: "config.py:12-12" }, ctx(dir), "p1");
		expect(p.text).toBe("  12 │ BURST_LIMIT = 37");
		expect(() => makePin({ kind: "file", ref: "config.py:1-60" }, ctx(dir), "p2")).toThrow(/pin at most 30/);
		expect(() => makePin({ kind: "file", ref: "config.py:12" }, ctx(dir, [p]), "p3")).toThrow(/already pinned as p1/);
		expect(() => makePin({ kind: "file", ref: "config.py" }, ctx(dir), "p4")).toThrow(PinError);
	});

	test("file pins follow moved lines and flag changed ones", () => {
		const dir = repo();
		const file = path.join(dir, "config.py");
		const p = makePin({ kind: "file", ref: "config.py:12-12" }, ctx(dir), "p1");
		expect(refreshFilePin(p)).toBeNull();
		fs.writeFileSync(file, `# header\n${fs.readFileSync(file, "utf8")}`);
		const moved = refreshFilePin(p)!;
		expect(moved).toMatchObject({ changed: false, file: { start: 13, end: 13 } });
		fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("BURST_LIMIT = 37", "BURST_LIMIT = 40"));
		const changed = refreshFilePin(moved)!;
		expect(changed.changed).toBe(true);
		expect(changed.text).toContain("BURST_LIMIT = 40");
	});

	test("caps are per scope; only the active branch is in view", () => {
		const dir = repo();
		const big = (i: number, scope: string): Pin => ({ id: `p${i}`, kind: "fact", scope, text: "y".repeat(280), source: "user", at: "" });
		const many = Array.from({ length: 30 }, (_, i) => big(i, "session"));
		expect(() => checkCaps(many.slice(0, 29), many.slice(29))).toThrow(/limit is 2000/);
		expect(() => checkCaps(many.slice(0, 5), [big(99, "w/1")])).not.toThrow();
		const list: TaskList = {
			slug: "w",
			title: "W",
			createdAt: "",
			updatedAt: "",
			claim: null,
			tasks: [
				{ id: "1", title: "Parent", status: "doing", updatedAt: "" },
				{ id: "1.1", title: "Done child", status: "done", updatedAt: "" },
				{ id: "1.2", title: "Active child", status: "doing", updatedAt: "" },
				{ id: "2", title: "Later", status: "todo", updatedAt: "" },
			],
		};
		const pins = ["session", "w/1", "w/1.1", "w/1.2", "w/2"].map((s, i) => ({ ...big(i, s), text: `pin ${s}` }));
		expect(activePins(pins, list).map((p) => p.scope)).toEqual(["session", "w/1", "w/1.2"]);
		const ws = workingSet(activePins(pins, list), list)!;
		expect(ws).toContain("[1 Parent]");
		expect(ws).toContain("[1.2 Active child]");
		expect(ws).not.toContain("pin w/2");
		expect(makePin({ kind: "file", ref: "config.py:12" }, ctx(dir), "p1").file?.display).toBe("config.py");
	});

	test("pins are rebuilt from session entries", () => {
		const p = (id: string): Pin => ({ id, kind: "fact", scope: "session", text: id, source: "user", at: "" });
		const e = (data: unknown) => ({ type: "custom", customType: PIN_ENTRY, data });
		expect(pinsOf([e({ op: "pin", pin: p("p1") }), e({ op: "pin", pin: p("p2") }), e({ op: "unpin", id: "p1" }), e({ op: "update", pin: { ...p("p2"), text: "new" } })])).toEqual([{ ...p("p2"), text: "new" }]);
	});
});
