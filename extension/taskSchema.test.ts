import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { STORED_BLOCK_REASONS, BLOCK_REASONS, CRITERIA_MAX, CRITERION_MAX, GOAL_MAX, GOALS_MAX, LIST_KEYS, REPORT_ITEM_MAX, REPORT_ITEMS_MAX, REPORT_OUTCOME_MAX, TASK_KEYS, TASK_STATUSES, TITLE_MAX, parseListFile, toListFile, type FlatList } from "./taskSchema";

const schema = JSON.parse(fs.readFileSync(path.join(import.meta.dir, "skills/accordion-task-lists/references/tasks.schema.json"), "utf8"));

const errorsOf = (raw: unknown, slug = "auth") => {
	const r = parseListFile(raw, slug);
	return r.ok ? [] : r.errors;
};

const v3 = (tasks: unknown[], extra: Record<string, unknown> = {}) => ({ version: 3, slug: "auth", title: "Auth", goals: ["Tokens go through TokenStore."], tasks, ...extra });

describe("task list v3 schema", () => {
	test("the JSON schema states the same fields and limits as the validator", () => {
		const task = schema.$defs.task.properties;
		expect(Object.keys(schema.properties).sort()).toEqual([...LIST_KEYS, "tasks"].sort());
		expect(Object.keys(task).sort()).toEqual([...TASK_KEYS, "subtasks"].sort());
		expect(task.status.enum).toEqual([...TASK_STATUSES]);
		expect(task.blocks.items.properties.reason.enum).toEqual([...STORED_BLOCK_REASONS]);
		expect([...STORED_BLOCK_REASONS]).toEqual(expect.arrayContaining([...BLOCK_REASONS]));
		expect([task.title.maxLength, schema.properties.title.maxLength, schema.properties.goals.maxItems]).toEqual([TITLE_MAX, TITLE_MAX, GOALS_MAX]);
		expect(JSON.stringify(schema.$defs)).toContain(`"maxLength":${GOAL_MAX}`);
		expect([task.acceptanceCriteria.maxItems, schema.$defs.criterion.oneOf[0].maxLength]).toEqual([CRITERIA_MAX, CRITERION_MAX]);
		expect(task.report.properties.outcome.maxLength).toBe(REPORT_OUTCOME_MAX);
		for (const key of ["decisions", "open"]) expect([task.report.properties[key].maxItems, task.report.properties[key].items.maxLength]).toEqual([REPORT_ITEMS_MAX, REPORT_ITEM_MAX]);
	});

	test("authoring validates expanded criteria and reports with every violation", () => {
		expect(errorsOf(v3([{ title: "A", status: "done", acceptanceCriteria: ["c".repeat(300)], report: { outcome: "o".repeat(2000), decisions: Array(12).fill("d".repeat(1000)) } }]))).toEqual([]);
		const errors = errorsOf(v3([{ title: "A", acceptanceCriteria: ["c".repeat(301)], report: { outcome: "o".repeat(2001), decisions: ["d".repeat(1001)], open: Array(13).fill("x") } }]));
		expect(errors).toEqual([
			expect.stringContaining("acceptanceCriteria"), expect.stringContaining("outcome is 2001 chars; limit 2000"),
			expect.stringContaining("decisions[0] is 1001 chars; limit 1000"), expect.stringContaining("open has 13 items; limit 12"),
		]);
	});

	test("attachment anchors are exactly one of section, symbol or a quote", () => {
		const quote = { exact: "get and set", prefix: "\n", suffix: "", start: 12 };
		const withAnchor = (anchor: unknown) => errorsOf(v3([{ title: "A", attachments: [{ id: "a1", path: "auth.md", anchor }] }]));
		expect(withAnchor({ section: "Token store > Interface" })).toEqual([]);
		expect(withAnchor({ symbol: "TokenStore.get" })).toEqual([]);
		expect(withAnchor({ quote })).toEqual([]);
		expect(withAnchor({ quote: { exact: "get and set" } })).toEqual([]);
		for (const bad of [{}, { section: "" }, { section: "A", symbol: "B" }, { quote: { ...quote, exact: "" } }, { quote: { exact: "x", prefix: 1 } }, { quote: { ...quote, start: -1 } }, "A > B"])
			expect(withAnchor(bad)).toEqual([expect.stringContaining("attachments[0].anchor")]);
		expect(schema.$defs.anchor.oneOf.map((o: { required: string[] }) => o.required[0])).toEqual(["section", "symbol", "quote"]);
	});

	test("hand-written pins and attachments get ids after the explicit ones", () => {
		const result = parseListFile(v3([{ title: "A", pins: [{ kind: "rule", text: "Never touch vendor/.", source: "AGENTS.md" }], attachments: [{ path: "plan.md", anchor: { section: "Do" } }, { id: "a1", path: "spec.md" }] }], { pins: [{ id: "p4", kind: "fact", text: "x", source: "user", at: "t" }] }), "auth", { requireGoal: true });
		if (!result.ok) throw new Error(result.errors.join("\n"));
		const task = result.list.tasks[0] as { pins: { id: string }[]; attachments: { id: string }[] };
		expect(task.pins.map((p) => p.id)).toEqual(["p5"]);
		expect(task.attachments.map((a) => a.id)).toEqual(["a2", "a1"]);
		expect(errorsOf(v3([{ title: "A", pins: [{ kind: "note", text: "", source: "user" }] }]))).toEqual([expect.stringContaining("pins[0].kind"), expect.stringContaining("pins[0].text")]);
	});

	test("every list example in the bundled skill passes the validator", () => {
		const skill = path.join(import.meta.dir, "skills/accordion-task-lists");
		const files = [path.join(skill, "SKILL.md"), ...fs.readdirSync(path.join(skill, "references")).filter((f) => f.endsWith(".md")).map((f) => path.join(skill, "references", f))];
		const lists = files.flatMap((file) => [...fs.readFileSync(file, "utf8").matchAll(/```json\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1]!)).filter((x) => x?.version === 3 && x.slug));
		expect(lists.length).toBeGreaterThanOrEqual(5);
		for (const list of lists) {
			const result = parseListFile(list, list.slug, { requireGoal: true });
			expect(result.ok ? [] : result.errors).toEqual([]);
		}
	});

	test("the bundled validator accepts a valid authored list and reports invalid input", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "accordion-author-"));
		const file = path.join(dir, "auth.json");
		const script = path.join(import.meta.dir, "skills/accordion-task-lists/scripts/validate.mjs");
		try {
			fs.writeFileSync(file, JSON.stringify(v3([{ title: "Survey", acceptanceCriteria: ["c".repeat(300)], report: { outcome: "o".repeat(2000) } }])));
			const valid = spawnSync("node", [script, file], { encoding: "utf8" });
			expect(valid.status).toBe(0);
			expect(valid.stdout).toContain("Valid task list: auth");
			fs.writeFileSync(file, JSON.stringify(v3([{ title: "Survey", id: "2", report: { outcome: "o".repeat(2001), decisions: ["d".repeat(1001)] } }], { goals: undefined })));
			const invalid = spawnSync("node", [script, file], { encoding: "utf8" });
			expect(invalid.status).toBe(1);
			expect(invalid.stderr).toContain("goals: required");
			expect(invalid.stderr).toContain("does not match its position");
			expect(invalid.stderr).toContain("outcome is 2001 chars; limit 2000");
			expect(invalid.stderr).toContain("decisions[0] is 1001 chars; limit 1000");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("the bundled validator resolves references of a list linked into .pig/tasks", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "accordion-refs-"));
		const script = path.join(import.meta.dir, "skills/accordion-task-lists/scripts/validate.mjs");
		const env = { ...process.env, ACCORDION_HOME: dir };
		try {
			fs.mkdirSync(path.join(dir, "plans"));
			fs.mkdirSync(path.join(dir, ".pig", "tasks"), { recursive: true });
			fs.writeFileSync(path.join(dir, "plans", "plan.md"), "# Auth\n\n## Do not\n\n- Never touch vendor/.\n");
			const list = (section: string) => v3([{ title: "Store", attachments: [{ path: "plans/plan.md", anchor: { section } }] }], { pins: [{ kind: "constraint", text: "Never touch vendor/.", source: "plans/plan.md" }] });
			fs.writeFileSync(path.join(dir, "plans", "tasks.json"), JSON.stringify(list("Do not")));
			const link = path.join(dir, ".pig", "tasks", "auth.json");
			fs.symlinkSync("../../plans/tasks.json", link);
			const valid = spawnSync("node", [script, link], { encoding: "utf8", env });
			expect(valid.stdout).toContain("1 pins, 1 attachments resolved");
			expect(valid.status).toBe(0);
			fs.writeFileSync(path.join(dir, "plans", "tasks.json"), JSON.stringify(list("Dont")));
			const lost = spawnSync("node", [script, link], { encoding: "utf8", env });
			expect(lost.status).toBe(1);
			expect(lost.stderr).toContain('task 1 attachment a1 (plans/plan.md): plans/plan.md has no section "Dont"');
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a hand-written tree without ids or statuses loads flat with positional ids", () => {
		const r = parseListFile(v3([{ title: "Survey", acceptanceCriteria: ["every caller listed"] }, { title: "Extract", subtasks: [{ title: "Interface" }, { title: "Migrate" }] }]), "auth");
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.list.tasks.map((t) => [t.id, t.status])).toEqual([
			["1", "todo"],
			["2", "todo"],
			["2.1", "todo"],
			["2.2", "todo"],
		]);
		expect(r.list.tasks[0].acceptanceCriteria).toEqual([{ id: "c1", text: "every caller listed" }]);
		expect(r.list.goals).toEqual([{ id: "g1", text: "Tokens go through TokenStore." }]);
		expect(r.list.seq).toEqual({ g: 1, c: 1 });
	});

	test("item ids are list-unique, never reused after removal, and explicit ids win", () => {
		const r = parseListFile(v3([{ title: "A", acceptanceCriteria: [{ id: "c4", text: "kept" }, "new"] }], { goals: [{ id: "g2", text: "Old goal" }, "Second"], seq: { g: 5, c: 2 } }), "auth");
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		// seq records removed ids (g3–g5, c1–c3 gone): new items continue above them.
		expect(r.list.goals).toEqual([{ id: "g2", text: "Old goal" }, { id: "g6", text: "Second" }]);
		expect(r.list.tasks[0].acceptanceCriteria).toEqual([{ id: "c4", text: "kept" }, { id: "c5", text: "new" }]);
		expect(errorsOf(v3([{ title: "A", acceptanceCriteria: [{ id: "c1", text: "x" }], goals: [{ id: "c1", text: "y" }] }])).join("\n")).toMatch(/goals\[0\]: id "c1" must look like g1/);
		expect(errorsOf(v3([{ title: "A", acceptanceCriteria: [{ id: "c1", text: "x" }] }, { title: "B", acceptanceCriteria: [{ id: "c1", text: "y" }] }])).join("\n")).toContain("duplicate id c1");
	});

	test("a v2 file migrates: one goal and string criteria become items", () => {
		const r = parseListFile({ version: 2, slug: "auth", title: "Auth", goal: "Ship it.", tasks: [{ title: "A", acceptanceCriteria: ["one", "two"], subtasks: [{ title: "B", acceptanceCriteria: ["three"] }] }] }, "auth");
		expect(r.ok && r.migratedFrom).toBe(2);
		if (!r.ok) return;
		expect(r.list.goals).toEqual([{ id: "g1", text: "Ship it." }]);
		expect(r.list.tasks.map((t) => t.acceptanceCriteria)).toEqual([[{ id: "c1", text: "one" }, { id: "c2", text: "two" }], [{ id: "c3", text: "three" }]]);
		const again = parseListFile(JSON.parse(JSON.stringify(toListFile(r.list))), "auth");
		expect(again.ok && again.list).toEqual(r.list);
	});

	test("every problem is reported with its location and fix", () => {
		const errors = errorsOf({
			version: 3,
			slug: "other",
			title: "Auth",
			tasks: [{ title: "A", id: "2", subtask: [] }, { title: "B", acceptanceCriteria: ["a", "b", "c", "d", "e", "f", "g", "h", "i"] }, { title: "C", status: "done" }],
		});
		expect(errors.join("\n")).toMatch(/slug: "other" must equal the file name "auth"/);
		expect(errors.join("\n")).toMatch(/goals: required/);
		expect(errors.join("\n")).toMatch(/tasks\[0\]: id "2" does not match its position 1/);
		expect(errors.join("\n")).toMatch(/tasks\[0\]\.subtask: unknown field/);
		expect(errors.join("\n")).toMatch(/tasks\[1\]\.acceptanceCriteria: has 9 items/);
		expect(errors.join("\n")).toMatch(/tasks\[2\]: a done task needs a report/);
	});

	test("pin and attachment ids must be unique across the whole list", () => {
		const pin = { id: "p1", kind: "rule", text: "Use decimals", source: "user", at: "now" };
		const attachment = { id: "a1", path: "spec.md" };
		const errors = errorsOf(v3([{ title: "A", pins: [pin], attachments: [attachment] }], { pins: [pin], attachments: [attachment] }));
		expect(errors.join("\n")).toContain("duplicate id p1");
		expect(errors.join("\n")).toContain("duplicate id a1");
	});

	test("deep authored and legacy trees round-trip without losing task identities", () => {
		let node: { title: string; subtasks?: unknown[] } = { title: "Leaf" };
		for (let i = 1; i < 64; i++) node = { title: `Level ${i}`, subtasks: [node] };
		const parsed = parseListFile(v3([node]), "auth");
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.list.tasks).toHaveLength(64);
		expect(new RegExp(schema.$defs.task.properties.id.pattern).test(parsed.list.tasks.at(-1)!.id)).toBe(true);
		const { goals: _g, seq: _s, ...v1 } = parsed.list;
		const legacy = parseListFile({ ...v1, goal: "Tokens go through TokenStore." }, "auth");
		expect(legacy.ok && legacy.migratedFrom).toBe(1);
		if (!legacy.ok) return;
		const again = parseListFile(JSON.parse(JSON.stringify(toListFile(legacy.list))), "auth");
		expect(again.ok && again.list.tasks).toEqual(parsed.list.tasks);
	});

	test("impossible status trees are rejected", () => {
		expect(errorsOf(v3([{ title: "P", subtasks: [{ title: "C", status: "doing" }] }])).join("\n")).toMatch(/task 1.1 is doing but its parent 1 is todo/);
	});

	test("a v1 file migrates and writes back as the same tree", () => {
		const v1 = {
			slug: "auth",
			title: "Auth",
			createdAt: "t",
			updatedAt: "t",
			claim: null,
			tasks: [
				{ id: "1", title: "A", status: "done", report: { outcome: "ok" }, updatedAt: "t" },
				{ id: "1.1", title: "A1", status: "done", report: { outcome: "ok" }, updatedAt: "t" },
				{ id: "2", title: "B", status: "todo", updatedAt: "t" },
			],
		};
		const r = parseListFile(v1, "auth");
		expect(r.ok && r.migratedFrom).toBe(1);
		if (!r.ok) return;
		expect(r.list.goals).toBeUndefined();
		const file = toListFile({ ...r.list, goals: [{ id: "g1", text: "G" }] } as FlatList);
		expect((file.tasks as { subtasks?: { id: string }[] }[])[0].subtasks?.map((t) => t.id)).toEqual(["1.1"]);
		const again = parseListFile(JSON.parse(JSON.stringify(file)), "auth");
		expect(again.ok && again.list.tasks.map((t) => t.id)).toEqual(["1", "1.1", "2"]);
		expect(again.ok && again.list.tasks[2]).toEqual({ id: "2", title: "B", status: "todo", updatedAt: "t" });
	});

	test("a delegated block carries its handle and only that reason may", () => {
		const base = { version: 3, slug: "auth", title: "Auth", goals: ["G"], tasks: [{ title: "A" }] };
		const withBlock = (block: Record<string, unknown>) => errorsOf({ ...base, tasks: [{ title: "A", blocks: [block] }] });
		expect(withBlock({ reason: "delegated", detail: "rendering", delegate: "agent-7", at: "2026-01-01T00:00:00.000Z" })).toEqual([]);
		expect(withBlock({ reason: "dependency", detail: "subtask 1.1 is blocked", on: "1.1", at: "2026-01-01T00:00:00.000Z" })).toEqual([]);
		expect(withBlock({ reason: "delegated", detail: "rendering", at: "2026-01-01T00:00:00.000Z" }).join("\n")).toMatch(/a "delegated" block needs the non-empty handle/);
		expect(withBlock({ reason: "third-party", detail: "CI", delegate: "agent-7", at: "2026-01-01T00:00:00.000Z" }).join("\n")).toMatch(/delegate: only a "delegated" block/);
		expect(withBlock({ reason: "dependency", detail: "waiting", at: "2026-01-01T00:00:00.000Z" }).join("\n")).toMatch(/on: a dependency block names the task it waits for/);
		expect(withBlock({ reason: "bored", detail: "x", at: "2026-01-01T00:00:00.000Z" }).join("\n")).toMatch(/reason: must be one of/);
	});
});
