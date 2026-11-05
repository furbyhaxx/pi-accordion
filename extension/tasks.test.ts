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
		runTasks(s, { action: "create", list: "plan", title: "Plan", tasks: [{ title: "A" }] });
		runTasks(s, { action: "add", list: "plan", tasks: [{ title: "B" }] });
		const tasks = s.read("plan").tasks;
		expect(tasks.map((t) => typeof t.createdAt)).toEqual(["string", "string"]);
		expect(Date.parse(tasks[1].createdAt!)).toBeGreaterThanOrEqual(Date.parse(tasks[0].createdAt!));
	});

	test("create persists a nested list under .pig/tasks and claims it", () => {
		const { dir, s } = store();
		runTasks(s, { action: "create", list: "auth", title: "Auth", tasks: [{ title: "A", subtasks: [{ title: "A1" }, { title: "A2" }] }, { title: "B" }] });
		const saved = JSON.parse(fs.readFileSync(path.join(dir, ".pig", "tasks", "auth.json"), "utf8"));
		expect(saved.tasks.map((t: { id: string }) => t.id)).toEqual(["1", "1.1", "1.2", "2"]);
		expect(saved.claim.session).toBe("s1");
	});

	test("only the innermost open branch may start", () => {
		const { s } = store();
		runTasks(s, { action: "create", list: "w", title: "W", tasks: [{ title: "A", subtasks: [{ title: "A1" }] }, { title: "B" }] });
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
		runTasks(s, { action: "create", list: "w", title: "W", tasks: [{ title: "A" }] });
		runTasks(s, { action: "start", list: "w", id: "1" });
		expect(() => runTasks(s, { action: "complete", list: "w", id: "1" })).toThrow(TaskError);
		expect(() => runTasks(s, { action: "complete", list: "w", id: "1", report: { outcome: "x".repeat(601) } })).toThrow(/under 600/);
		expect(runTasks(s, { action: "fail", list: "w", id: "1", report: { outcome: "Blocked on API.", open: ["need key"] } })).toContain("failed");
	});

	test("another session's live claim blocks writes until forced", () => {
		const { dir, s } = store("s1");
		runTasks(s, { action: "create", list: "w", title: "W", tasks: [{ title: "A" }] });
		const other = new TaskStore(dir, () => "s2");
		expect(() => runTasks(other, { action: "start", list: "w", id: "1" })).toThrow(/not claimed by this session/);
		expect(() => runTasks(other, { action: "claim", list: "w" })).toThrow(/claimed by another session/);
		runTasks(other, { action: "claim", list: "w", force: true });
		expect(runTasks(other, { action: "start", list: "w", id: "1" })).toContain("Started");
	});

	test("release rejects a foreign or absent claim without reporting success", () => {
		const { dir, s } = store();
		s.create("w", "W", []);
		const other = new TaskStore(dir, () => "s2");
		expect(() => runTasks(other, { action: "release", list: "w" })).toThrow(/not claimed by this session/);
		expect(s.read("w").claim?.session).toBe("s1");
		expect(runTasks(s, { action: "release", list: "w" })).toBe('Released "w".');
		expect(s.read("w").claim).toBeNull();
		expect(() => runTasks(s, { action: "release", list: "w" })).toThrow(/not claimed by this session/);
	});

	test("add numbers new tasks after existing siblings", () => {
		const { s } = store();
		runTasks(s, { action: "create", list: "w", title: "W", tasks: [{ title: "A", subtasks: [{ title: "A1" }] }] });
		expect(runTasks(s, { action: "add", list: "w", parent: "1", tasks: [{ title: "A2" }] })).toContain("1.2 A2");
		expect(runTasks(s, { action: "add", list: "w", tasks: [{ title: "B" }] })).toContain("2 B");
	});

	test("rejects path-like slugs", () => {
		const { s } = store();
		expect(() => runTasks(s, { action: "create", list: "../x", title: "X" })).toThrow(/Invalid list slug/);
	});

	test("claims carry the session name, and claim state ages from held to stale", () => {
		const { dir } = store();
		const s = new TaskStore(dir, () => "s1", () => "Auth work");
		const list = s.create("w", "W", [{ title: "A" }]);
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
		runTasks(s, { action: "create", list: "w", title: "W", tasks: [{ title: "A" }] });
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
		runTasks(s, { action: "create", list: "w", title: "W", tasks: [{ title: "A", subtasks: [{ title: "A1", subtasks: [{ title: "A1a" }] }] }] });
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
		runTasks(s, { action: "create", list: "w", title: "W", tasks: [{ title: "A", subtasks: [{ title: "A1" }, { title: "A2" }] }] });
		runTasks(s, { action: "start", list: "w", id: "1.1" });
		expect(runTasks(s, { action: "complete", list: "w", id: "1.1", report })).not.toContain("All subtasks");
		runTasks(s, { action: "start", list: "w", id: "1.2" });
		expect(runTasks(s, { action: "complete", list: "w", id: "1.2", report })).toContain('All subtasks of 1 "A" are finished: complete 1 now');
	});

	test("moving on from a parent whose subtasks are finished closes it from their reports", () => {
		const { s } = store();
		runTasks(s, { action: "create", list: "w", title: "W", tasks: [{ title: "A", subtasks: [{ title: "A1" }, { title: "A2" }] }, { title: "B" }] });
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
		runTasks(s, { action: "create", list: "w", title: "W", tasks: [{ title: "A", subtasks: [{ title: "A1" }, { title: "A2" }] }, { title: "B" }] });
		runTasks(s, { action: "start", list: "w", id: "1.1" });
		runTasks(s, { action: "complete", list: "w", id: "1.1", report });
		expect(() => runTasks(s, { action: "start", list: "w", id: "2" })).toThrow(/1 "A" is still in progress/);
	});

	test("a blocked task frees the agent, keeps its reason and resumes with start", () => {
		const { s } = store();
		runTasks(s, { action: "create", list: "w", title: "W", tasks: [{ title: "A", subtasks: [{ title: "A1" }, { title: "A2" }] }, { title: "B" }] });
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
		runTasks(s, { action: "create", list: "w", title: "W", tasks: [{ title: "A", subtasks: [{ title: "A1" }] }, { title: "B" }] });
		runTasks(s, { action: "start", list: "w", id: "1.1" });
		expect(() => runTasks(s, { action: "block", list: "w", id: "1.1", reason: "dependency", detail: "x" })).toThrow(/needs "blockedBy"/);
		expect(() => runTasks(s, { action: "block", list: "w", id: "1.1", reason: "dependency", detail: "x", blockedBy: "1" })).toThrow(/own branch/);
		expect(runTasks(s, { action: "block", list: "w", id: "1.1", reason: "dependency", detail: "needs B's schema", blockedBy: "2" })).toContain("Work on 2 now");
	});

	test("a parent completes only when no subtask is unstarted or blocked; fail and abandon take them along", () => {
		const { s } = store();
		runTasks(s, { action: "create", list: "w", title: "W", tasks: [{ title: "A", subtasks: [{ title: "A1" }, { title: "A2" }] }, { title: "B", subtasks: [{ title: "B1" }] }] });
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
		runTasks(s, { action: "create", list: "w", title: "W", tasks: [{ title: "A" }, { title: "B" }, { title: "C" }] });
		expect(() => runTasks(s, { action: "abandon", list: "w", id: "1", report, supersededBy: "9" })).toThrow(/No task "9"/);
		expect(runTasks(s, { action: "abandon", list: "w", id: "1", report: { outcome: "Replaced." }, supersededBy: "3" })).toContain("superseded by 3");
		expect(runTasks(s, { action: "add", list: "w", tasks: [{ title: "B, done right", supersedes: "2" }] })).toContain('2 "B" is superseded by 4 and was abandoned');
		const t = s.read("w").tasks;
		expect(t.find((x) => x.id === "1")).toMatchObject({ status: "abandoned", supersededBy: "3" });
		expect(t.find((x) => x.id === "2")).toMatchObject({ status: "abandoned", supersededBy: "4" });
		expect(() => runTasks(s, { action: "create", list: "v", title: "V", tasks: [{ title: "X", supersedes: "1" }] })).toThrow(/only works with "add"/);
	});
});
