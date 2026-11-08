import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { warmSymbols } from "./taskSymbols";
import { CLAIM_STALE_MS, TaskError, TaskStore, claimState, runTasks, slugFor, taskFingerprint, type TasksArgs } from "./tasks";

function store(session = "s1", dir = fs.mkdtempSync(path.join(os.tmpdir(), "tasks-"))) {
	return { dir, s: new TaskStore(dir, () => session) };
}

const report = { outcome: "Done." };
/** A call's parsed JSON result. */
const run = (s: TaskStore, args: TasksArgs) => JSON.parse(runTasks(s, args)) as Record<string, unknown>;

describe("tasks", () => {
	test("records when each task was planned, including added tasks", () => {
		const { s } = store();
		runTasks(s, { action: "create", list: "plan", title: "Plan", goals: ["G"], tasks: [{ title: "A" }] });
		runTasks(s, { action: "add", list: "plan", tasks: [{ title: "B" }] });
		const tasks = s.read("plan").tasks;
		expect(tasks.map((t) => typeof t.createdAt)).toEqual(["string", "string"]);
		expect(Date.parse(tasks[1].createdAt!)).toBeGreaterThanOrEqual(Date.parse(tasks[0].createdAt!));
	});

	test("an add that repeats an unstarted sibling reuses it instead of creating a twin", () => {
		const { s } = store();
		run(s, { action: "create", list: "w", title: "W", goals: ["G"], tasks: [{ title: "A" }, { title: "Final digest" }] });
		expect(run(s, { action: "add", list: "w", tasks: [{ title: "  final   DIGEST " }, { title: "Extra" }] })).toEqual({ ok: true, ids: ["2", "3"], existing: ["2"] });
		expect(s.read("w").tasks.map((t) => t.title)).toEqual(["A", "Final digest", "Extra"]);
		// A started task or an explicit supersede is real new work, not a repeat.
		run(s, { action: "start", list: "w", id: "1" });
		expect(run(s, { action: "add", list: "w", tasks: [{ title: "A" }] })).toEqual({ ok: true, ids: ["4"] });
		expect(run(s, { action: "add", list: "w", tasks: [{ title: "Extra", supersedes: "3" }] })).toEqual({ ok: true, ids: ["5"], abandoned: ["3"] });
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
		runTasks(s, { action: "create", list: "auth", title: "Auth", goals: ["G"], tasks: [{ title: "A", subtasks: [{ title: "A1" }, { title: "A2" }] }, { title: "B" }] });
		const saved = JSON.parse(fs.readFileSync(path.join(dir, ".pig", "tasks", "auth.json"), "utf8"));
		expect(saved.version).toBe(3);
		expect(saved.goals).toEqual([{ id: "g1", text: "G" }]);
		expect(saved.tasks.map((t: { id: string; subtasks?: { id: string }[] }) => [t.id, t.subtasks?.map((c) => c.id)])).toEqual([
			["1", ["1.1", "1.2"]],
			["2", undefined],
		]);
		expect(s.read("auth").tasks.map((t) => t.id)).toEqual(["1", "1.1", "1.2", "2"]);
		expect(saved.claim.session).toBe("s1");
	});

	test("only the innermost open branch may start", () => {
		const { s } = store();
		runTasks(s, { action: "create", list: "w", title: "W", goals: ["G"], tasks: [{ title: "A", subtasks: [{ title: "A1" }] }, { title: "B" }] });
		runTasks(s, { action: "start", list: "w", id: "1" });
		runTasks(s, { action: "start", list: "w", id: "1.1" });
		expect(() => runTasks(s, { action: "start", list: "w", id: "2" })).toThrow(/1.1 "A1".*still in progress/);
		expect(() => runTasks(s, { action: "complete", list: "w", id: "1", report })).toThrow(/Subtask 1.1/);
		runTasks(s, { action: "complete", list: "w", id: "1.1", report });
		runTasks(s, { action: "complete", list: "w", id: "1", report });
		expect(run(s, { action: "start", list: "w", id: "2" })).toEqual({ ok: true, started: [{ id: "2", title: "B" }] });
		const [one, , two] = s.read("w").tasks;
		expect(Date.parse(one.endedAt!)).toBeGreaterThanOrEqual(Date.parse(one.startedAt!));
		expect(two.startedAt).toBeString();
		expect(two.endedAt).toBeUndefined();
	});

	test("finishing requires a report within budget", () => {
		const { s } = store();
		runTasks(s, { action: "create", list: "w", title: "W", goals: ["G"], tasks: [{ title: "A" }] });
		runTasks(s, { action: "start", list: "w", id: "1" });
		expect(() => runTasks(s, { action: "complete", list: "w", id: "1" })).toThrow(TaskError);
		expect(() => runTasks(s, { action: "complete", list: "w", id: "1", report: { outcome: "x".repeat(601) } })).toThrow(/under 600/);
		expect(run(s, { action: "fail", list: "w", id: "1", report: { outcome: "Blocked on API.", open: ["need key"] } })).toEqual({ ok: true });
	});

	test("another session's live claim blocks writes until forced", () => {
		const { dir, s } = store("s1");
		runTasks(s, { action: "create", list: "w", title: "W", goals: ["G"], tasks: [{ title: "A" }] });
		const other = new TaskStore(dir, () => "s2");
		expect(() => runTasks(other, { action: "start", list: "w", id: "1" })).toThrow(/not claimed by this session/);
		expect(() => runTasks(other, { action: "claim", list: "w" })).toThrow(/claimed by another session/);
		runTasks(other, { action: "claim", list: "w", force: true });
		expect(run(other, { action: "start", list: "w", id: "1" })).toEqual({ ok: true, started: [{ id: "1", title: "A" }] });
	});

	test("release rejects a foreign or absent claim without reporting success", () => {
		const { dir, s } = store();
		s.create("w", "W", ["G"], []);
		const other = new TaskStore(dir, () => "s2");
		expect(() => runTasks(other, { action: "release", list: "w" })).toThrow(/not claimed by this session/);
		expect(s.read("w").claim?.session).toBe("s1");
		expect(run(s, { action: "release", list: "w" })).toEqual({ ok: true });
		expect(s.read("w").claim).toBeNull();
		expect(() => runTasks(s, { action: "release", list: "w" })).toThrow(/not claimed by this session/);
	});

	test("add numbers new tasks after existing siblings", () => {
		const { s } = store();
		runTasks(s, { action: "create", list: "w", title: "W", goals: ["G"], tasks: [{ title: "A", subtasks: [{ title: "A1" }] }] });
		expect(run(s, { action: "add", list: "w", parent: "1", tasks: [{ title: "A2" }] })).toEqual({ ok: true, ids: ["1.2"] });
		expect(run(s, { action: "add", list: "w", tasks: [{ title: "B" }] })).toEqual({ ok: true, ids: ["2"] });
	});

	test("rejects path-like slugs", () => {
		const { s } = store();
		expect(() => runTasks(s, { action: "create", list: "../x", title: "X", goals: ["G"] })).toThrow(/Invalid list slug/);
	});

	test("claims carry the session name, and claim state ages from held to stale", () => {
		const { dir } = store();
		const s = new TaskStore(dir, () => "s1", () => "Auth work");
		const list = s.create("w", "W", ["G"], [{ title: "A" }]);
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
		runTasks(s, { action: "create", list: "w", title: "W", goals: ["G"], tasks: [{ title: "A" }] });
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
		runTasks(s, { action: "create", list: "w", title: "W", goals: ["G"], tasks: [{ title: "A", subtasks: [{ title: "A1", subtasks: [{ title: "A1a" }] }] }] });
		expect(run(s, { action: "start", list: "w", id: "1.1.1" })).toEqual({ ok: true, started: [{ id: "1", title: "A" }, { id: "1.1", title: "A1" }, { id: "1.1.1", title: "A1a" }] });
		expect(s.read("w").tasks.map((t) => t.status)).toEqual(["doing", "doing", "doing"]);
	});

	test("finishing the last subtask asks for the parent's own report", () => {
		const { s } = store();
		runTasks(s, { action: "create", list: "w", title: "W", goals: ["G"], tasks: [{ title: "A", subtasks: [{ title: "A1" }, { title: "A2" }] }] });
		runTasks(s, { action: "start", list: "w", id: "1.1" });
		expect(run(s, { action: "complete", list: "w", id: "1.1", report })).toEqual({ ok: true, next: { id: "1.2", title: "A2" } });
		runTasks(s, { action: "start", list: "w", id: "1.2" });
		expect(run(s, { action: "complete", list: "w", id: "1.2", report })).toEqual({ ok: true, parentReady: "1" });
	});

	test("moving on from a parent whose subtasks are finished closes it from their reports", () => {
		const { s } = store();
		runTasks(s, { action: "create", list: "w", title: "W", goals: ["G"], tasks: [{ title: "A", subtasks: [{ title: "A1" }, { title: "A2" }] }, { title: "B" }] });
		runTasks(s, { action: "start", list: "w", id: "1.1" });
		runTasks(s, { action: "complete", list: "w", id: "1.1", report: { outcome: "one" } });
		runTasks(s, { action: "start", list: "w", id: "1.2" });
		runTasks(s, { action: "fail", list: "w", id: "1.2", report: { outcome: "two broke" } });
		expect(run(s, { action: "start", list: "w", id: "2" })).toEqual({ ok: true, started: [{ id: "2", title: "B" }], closed: [{ id: "1", status: "failed" }] });
		const a = s.read("w").tasks[0];
		expect(a).toMatchObject({ status: "failed", autoClosed: true });
		expect(a.report?.outcome).toBe("Closed automatically after its subtasks: 1.1 done: one; 1.2 failed: two broke");
	});

	test("a parent with unfinished subtasks still blocks moving on", () => {
		const { s } = store();
		runTasks(s, { action: "create", list: "w", title: "W", goals: ["G"], tasks: [{ title: "A", subtasks: [{ title: "A1" }, { title: "A2" }] }, { title: "B" }] });
		runTasks(s, { action: "start", list: "w", id: "1.1" });
		runTasks(s, { action: "complete", list: "w", id: "1.1", report });
		expect(() => runTasks(s, { action: "start", list: "w", id: "2" })).toThrow(/1 "A" is still in progress/);
	});

	test("task creation validates and persists nested pins and attachments atomically", () => {
		const { dir, s } = store();
		fs.writeFileSync(path.join(dir, "spec.md"), "one\ntwo");
		const tasks = [{ title: "Parent", subtasks: [{ title: "Child", pins: [{ kind: "rule", text: "Never float", source: "user" }], attachments: [{ path: "spec.md:2" }] }] }];
		s.create("w", "Work", ["Goal"], tasks, ["Never float"]);
		expect(s.read("w").tasks[1]).toMatchObject({ pins: [{ id: "p1", text: "Never float" }], attachments: [{ id: "a1", path: "spec.md", anchor: { quote: { exact: "two" } } }] });
		expect(() => s.add("w", undefined, [{ title: "Bad", attachments: [{ path: "missing" }] }])).toThrow();
		expect(s.read("w").tasks).toHaveLength(2);
	});

	test("pins and attachments persist at list and task scope and can be removed", () => {
		const { dir, s } = store();
		fs.writeFileSync(path.join(dir, "spec.md"), "one\ntwo\nthree");
		runTasks(s, { action: "create", list: "w", title: "Work", goals: ["Finish work"], tasks: [{ title: "Task" }] });
		const pin = s.references("w", undefined, "pin", [{ kind: "constraint", text: "never float", source: "user" }], ["Always use decimal, never float"]);
		const attachment = s.references("w", "1", "attach", [{ path: "spec.md:2-3" }]);
		expect(pin).toEqual(["p1"]);
		expect(attachment).toEqual(["a1"]);
		expect(s.read("w").pins?.[0].text).toBe("never float");
		expect(s.read("w").tasks[0].attachments?.[0]).toMatchObject({ path: "spec.md", anchor: { quote: { exact: "two\nthree" } } });
		expect(() => s.references("w", "1", "detach", ["a1", "a9"])).toThrow(/a9/);
		expect(s.read("w").tasks[0].attachments).toHaveLength(1);
		s.references("w", "1", "detach", ["a1"]);
		s.references("w", undefined, "unpin", ["p1"]);
		expect(s.read("w").pins).toEqual([]);
		expect(s.read("w").tasks[0].attachments).toEqual([]);
	});

	test("block details accept up to 1024 characters and reject longer input without changing state", () => {
		const { s } = store();
		runTasks(s, { action: "create", list: "w", title: "Work", goals: ["Finish work"], tasks: [{ title: "Wait" }] });
		runTasks(s, { action: "start", list: "w", id: "1" });
		const detail = "x".repeat(1024);
		expect(() => runTasks(s, { action: "block", list: "w", id: "1", reason: "user-decision", detail: detail + "x" })).toThrow(/1025.*1024/);
		expect(s.read("w").tasks[0].status).toBe("doing");
		runTasks(s, { action: "block", list: "w", id: "1", reason: "user-decision", detail });
		expect(s.read("w").tasks[0].blocks?.[0].detail).toBe(detail);
	});

	test("a blocked task frees the agent, keeps its reason and resumes with start", () => {
		const { s } = store();
		runTasks(s, { action: "create", list: "w", title: "W", goals: ["G"], tasks: [{ title: "A", subtasks: [{ title: "A1" }, { title: "A2" }] }, { title: "B" }] });
		runTasks(s, { action: "start", list: "w", id: "1.1" });
		expect(() => runTasks(s, { action: "block", list: "w", id: "1.1", reason: "user-decision" as never })).toThrow(/needs "detail"/);
		expect(() => runTasks(s, { action: "block", list: "w", id: "1.1", reason: "bored" as never, detail: "x" })).toThrow(/needs "reason"/);
		expect(run(s, { action: "block", list: "w", id: "1.1", reason: "user-decision", detail: "Postgres or SQLite" })).toEqual({ ok: true, alsoBlocked: ["1"] });
		expect(run(s, { action: "status", list: "w" })).toEqual({ ok: true, done: 0, total: 4, blocked: [{ id: "1", reason: "dependency", detail: "subtask 1.1 is blocked", on: "1.1" }, { id: "1.1", reason: "user-decision", detail: "Postgres or SQLite" }], next: { id: "1.2", title: "A2" } });
		expect(run(s, { action: "start", list: "w", id: "2" })).toEqual({ ok: true, started: [{ id: "2", title: "B" }] });
		runTasks(s, { action: "complete", list: "w", id: "2", report });
		expect(() => runTasks(s, { action: "complete", list: "w", id: "1.1", report })).toThrow(/is blocked. Resume it with start/);
		expect(run(s, { action: "start", list: "w", id: "1.1" })).toEqual({ ok: true, resumed: [{ id: "1", title: "A" }, { id: "1.1", title: "A1" }] });
		const a1 = s.read("w").tasks.find((t) => t.id === "1.1")!;
		expect(a1.status).toBe("doing");
		expect(a1.blocks).toEqual([expect.objectContaining({ reason: "user-decision", detail: "Postgres or SQLite", resumedAt: expect.any(String) })]);
	});

	test("a dependency block names a task outside its branch that is not finished", () => {
		const { s } = store();
		runTasks(s, { action: "create", list: "w", title: "W", goals: ["G"], tasks: [{ title: "A", subtasks: [{ title: "A1" }] }, { title: "B" }] });
		runTasks(s, { action: "start", list: "w", id: "1.1" });
		expect(() => runTasks(s, { action: "block", list: "w", id: "1.1", reason: "dependency", detail: "x" })).toThrow(/needs "blockedBy"/);
		expect(() => runTasks(s, { action: "block", list: "w", id: "1.1", reason: "dependency", detail: "x", blockedBy: "1" })).toThrow(/own branch/);
		expect(run(s, { action: "block", list: "w", id: "1.1", reason: "dependency", detail: "needs B's schema", blockedBy: "2" })).toEqual({ ok: true, alsoBlocked: ["1"] });
		expect(run(s, { action: "status", list: "w" }).next).toEqual({ id: "2", title: "B" });
	});

	test("a parent completes only when no subtask is unstarted or blocked; fail and abandon take them along", () => {
		const { s } = store();
		runTasks(s, { action: "create", list: "w", title: "W", goals: ["G"], tasks: [{ title: "A", subtasks: [{ title: "A1" }, { title: "A2" }] }, { title: "B", subtasks: [{ title: "B1" }] }] });
		runTasks(s, { action: "start", list: "w", id: "1.1" });
		runTasks(s, { action: "complete", list: "w", id: "1.1", report });
		expect(() => runTasks(s, { action: "complete", list: "w", id: "1", report })).toThrow(/Subtask 1.2 \(not started\) of 1 is unfinished/);
		runTasks(s, { action: "abandon", list: "w", id: "1.2", report: { outcome: "Not needed." } });
		expect(run(s, { action: "complete", list: "w", id: "1", report })).toEqual({ ok: true, next: { id: "2.1", title: "B1" } });
		runTasks(s, { action: "start", list: "w", id: "2" });
		expect(run(s, { action: "fail", list: "w", id: "2", report: { outcome: "x" } })).toEqual({ ok: true, cascaded: ["2.1"] });
		expect(s.read("w").tasks.find((t) => t.id === "2.1")?.status).toBe("abandoned");
		expect(() => runTasks(s, { action: "fail", list: "w", id: "2.1", report })).toThrow(/abandoned, not in progress/);
	});

	test("supersededBy links an abandoned task to its replacement, from abandon or from add", () => {
		const { s } = store();
		runTasks(s, { action: "create", list: "w", title: "W", goals: ["G"], tasks: [{ title: "A" }, { title: "B" }, { title: "C" }] });
		expect(() => runTasks(s, { action: "abandon", list: "w", id: "1", report, supersededBy: "9" })).toThrow(/No task "9"/);
		expect(run(s, { action: "abandon", list: "w", id: "1", report: { outcome: "Replaced." }, supersededBy: "3" })).toEqual({ ok: true, next: { id: "2", title: "B" } });
		expect(run(s, { action: "add", list: "w", tasks: [{ title: "B, done right", supersedes: "2" }] })).toEqual({ ok: true, ids: ["4"], abandoned: ["2"] });
		const t = s.read("w").tasks;
		expect(t.find((x) => x.id === "1")).toMatchObject({ status: "abandoned", supersededBy: "3" });
		expect(t.find((x) => x.id === "2")).toMatchObject({ status: "abandoned", supersededBy: "4" });
		expect(() => runTasks(s, { action: "create", list: "v", title: "V", goals: ["G"], tasks: [{ title: "X", supersedes: "1" }] })).toThrow(/only works with "add"/);
	});

	test("a list needs a goal before work starts or grows; running work can still end", () => {
		const { dir, s } = store();
		expect(() => runTasks(s, { action: "create", list: "g", title: "G", tasks: [] })).toThrow(/needs "goals"/);
		expect(() => runTasks(s, { action: "create", list: "g", title: "G", goal: "old shape" } as never)).toThrow(/take "goals", not "goal"/);
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
		expect(run(s, { action: "status", list: "old" })).toEqual({ ok: true, done: 0, total: 2, noGoal: true, doing: ["1"], next: { id: "2", title: "Next" } });
		runTasks(s, { action: "complete", list: "old", id: "1", report });
		expect(() => runTasks(s, { action: "start", list: "old", id: "2" })).toThrow(/has no goals yet.*tasks update/);
		expect(() => runTasks(s, { action: "add", list: "old", tasks: [{ title: "X" }] })).toThrow(/has no goals yet/);
		expect(run(s, { action: "update", list: "old", goals: { add: ["Ship it."] } })).toEqual({ ok: true, goals: ["g1"] });
		expect(run(s, { action: "start", list: "old", id: "2" })).toEqual({ ok: true, started: [{ id: "2", title: "Next" }] });
		const saved = JSON.parse(fs.readFileSync(path.join(tasksPath, "old.json"), "utf8"));
		expect([saved.version, saved.goals, saved.tasks.length]).toEqual([3, [{ id: "g1", text: "Ship it." }], 2]);
	});

	test("update edits goals and criteria items by id; removed ids are never reused; finished tasks are frozen", () => {
		const { s } = store();
		expect(run(s, { action: "create", list: "u", title: "U", goals: ["G1", "G2"], tasks: [{ title: "A", acceptanceCriteria: ["a holds"] }, { title: "B", goals: ["B ships"] }] })).toEqual({ ok: true, list: "u", ids: ["1", "2"], goals: ["g1", "g2"], criteria: { "1": ["c1"] } });
		expect(s.read("u").tasks[1].goals).toEqual([{ id: "g3", text: "B ships" }]);
		expect(run(s, { action: "update", list: "u", id: "2", title: "B2", acceptanceCriteria: { add: ["b holds", "b fast"] } })).toEqual({ ok: true, criteria: ["c2", "c3"] });
		expect(run(s, { action: "update", list: "u", id: "2", acceptanceCriteria: { remove: ["c2"], edit: [{ id: "c3", text: "b is fast" }], add: ["b documented"] } })).toEqual({ ok: true, criteria: ["c4"] });
		expect(s.read("u").tasks[1]).toMatchObject({ title: "B2", acceptanceCriteria: [{ id: "c3", text: "b is fast" }, { id: "c4", text: "b documented" }] });
		expect(run(s, { action: "update", list: "u", goals: { remove: ["g2"], add: ["G3"] } })).toEqual({ ok: true, goals: ["g4"] });
		expect(s.read("u").goals).toEqual([{ id: "g1", text: "G1" }, { id: "g4", text: "G3" }]);
		expect(() => runTasks(s, { action: "update", list: "u", goals: { remove: ["g1", "g4"] } })).toThrow(/keeps at least one goal/);
		expect(() => runTasks(s, { action: "update", list: "u", id: "2", acceptanceCriteria: { remove: ["c9"] } })).toThrow(/No acceptanceCriteria of 2 item c9/);
		expect(() => runTasks(s, { action: "update", list: "u", id: "2", acceptanceCriteria: ["plain"] as never })).toThrow(/takes \{ add\?/);
		runTasks(s, { action: "start", list: "u", id: "1" });
		runTasks(s, { action: "complete", list: "u", id: "1", report });
		expect(() => runTasks(s, { action: "update", list: "u", id: "1", title: "A2" })).toThrow(/finished task's title, goals and criteria stay/);
		expect(() => runTasks(s, { action: "update", list: "u", id: "2", acceptanceCriteria: { add: ["1", "2", "3", "4", "5", "6", "7"] } })).toThrow(/at most 8/);
	});

	test("refuses an invalid migration before replacing the legacy file", () => {
		const { dir, s } = store();
		const folder = path.join(dir, ".pig/tasks");
		fs.mkdirSync(folder, { recursive: true });
		const file = path.join(folder, "legacy.json");
		const original = JSON.stringify({ slug: "legacy", title: "Legacy", claim: { session: "s1", at: new Date().toISOString() }, tasks: [{ id: "1", title: "Kept", status: "done", report }, { id: "3", title: "Started identity", status: "doing" }] });
		fs.writeFileSync(file, original);
		expect(() => runTasks(s, { action: "update", list: "legacy", goals: { add: ["Keep history"] } })).toThrow(/Cannot save.*legacy.*id "3"/s);
		expect(fs.readFileSync(file, "utf8")).toBe(original);
		expect(s.read("legacy").tasks.map((t) => t.id)).toEqual(["1", "3"]);
	});

	test("a v2 file migrates on its first write: items get ids in document order and the v2 bytes are kept", () => {
		const { dir, s } = store();
		const folder = path.join(dir, ".pig/tasks");
		fs.mkdirSync(folder, { recursive: true });
		const at = "2026-01-01T00:00:00.000Z";
		const original = JSON.stringify({ version: 2, slug: "old", title: "Old", goal: "Ship it", createdAt: at, updatedAt: at, claim: { session: "s1", at: new Date().toISOString() },
			tasks: [{ id: "1", title: "A", status: "todo", acceptanceCriteria: ["a holds", "a fast"], subtasks: [{ id: "1.1", title: "A1", status: "todo", acceptanceCriteria: ["a1 holds"] }] }] });
		fs.writeFileSync(path.join(folder, "old.json"), original);
		expect(s.read("old").goals).toEqual([{ id: "g1", text: "Ship it" }]);
		expect(run(s, { action: "update", list: "old", id: "1", acceptanceCriteria: { add: ["a documented"] } })).toEqual({ ok: true, criteria: ["c4"] });
		const saved = JSON.parse(fs.readFileSync(path.join(folder, "old.json"), "utf8"));
		expect([saved.version, saved.goal, saved.seq]).toEqual([3, undefined, { g: 1, c: 4 }]);
		expect(saved.tasks[0].acceptanceCriteria.map((c: { id: string }) => c.id)).toEqual(["c1", "c2", "c4"]);
		expect(saved.tasks[0].subtasks[0].acceptanceCriteria).toEqual([{ id: "c3", text: "a1 holds" }]);
		expect(fs.readFileSync(path.join(folder, "old.v2.json"), "utf8")).toBe(original);
	});

	test("attach stores section, symbol and quote anchors and returns their canonical refs", async () => {
		const { dir, s } = store();
		fs.writeFileSync(path.join(dir, "auth.md"), "# Auth\n\n## Interface\n\nget and set\n");
		fs.writeFileSync(path.join(dir, "store.ts"), "export class TokenStore {\n\tget() { return 1; }\n}\n");
		await warmSymbols(["store.ts"]);
		run(s, { action: "create", list: "w", title: "W", goals: ["G"], tasks: [{ title: "A" }] });
		const result = run(s, { action: "attach", list: "w", id: "1", items: [{ path: "auth.md", section: "Auth > Interface", note: "contract" }, { path: "store.ts", symbol: "TokenStore.get" }, { path: "auth.md", quote: "get and set" }] });
		expect(result).toEqual({ ok: true, attachments: [{ id: "a1", ref: "auth.md#Auth > Interface" }, { id: "a2", ref: "store.ts::TokenStore.get" }, { id: "a3", ref: "auth.md@q:a3" }] });
		const stored = s.read("w").tasks[0].attachments!;
		expect(stored.map((a) => a.anchor && Object.keys(a.anchor)[0])).toEqual(["section", "symbol", "quote"]);
		expect(() => run(s, { action: "attach", list: "w", id: "1", items: [{ path: "auth.md", section: "Nope" }] })).toThrow(/no section/);
		expect(() => run(s, { action: "attach", list: "w", id: "1", items: [{ path: "auth.md", section: "Auth", symbol: "x" }] })).toThrow(/exactly one/);
		expect(s.read("w").tasks[0].attachments).toHaveLength(3);
	});

	test("pin, attach and their removals acknowledge without echoing what the agent wrote", () => {
		const { dir, s } = store();
		fs.writeFileSync(path.join(dir, "spec.md"), "one\ntwo\n");
		run(s, { action: "create", list: "w", title: "W", goals: ["G"], tasks: [{ title: "A" }] });
		expect(run(s, { action: "pin", list: "w", items: [{ kind: "rule", text: "two", source: "spec.md" }] })).toEqual({ ok: true, pins: ["p1"] });
		expect(run(s, { action: "attach", list: "w", id: "1", items: [{ path: "spec.md", lines: "1-2" }] })).toEqual({ ok: true, attachments: [{ id: "a1", ref: "spec.md@q:a1" }] });
		expect(run(s, { action: "unpin", list: "w", pins: ["p1"] })).toEqual({ ok: true });
		expect(run(s, { action: "detach", list: "w", id: "1", attachments: ["a1"] })).toEqual({ ok: true });
	});

	test("a refusal carries a machine-readable code", () => {
		const { dir, s } = store();
		run(s, { action: "create", list: "w", title: "W", goals: ["G"], tasks: [{ title: "A" }] });
		const codeOf = (fn: () => unknown) => {
			try {
				fn();
			} catch (err) {
				return err instanceof TaskError ? JSON.parse(err.toResult()) : null;
			}
			return null;
		};
		expect(codeOf(() => run(s, { action: "start", list: "w", id: "9" }))).toEqual({ ok: false, error: "not_found", message: 'No task "9" in "w". Use "status" to see task ids.' });
		expect(codeOf(() => run(new TaskStore(dir, () => "s2"), { action: "claim", list: "w" }))?.error).toBe("claimed_by_other");
		expect(codeOf(() => run(s, { action: "complete", list: "w", id: "1", report }))?.error).toBe("invalid_transition");
		expect(codeOf(() => run(s, { action: "status" } as TasksArgs))?.error).toBe("invalid_args");
	});

	test("a hand-written file loads, and an invalid one is named with its problems", () => {
		const { dir, s } = store();
		const tasksPath = path.join(dir, ".pig", "tasks");
		fs.mkdirSync(tasksPath, { recursive: true });
		fs.writeFileSync(path.join(tasksPath, "plan.json"), JSON.stringify({ version: 2, slug: "plan", title: "Plan", goal: "G", tasks: [{ title: "A", subtasks: [{ title: "A1" }] }] }));
		fs.writeFileSync(path.join(tasksPath, "bad.json"), JSON.stringify({ version: 2, slug: "bad", title: "Bad", tasks: [{ title: "A", id: "3" }] }));
		expect(run(s, { action: "claim", list: "plan" })).toEqual({ ok: true, done: 0, total: 2, next: { id: "1.1", title: "A1" } });
		expect(run(s, { action: "list" })).toEqual({ ok: true, lists: [{ list: "plan", title: "Plan", done: 0, total: 2, claim: "this" }, { list: "bad", invalid: true }] });
		expect(() => runTasks(s, { action: "status", list: "bad" })).toThrow(/id "3" does not match its position 1/);
	});

	test("add before or after a sibling renumbers only unstarted tasks", () => {
		const { s } = store();
		runTasks(s, { action: "create", list: "r", title: "R", goals: ["G"], tasks: [{ title: "A" }, { title: "B" }, { title: "C", subtasks: [{ title: "C1" }] }] });
		runTasks(s, { action: "start", list: "r", id: "1" });
expect(run(s, { action: "add", list: "r", before: "2", tasks: [{ title: "N", acceptanceCriteria: ["n holds"] }] })).toEqual({ ok: true, ids: ["2"], criteria: { "2": ["c1"] }, renumbered: { "2": "3", "3": "4", "3.1": "4.1" } });
		expect(s.read("r").tasks.map((t) => `${t.id} ${t.title}`)).toEqual(["1 A", "2 N", "3 B", "4 C", "4.1 C1"]);
		expect(() => runTasks(s, { action: "add", list: "r", before: "1", tasks: [{ title: "X" }] })).toThrow(/renumber 1 "A" \(doing\) to 2/);
		expect(() => runTasks(s, { action: "add", list: "r", parent: "4", after: "2", tasks: [{ title: "X" }] })).toThrow(/not a subtask of 4/);
		runTasks(s, { action: "add", list: "r", after: "4.1", tasks: [{ title: "C2" }] });
		expect(s.read("r").tasks.map((t) => t.id)).toEqual(["1", "2", "3", "4", "4.1", "4.2"]);
	});

	test("move relocates an unstarted subtree and rewrites references", () => {
		const { s } = store();
		runTasks(s, { action: "create", list: "m", title: "M", goals: ["G"], tasks: [{ title: "A" }, { title: "B", subtasks: [{ title: "B1" }] }, { title: "C" }, { title: "D" }] });
		runTasks(s, { action: "start", list: "m", id: "1" });
		runTasks(s, { action: "block", list: "m", id: "1", reason: "dependency", detail: "needs D first", blockedBy: "4" });
		expect(run(s, { action: "move", list: "m", id: "4", before: "2" })).toEqual({ ok: true, renumbered: { "4": "2", "2": "3", "2.1": "3.1", "3": "4" } });
		expect(s.read("m").tasks.map((t) => `${t.id} ${t.title}`)).toEqual(["1 A", "2 D", "3 B", "3.1 B1", "4 C"]);
		expect(s.read("m").tasks[0].blocks?.[0].on).toBe("2");
		runTasks(s, { action: "move", list: "m", id: "4", parent: "3" });
		expect(s.read("m").tasks.map((t) => `${t.id} ${t.title}`)).toEqual(["1 A", "2 D", "3 B", "3.1 B1", "3.2 C"]);
		expect(() => runTasks(s, { action: "move", list: "m", id: "1", after: "3" })).toThrow(/1 has been blocked, so 1 cannot move/);
		expect(() => runTasks(s, { action: "move", list: "m", id: "3", parent: "3.1" })).toThrow(/inside 3; a task cannot move into its own subtree/);
		expect(() => runTasks(s, { action: "move", list: "m", id: "2" })).toThrow(/Say where/);
		expect(() => runTasks(s, { action: "move", list: "m", id: "2", before: "3" })).toThrow(/already there/);
	});

	test("deep create, add, move and migration preserve identities; finished parents still reject new work", () => {
		const { s } = store();
		runTasks(s, { action: "create", list: "d", title: "D", goals: ["G"], tasks: [{ title: "A", subtasks: [{ title: "A1", subtasks: [{ title: "A11", subtasks: [{ title: "A111" }] }] }] }, { title: "B", subtasks: [{ title: "B1" }] }, { title: "C" }] });
		runTasks(s, { action: "move", list: "d", id: "2", parent: "1.1.1.1" });
		runTasks(s, { action: "add", list: "d", parent: "1.1.1.1.1.1", tasks: [{ title: "X", subtasks: [{ title: "Y" }] }] });
		expect(s.read("d").tasks.at(-2)?.id).toBe("1.1.1.1.1.1.1.1");
		runTasks(s, { action: "start", list: "d", id: "2" });
		runTasks(s, { action: "complete", list: "d", id: "2", report });
		expect(() => runTasks(s, { action: "move", list: "d", id: "1.1.1.1.1.1", parent: "2" })).toThrow(/Task 2 is done/);
		const deep = store();
		let task: { title: string; subtasks?: unknown[] } = { title: "Leaf" };
		for (let i = 1; i < 32; i++) task = { title: `Level ${i}`, subtasks: [task] };
		runTasks(deep.s, { action: "create", list: "deep", title: "Deep", goals: ["G"], tasks: [task] });
		const before = deep.s.read("deep");
		const file = path.join(deep.dir, ".pig/tasks/deep.json");
		fs.writeFileSync(file, JSON.stringify({ ...before, tasks: before.tasks }));
		runTasks(deep.s, { action: "update", list: "deep", goals: { add: ["Migrated"] } });
		expect(deep.s.read("deep").tasks).toEqual(before.tasks);
	});
});
