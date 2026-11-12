import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { changedNotice, listDelta, routedNotice, waitingNotice } from "./taskNotices";
import { TaskStore, runTasks, runTasksTracked } from "./tasks";

function store() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "notices-"));
	// Later leaves run while a wait is open, so the notice logic can be exercised past a block.
	const s = new TaskStore(dir, () => "s1", () => undefined, () => ({ stopOnBlock: false }));
	runTasks(s, { action: "create", list: "w", title: "W", goals: ["Ship"], tasks: [{ title: "Design", subtasks: [{ title: "Draft" }, { title: "Review" }] }, { title: "Build" }] });
	return { dir, s };
}

describe("listDelta", () => {
	test("is null when nothing the agent relies on changed", () => {
		const { s } = store();
		expect(listDelta(s.read("w"), s.read("w"))).toBeNull();
	});

	test("reports list-level goal and pin edits and added or removed tasks", () => {
		const { s } = store();
		const before = s.read("w");
		runTasks(s, { action: "update", list: "w", goals: { add: ["Support SSO"], edit: [{ id: "g1", text: "Ship it" }] } });
		runTasksTracked(s, { action: "pin", list: "w", items: [{ kind: "rule", text: "Use tabs", source: "user" }] }, ["Use tabs"]);
		runTasks(s, { action: "add", list: "w", tasks: [{ title: "Docs" }] });
		const delta = listDelta(before, s.read("w"))!;
		expect(delta.goals).toEqual({ added: [{ id: "g2", text: "Support SSO" }], edited: [{ id: "g1", text: "Ship it" }] });
		expect(delta.pins).toEqual({ added: [{ id: "p1", kind: "rule", text: "Use tabs" }] });
		expect(delta.tasks).toEqual({ added: [{ id: "3", title: "Docs" }] });
		expect(delta.within).toBeUndefined();
	});

	test("reports context changes only on the doing branch, keyed by task id", () => {
		const { s } = store();
		runTasks(s, { action: "start", list: "w", id: "1.1" });
		const before = s.read("w");
		runTasks(s, { action: "update", list: "w", id: "1.1", acceptanceCriteria: { add: ["Draft exists"] } });
		runTasks(s, { action: "update", list: "w", id: "1", goals: { add: ["Cover SSO"] } });
		runTasks(s, { action: "update", list: "w", id: "2", acceptanceCriteria: { add: ["Builds"] } });
		const delta = listDelta(before, s.read("w"))!;
		expect(Object.keys(delta.within!)).toEqual(["1", "1.1"]);
		expect(delta.within!["1"]).toEqual({ goals: { added: [{ id: "g2", text: "Cover SSO" }] } });
		expect(delta.within!["1.1"]).toEqual({ criteria: { added: [{ id: "c1", text: "Draft exists" }] } });
	});

	test("reports a rename, a status change and removed pins and attachments", () => {
		const { dir, s } = store();
		fs.writeFileSync(path.join(dir, "spec.md"), "# Spec\n\n## API\nget\n");
		runTasks(s, { action: "start", list: "w", id: "1.1" });
		runTasks(s, { action: "attach", list: "w", items: [{ path: "spec.md", section: "Spec > API" }] });
		runTasksTracked(s, { action: "pin", list: "w", items: [{ kind: "fact", text: "It is old", source: "user" }] }, ["It is old"]);
		const before = s.read("w");
		runTasks(s, { action: "detach", list: "w", attachments: ["a1"] });
		runTasks(s, { action: "unpin", list: "w", pins: ["p1"] });
		runTasks(s, { action: "update", list: "w", id: "2", title: "Build it" });
		runTasks(s, { action: "abandon", list: "w", id: "1.2", report: { outcome: "Not needed." } });
		const delta = listDelta(before, s.read("w"))!;
		expect(delta.attachments).toEqual({ removed: ["a1"] });
		expect(delta.pins).toEqual({ removed: ["p1"] });
		expect(delta.tasks!.changed).toEqual([{ id: "1.2", status: "abandoned" }, { id: "2", title: "Build it" }]);
	});

	test("caps the listed tasks and counts the rest", () => {
		const { s } = store();
		const before = s.read("w");
		runTasks(s, { action: "add", list: "w", tasks: Array.from({ length: 25 }, (_, i) => ({ title: `T${i}` })) });
		const delta = listDelta(before, s.read("w"))!;
		expect(delta.tasks!.added).toHaveLength(20);
		expect(delta.more).toBe(5);
	});
});

describe("notice text", () => {
	test("is one line of JSON", () => {
		expect(changedNotice("w", { goals: { removed: ["g2"] } })).toBe('{"tasks":"w","changed":{"goals":{"removed":["g2"]}}}');
	});

	test("routed notices carry refs and a shortened quote, never newlines", () => {
		const text = routedNotice("w", [{ op: "+", kind: "pin", target: "list", value: "x".repeat(200), pinKind: "rule", ref: "p3" }, { op: "-", kind: "task", target: "2", ref: "2" }]);
		expect(text).not.toContain("\n");
		const ops = JSON.parse(text).changed.ops;
		expect(ops[0].text).toHaveLength(100);
		expect(ops[1]).toEqual({ op: "-", kind: "task", target: "2", ref: "2" });
	});

	test("waiting names only tasks blocked on the user", () => {
		const { s } = store();
		expect(waitingNotice(s.read("w"))).toBeNull();
		runTasks(s, { action: "start", list: "w", id: "1.1" });
		runTasks(s, { action: "block", list: "w", id: "1.1", reason: "user-decision", detail: "Approve?" });
		expect(JSON.parse(waitingNotice(s.read("w"))!)).toEqual({ tasks: "w", waiting: [{ id: "1.1", reason: "user-decision", detail: "Approve?" }] });
		// Order is the list's, so the sibling leaf runs before the third-party task.
		runTasks(s, { action: "start", list: "w", id: "1.2" });
		runTasks(s, { action: "block", list: "w", id: "1.2", reason: "third-party", detail: "CI" });
		expect(JSON.parse(waitingNotice(s.read("w"))!).waiting.map((w: { id: string }) => w.id)).toEqual(["1.1"]);
	});
});
