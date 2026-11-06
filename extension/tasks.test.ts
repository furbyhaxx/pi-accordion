import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CLAIM_STALE_MS, TaskError, TaskStore, claimState, runTasks, slugFor, taskFingerprint } from "./tasks";

function store(session = "s1", dir = fs.mkdtempSync(path.join(os.tmpdir(), "tasks-"))) {
	return { dir, s: new TaskStore(dir, () => session) };
}

const report = { outcome: "Done." };

describe("tasks", () => {
	test("records when each task was planned, including added tasks", () => {
		const { s } = store();
		runTasks(s, { action: "create", list: "plan", title: "Plan", goal: "G", tasks: [{ title: "A" }] });
		runTasks(s, { action: "add", list: "plan", tasks: [{ title: "B" }] });
		const tasks = s.read("plan").tasks;
		expect(tasks.map((t) => typeof t.createdAt)).toEqual(["string", "string"]);
		expect(Date.parse(tasks[1].createdAt!)).toBeGreaterThanOrEqual(Date.parse(tasks[0].createdAt!));
	});

	test("reports filesystem errors instead of presenting unreadable lists as absent", () => {
		const { dir, s } = store();
		fs.mkdirSync(path.join(dir, ".pig", "tasks", "broken.json"), { recursive: true });
		expect(() => s.read("broken")).toThrow(/Cannot read.*broken\.json/);
		expect(() => s.read("missing")).toThrow(/No task list "missing"/);
		const other = store();
		fs.mkdirSync(path.join(other.dir, ".pig"), { recursive: true });
		fs.writeFileSync(path.join(other.dir, ".pig", "tasks"), "not a directory");
		expect(() => other.s.scan()).toThrow(/Cannot read task lists/);
	});

	test("create persists a nested list under .pig/tasks and claims it", () => {
		const { dir, s } = store();
		runTasks(s, { action: "create", list: "auth", title: "Auth", goal: "G", tasks: [{ title: "A", subtasks: [{ title: "A1" }, { title: "A2" }] }, { title: "B" }] });
		const saved = JSON.parse(fs.readFileSync(path.join(dir, ".pig", "tasks", "auth.json"), "utf8"));
		expect(saved.version).toBe(2);
		expect(saved.goal).toBe("G");
		expect(saved.tasks.map((t: { id: string; subtasks?: { id: string }[] }) => [t.id, t.subtasks?.map((c) => c.id)])).toEqual([
			["1", ["1.1", "1.2"]],
			["2", undefined],
		]);
		expect(s.read("auth").tasks.map((t) => t.id)).toEqual(["1", "1.1", "1.2", "2"]);
		expect(saved.claim.session).toBe("s1");
	});

	test("only the innermost open branch may start", () => {
		const { s } = store();
		runTasks(s, { action: "create", list: "w", title: "W", goal: "G", tasks: [{ title: "A", subtasks: [{ title: "A1" }] }, { title: "B" }] });
		runTasks(s, { action: "start", list: "w", id: "1" });
		runTasks(s, { action: "start", list: "w", id: "1.1" });
		expect(() => runTasks(s, { action: "start", list: "w", id: "2" })).toThrow(/1.1 "A1".*still in progress/);
		expect(() => runTasks(s, { action: "complete", list: "w", id: "1", report })).toThrow(/Subtask 1.1/);
		runTasks(s, { action: "complete", list: "w", id: "1.1", report });
		runTasks(s, { action: "complete", list: "w", id: "1", report });
		expect(runTasks(s, { action: "start", list: "w", id: "2" })).toContain("Started");
		const [one, , two] = s.read("w").tasks;
		expect(Date.parse(one.endedAt!)).toBeGreaterThanOrEqual(Date.parse(one.startedAt!));
		expect(two.startedAt).toBeString();
		expect(two.endedAt).toBeUndefined();
	});

	test("finishing requires a report within budget", () => {
		const { s } = store();
		runTasks(s, { action: "create", list: "w", title: "W", goal: "G", tasks: [{ title: "A" }] });
		runTasks(s, { action: "start", list: "w", id: "1" });
		expect(() => runTasks(s, { action: "complete", list: "w", id: "1" })).toThrow(TaskError);
		expect(() => runTasks(s, { action: "complete", list: "w", id: "1", report: { outcome: "x".repeat(601) } })).toThrow(/under 600/);
		expect(runTasks(s, { action: "fail", list: "w", id: "1", report: { outcome: "Blocked on API.", open: ["need key"] } })).toContain("failed");
	});

	test("another session's live claim blocks writes until forced", () => {
		const { dir, s } = store("s1");
		runTasks(s, { action: "create", list: "w", title: "W", goal: "G", tasks: [{ title: "A" }] });
		const other = new TaskStore(dir, () => "s2");
		expect(() => runTasks(other, { action: "start", list: "w", id: "1" })).toThrow(/not claimed by this session/);
		expect(() => runTasks(other, { action: "claim", list: "w" })).toThrow(/claimed by another session/);
		runTasks(other, { action: "claim", list: "w", force: true });
		expect(runTasks(other, { action: "start", list: "w", id: "1" })).toContain("Started");
	});

	test("release rejects a foreign or absent claim without reporting success", () => {
		const { dir, s } = store();
		s.create("w", "W", "G", []);
		const other = new TaskStore(dir, () => "s2");
		expect(() => runTasks(other, { action: "release", list: "w" })).toThrow(/not claimed by this session/);
		expect(s.read("w").claim?.session).toBe("s1");
		expect(runTasks(s, { action: "release", list: "w" })).toBe('Released "w".');
		expect(s.read("w").claim).toBeNull();
		expect(() => runTasks(s, { action: "release", list: "w" })).toThrow(/not claimed by this session/);
	});

	test("add numbers new tasks after existing siblings", () => {
		const { s } = store();
		runTasks(s, { action: "create", list: "w", title: "W", goal: "G", tasks: [{ title: "A", subtasks: [{ title: "A1" }] }] });
		expect(runTasks(s, { action: "add", list: "w", parent: "1", tasks: [{ title: "A2" }] })).toContain("1.2 A2");
		expect(runTasks(s, { action: "add", list: "w", tasks: [{ title: "B" }] })).toContain("2 B");
	});

	test("rejects path-like slugs", () => {
		const { s } = store();
		expect(() => runTasks(s, { action: "create", list: "../x", title: "X", goal: "G" })).toThrow(/Invalid list slug/);
	});

	test("claims carry the session name, and claim state ages from held to stale", () => {
		const { dir } = store();
		const s = new TaskStore(dir, () => "s1", () => "Auth work");
		const list = s.create("w", "W", "G", [{ title: "A" }]);
		expect(list.claim).toMatchObject({ session: "s1", name: "Auth work" });
		const at = Date.parse(list.claim!.at);
		expect(claimState(list, "s1", at)).toBe("mine");
		expect(claimState(list, "s2", at + 1000)).toBe("held");
		expect(claimState(list, "s2", at + CLAIM_STALE_MS + 1)).toBe("stale");
		s.release("w");
		expect(claimState(s.read("w"), "s2")).toBe("free");
	});

	test("the fingerprint changes on task changes, not on claim changes", () => {
		const { s } = store();
		runTasks(s, { action: "create", list: "w", title: "W", goal: "G", tasks: [{ title: "A" }] });
		const before = taskFingerprint(s.read("w"));
		s.release("w");
		s.claim("w");
		expect(taskFingerprint(s.read("w"))).toBe(before);
		runTasks(s, { action: "add", list: "w", tasks: [{ title: "B" }] });
		expect(taskFingerprint(s.read("w"))).not.toBe(before);
	});

	test("slugFor derives a valid, unused slug", () => {
		expect(slugFor("Auth Refactor!", new Set())).toBe("auth-refactor");
		expect(slugFor("Auth Refactor", new Set(["auth-refactor", "auth-refactor-2"]))).toBe("auth-refactor-3");
		expect(slugFor("???", new Set())).toBe("tasks");
	});

	test("starting a subtask starts its unstarted ancestors", () => {
		const { s } = store();
		runTasks(s, { action: "create", list: "w", title: "W", goal: "G", tasks: [{ title: "A", subtasks: [{ title: "A1", subtasks: [{ title: "A1a" }] }] }] });
		const out = runTasks(s, { action: "start", list: "w", id: "1.1.1" });
		expect(out.split("\n")).toEqual([
			'Started w/1.1.1 "A1a".',
			'Also started parent 1 "A" so its span covers this subtask.',
			'Also started parent 1.1 "A1" so its span covers this subtask.',
		]);
		expect(s.read("w").tasks.map((t) => t.status)).toEqual(["doing", "doing", "doing"]);
	});

	test("finishing the last subtask asks for the parent's own report", () => {
		const { s } = store();
		runTasks(s, { action: "create", list: "w", title: "W", goal: "G", tasks: [{ title: "A", subtasks: [{ title: "A1" }, { title: "A2" }] }] });
		runTasks(s, { action: "start", list: "w", id: "1.1" });
		expect(runTasks(s, { action: "complete", list: "w", id: "1.1", report })).not.toContain("All subtasks");
		runTasks(s, { action: "start", list: "w", id: "1.2" });
		expect(runTasks(s, { action: "complete", list: "w", id: "1.2", report })).toContain('All subtasks of 1 "A" are finished: complete 1 now');
	});

	test("moving on from a parent whose subtasks are finished closes it from their reports", () => {
		const { s } = store();
		runTasks(s, { action: "create", list: "w", title: "W", goal: "G", tasks: [{ title: "A", subtasks: [{ title: "A1" }, { title: "A2" }] }, { title: "B" }] });
		runTasks(s, { action: "start", list: "w", id: "1.1" });
		runTasks(s, { action: "complete", list: "w", id: "1.1", report: { outcome: "one" } });
		runTasks(s, { action: "start", list: "w", id: "1.2" });
		runTasks(s, { action: "fail", list: "w", id: "1.2", report: { outcome: "two broke" } });
		const out = runTasks(s, { action: "start", list: "w", id: "2" });
		expect(out).toContain('Closed 1 "A" as failed from its subtasks\' reports');
		const a = s.read("w").tasks[0];
		expect(a).toMatchObject({ status: "failed", autoClosed: true });
		expect(a.report?.outcome).toBe("Closed automatically after its subtasks: 1.1 done: one; 1.2 failed: two broke");
	});

	test("a parent with unfinished subtasks still blocks moving on", () => {
		const { s } = store();
		runTasks(s, { action: "create", list: "w", title: "W", goal: "G", tasks: [{ title: "A", subtasks: [{ title: "A1" }, { title: "A2" }] }, { title: "B" }] });
		runTasks(s, { action: "start", list: "w", id: "1.1" });
		runTasks(s, { action: "complete", list: "w", id: "1.1", report });
		expect(() => runTasks(s, { action: "start", list: "w", id: "2" })).toThrow(/1 "A" is still in progress/);
	});

	test("task creation validates and persists nested pins and attachments atomically", () => {
		const { dir, s } = store();
		fs.writeFileSync(path.join(dir, "spec.md"), "one\ntwo");
		const tasks = [{ title: "Parent", subtasks: [{ title: "Child", pins: [{ kind: "rule", text: "Never float", source: "user" }], attachments: [{ path: "spec.md:2" }] }] }];
		s.create("w", "Work", "Goal", tasks, ["Never float"]);
		expect(s.read("w").tasks[1]).toMatchObject({ pins: [{ id: "p1", text: "Never float" }], attachments: [{ id: "a1", path: "spec.md", lines: "2" }] });
		expect(() => s.add("w", undefined, [{ title: "Bad", attachments: [{ path: "missing" }] }])).toThrow();
		expect(s.read("w").tasks).toHaveLength(2);
	});

	test("pins and attachments persist at list and task scope and can be removed", () => {
		const { dir, s } = store();
		fs.writeFileSync(path.join(dir, "spec.md"), "one\ntwo\nthree");
		runTasks(s, { action: "create", list: "w", title: "Work", goal: "Finish work", tasks: [{ title: "Task" }] });
		const pin = s.references("w", undefined, "pin", [{ kind: "constraint", text: "never float", source: "user" }], ["Always use decimal, never float"]);
		const attachment = s.references("w", "1", "attach", [{ path: "spec.md:2-3" }]);
		expect(pin).toEqual(["p1"]);
		expect(attachment).toEqual(["a1"]);
		expect(s.read("w").pins?.[0].text).toBe("never float");
		expect(s.read("w").tasks[0].attachments?.[0]).toMatchObject({ path: "spec.md", lines: "2-3" });
		expect(() => s.references("w", "1", "detach", ["a1", "a9"])).toThrow(/a9/);
		expect(s.read("w").tasks[0].attachments).toHaveLength(1);
		s.references("w", "1", "detach", ["a1"]);
		s.references("w", undefined, "unpin", ["p1"]);
		expect(s.read("w").pins).toEqual([]);
		expect(s.read("w").tasks[0].attachments).toEqual([]);
	});

	test("block details accept up to 1024 characters and reject longer input without changing state", () => {
		const { s } = store();
		runTasks(s, { action: "create", list: "w", title: "Work", goal: "Finish work", tasks: [{ title: "Wait" }] });
		runTasks(s, { action: "start", list: "w", id: "1" });
		const detail = "x".repeat(1024);
		expect(() => runTasks(s, { action: "block", list: "w", id: "1", reason: "user-decision", detail: detail + "x" })).toThrow(/1025.*1024/);
		expect(s.read("w").tasks[0].status).toBe("doing");
		runTasks(s, { action: "block", list: "w", id: "1", reason: "user-decision", detail });
		expect(s.read("w").tasks[0].blocks?.[0].detail).toBe(detail);
	});

	test("a blocked task frees the agent, keeps its reason and resumes with start", () => {
		const { s } = store();
		runTasks(s, { action: "create", list: "w", title: "W", goal: "G", tasks: [{ title: "A", subtasks: [{ title: "A1" }, { title: "A2" }] }, { title: "B" }] });
		runTasks(s, { action: "start", list: "w", id: "1.1" });
		expect(() => runTasks(s, { action: "block", list: "w", id: "1.1", reason: "user-decision" as never })).toThrow(/needs "detail"/);
		expect(() => runTasks(s, { action: "block", list: "w", id: "1.1", reason: "bored" as never, detail: "x" })).toThrow(/needs "reason"/);
		const out = runTasks(s, { action: "block", list: "w", id: "1.1", reason: "user-decision", detail: "Postgres or SQLite" });
		expect(out).toContain("needs user decision — Postgres or SQLite");
		expect(out).toContain("Also blocked parent 1");
		expect(runTasks(s, { action: "start", list: "w", id: "2" })).toContain("Started w/2");
		runTasks(s, { action: "complete", list: "w", id: "2", report });
		expect(() => runTasks(s, { action: "complete", list: "w", id: "1.1", report })).toThrow(/is blocked. Resume it with start/);
		const resumed = runTasks(s, { action: "start", list: "w", id: "1.1" });
		expect(resumed.split("\n")[0]).toBe('Resumed w/1.1 "A1".');
		expect(resumed).toContain("Also resumed parent 1");
		const a1 = s.read("w").tasks.find((t) => t.id === "1.1")!;
		expect(a1.status).toBe("doing");
		expect(a1.blocks).toEqual([expect.objectContaining({ reason: "user-decision", detail: "Postgres or SQLite", resumedAt: expect.any(String) })]);
	});

	test("a dependency block names a task outside its branch that is not finished", () => {
		const { s } = store();
		runTasks(s, { action: "create", list: "w", title: "W", goal: "G", tasks: [{ title: "A", subtasks: [{ title: "A1" }] }, { title: "B" }] });
		runTasks(s, { action: "start", list: "w", id: "1.1" });
		expect(() => runTasks(s, { action: "block", list: "w", id: "1.1", reason: "dependency", detail: "x" })).toThrow(/needs "blockedBy"/);
		expect(() => runTasks(s, { action: "block", list: "w", id: "1.1", reason: "dependency", detail: "x", blockedBy: "1" })).toThrow(/own branch/);
		expect(runTasks(s, { action: "block", list: "w", id: "1.1", reason: "dependency", detail: "needs B's schema", blockedBy: "2" })).toContain("Work on 2 now");
	});

	test("a parent completes only when no subtask is unstarted or blocked; fail and abandon take them along", () => {
		const { s } = store();
		runTasks(s, { action: "create", list: "w", title: "W", goal: "G", tasks: [{ title: "A", subtasks: [{ title: "A1" }, { title: "A2" }] }, { title: "B", subtasks: [{ title: "B1" }] }] });
		runTasks(s, { action: "start", list: "w", id: "1.1" });
		runTasks(s, { action: "complete", list: "w", id: "1.1", report });
		expect(() => runTasks(s, { action: "complete", list: "w", id: "1", report })).toThrow(/Subtask 1.2 \(not started\) of 1 is unfinished/);
		runTasks(s, { action: "abandon", list: "w", id: "1.2", report: { outcome: "Not needed." } });
		expect(runTasks(s, { action: "complete", list: "w", id: "1", report })).toContain("is done");
		runTasks(s, { action: "start", list: "w", id: "2" });
		expect(runTasks(s, { action: "fail", list: "w", id: "2", report: { outcome: "x" } })).toContain("Also abandoned its unfinished subtask 2.1");
		expect(s.read("w").tasks.find((t) => t.id === "2.1")?.status).toBe("abandoned");
		expect(() => runTasks(s, { action: "fail", list: "w", id: "2.1", report })).toThrow(/abandoned, not in progress/);
	});

	test("supersededBy links an abandoned task to its replacement, from abandon or from add", () => {
		const { s } = store();
		runTasks(s, { action: "create", list: "w", title: "W", goal: "G", tasks: [{ title: "A" }, { title: "B" }, { title: "C" }] });
		expect(() => runTasks(s, { action: "abandon", list: "w", id: "1", report, supersededBy: "9" })).toThrow(/No task "9"/);
		expect(runTasks(s, { action: "abandon", list: "w", id: "1", report: { outcome: "Replaced." }, supersededBy: "3" })).toContain("superseded by 3");
		expect(runTasks(s, { action: "add", list: "w", tasks: [{ title: "B, done right", supersedes: "2" }] })).toContain('2 "B" is superseded by 4 and was abandoned');
		const t = s.read("w").tasks;
		expect(t.find((x) => x.id === "1")).toMatchObject({ status: "abandoned", supersededBy: "3" });
		expect(t.find((x) => x.id === "2")).toMatchObject({ status: "abandoned", supersededBy: "4" });
		expect(() => runTasks(s, { action: "create", list: "v", title: "V", goal: "G", tasks: [{ title: "X", supersedes: "1" }] })).toThrow(/only works with "add"/);
	});

	test("a list needs a goal before work starts or grows; running work can still end", () => {
		const { dir, s } = store();
		expect(() => runTasks(s, { action: "create", list: "g", title: "G", tasks: [] })).toThrow(/needs a "goal"/);
		const tasksPath = path.join(dir, ".pig", "tasks");
		fs.mkdirSync(tasksPath, { recursive: true });
		const v1 = {
			slug: "old",
			title: "Old",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			claim: { session: "s1", at: new Date().toISOString() },
			tasks: [
				{ id: "1", title: "Running", status: "doing", updatedAt: "2026-01-01T00:00:00.000Z" },
				{ id: "2", title: "Next", status: "todo", updatedAt: "2026-01-01T00:00:00.000Z" },
			],
		};
		fs.writeFileSync(path.join(tasksPath, "old.json"), JSON.stringify(v1));
		expect(runTasks(s, { action: "status", list: "old" })).toContain("goal: none yet");
		runTasks(s, { action: "complete", list: "old", id: "1", report });
		expect(() => runTasks(s, { action: "start", list: "old", id: "2" })).toThrow(/has no goal yet.*tasks update/);
		expect(() => runTasks(s, { action: "add", list: "old", tasks: [{ title: "X" }] })).toThrow(/has no goal yet/);
		expect(runTasks(s, { action: "update", list: "old", goal: "Ship it." })).toBe('Updated goal of list "old".');
		expect(runTasks(s, { action: "start", list: "old", id: "2" })).toContain("Started");
		const saved = JSON.parse(fs.readFileSync(path.join(tasksPath, "old.json"), "utf8"));
		expect([saved.version, saved.goal, saved.tasks.length]).toEqual([2, "Ship it.", 2]);
	});

	test("update edits titles and criteria of unfinished tasks only", () => {
		const { s } = store();
		runTasks(s, { action: "create", list: "u", title: "U", goal: "G", tasks: [{ title: "A", acceptanceCriteria: ["a holds"] }, { title: "B" }] });
		runTasks(s, { action: "update", list: "u", id: "2", title: "B2", acceptanceCriteria: ["b holds"] });
		expect(s.read("u").tasks[1]).toMatchObject({ title: "B2", acceptanceCriteria: ["b holds"] });
		expect(s.read("u").tasks[0].acceptanceCriteria).toEqual(["a holds"]);
		runTasks(s, { action: "start", list: "u", id: "1" });
		runTasks(s, { action: "complete", list: "u", id: "1", report });
		expect(() => runTasks(s, { action: "update", list: "u", id: "1", title: "A2" })).toThrow(/finished task's title and criteria stay/);
		expect(() => runTasks(s, { action: "update", list: "u", id: "2", acceptanceCriteria: ["1", "2", "3", "4"] })).toThrow(/has 4 items/);
		expect(() => runTasks(s, { action: "update", list: "u", id: "2", goal: "x" })).toThrow(/"goal" belongs to the list/);
	});

	test("a hand-written file loads, and an invalid one is named with its problems", () => {
		const { dir, s } = store();
		const tasksPath = path.join(dir, ".pig", "tasks");
		fs.mkdirSync(tasksPath, { recursive: true });
		fs.writeFileSync(path.join(tasksPath, "plan.json"), JSON.stringify({ version: 2, slug: "plan", title: "Plan", goal: "G", tasks: [{ title: "A", subtasks: [{ title: "A1" }] }] }));
		fs.writeFileSync(path.join(tasksPath, "bad.json"), JSON.stringify({ version: 2, slug: "bad", title: "Bad", tasks: [{ title: "A", id: "3" }] }));
		expect(runTasks(s, { action: "claim", list: "plan" })).toContain("1.1 A1");
		expect(runTasks(s, { action: "list" })).toMatch(/plan — Plan \(0\/2 done, claimed\)\nbad — invalid file/);
		expect(() => runTasks(s, { action: "status", list: "bad" })).toThrow(/id "3" does not match its position 1/);
	});

	test("add before or after a sibling renumbers only unstarted tasks", () => {
		const { s } = store();
		runTasks(s, { action: "create", list: "r", title: "R", goal: "G", tasks: [{ title: "A" }, { title: "B" }, { title: "C", subtasks: [{ title: "C1" }] }] });
		runTasks(s, { action: "start", list: "r", id: "1" });
		const out = runTasks(s, { action: "add", list: "r", before: "2", tasks: [{ title: "N", acceptanceCriteria: ["n holds"] }] });
		expect(out).toContain("Added 2 N.");
		expect(out).toContain("Renumbered: 2 → 3, 3 → 4, 3.1 → 4.1.");
		expect(s.read("r").tasks.map((t) => `${t.id} ${t.title}`)).toEqual(["1 A", "2 N", "3 B", "4 C", "4.1 C1"]);
		expect(() => runTasks(s, { action: "add", list: "r", before: "1", tasks: [{ title: "X" }] })).toThrow(/renumber 1 "A" \(doing\) to 2/);
		expect(() => runTasks(s, { action: "add", list: "r", parent: "4", after: "2", tasks: [{ title: "X" }] })).toThrow(/not a subtask of 4/);
		runTasks(s, { action: "add", list: "r", after: "4.1", tasks: [{ title: "C2" }] });
		expect(s.read("r").tasks.map((t) => t.id)).toEqual(["1", "2", "3", "4", "4.1", "4.2"]);
	});

	test("move relocates an unstarted subtree and rewrites references", () => {
		const { s } = store();
		runTasks(s, { action: "create", list: "m", title: "M", goal: "G", tasks: [{ title: "A" }, { title: "B", subtasks: [{ title: "B1" }] }, { title: "C" }, { title: "D" }] });
		runTasks(s, { action: "start", list: "m", id: "1" });
		runTasks(s, { action: "block", list: "m", id: "1", reason: "dependency", detail: "needs D first", blockedBy: "4" });
		const out = runTasks(s, { action: "move", list: "m", id: "4", before: "2" });
		expect(out).toContain('Moved 4 "D" to 2.');
		expect(s.read("m").tasks.map((t) => `${t.id} ${t.title}`)).toEqual(["1 A", "2 D", "3 B", "3.1 B1", "4 C"]);
		expect(s.read("m").tasks[0].blocks?.[0].on).toBe("2");
		runTasks(s, { action: "move", list: "m", id: "4", parent: "3" });
		expect(s.read("m").tasks.map((t) => `${t.id} ${t.title}`)).toEqual(["1 A", "2 D", "3 B", "3.1 B1", "3.2 C"]);
		expect(() => runTasks(s, { action: "move", list: "m", id: "1", after: "3" })).toThrow(/1 has been blocked, so 1 cannot move/);
		expect(() => runTasks(s, { action: "move", list: "m", id: "3", parent: "3.1" })).toThrow(/inside 3; a task cannot move into its own subtree/);
		expect(() => runTasks(s, { action: "move", list: "m", id: "2" })).toThrow(/Say where/);
		expect(() => runTasks(s, { action: "move", list: "m", id: "2", before: "3" })).toThrow(/already there/);
	});

	test("nothing moves under a finished parent or deeper than four levels", () => {
		const { s } = store();
		runTasks(s, { action: "create", list: "d", title: "D", goal: "G", tasks: [{ title: "A", subtasks: [{ title: "A1", subtasks: [{ title: "A11", subtasks: [{ title: "A111" }] }] }] }, { title: "B", subtasks: [{ title: "B1" }] }, { title: "C" }] });
		expect(() => runTasks(s, { action: "move", list: "d", id: "2", parent: "1.1.1.1" })).toThrow(/deeper than 4 levels/);
		expect(() => runTasks(s, { action: "add", list: "d", parent: "1.1.1.1", tasks: [{ title: "X" }] })).toThrow(/deeper than 4 levels/);
		runTasks(s, { action: "start", list: "d", id: "3" });
		runTasks(s, { action: "complete", list: "d", id: "3", report });
		expect(() => runTasks(s, { action: "move", list: "d", id: "2.1", parent: "3" })).toThrow(/Task 3 is done/);
	});
});
