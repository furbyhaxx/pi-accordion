import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";

const root = resolve(process.argv[2]);
const capture = (name) => readFileSync(resolve(root, "captures", `${name}.txt`), "utf8");
const text = (names) => names.map(capture).join("\n").replace(/\s+/g, " ");
const widths = [36, 57, 80, 140];
for (const width of widths) {
	for (const view of ["list", "child", "child-bottom", "deep", "deep-bottom", "goal", "record", "paused-tree"]) {
		const screen = capture(`${view}-${width}`);
		assert.ok(screen.split("\n").every((line) => visibleWidth(line) <= width), `${view}: columns ${width}`);
		assert.match(screen, /\besc\b/i, `${view}: visible controls at ${width}`);
	}
	assert.match(capture(`list-${width}`), /2\.1\.1\.1\.1\.1/);
	const child = text([`child-${width}`, `child-bottom-${width}`]);
	for (const value of ["Sentinel content can be recalled.", "task 1.1", "A scoped fact is not a block pin.", "notes.txt"])
		assert.ok(child.includes(value), `child ${width}: ${value}`);
	const deep = text([`deep-${width}`, `deep-bottom-${width}`]);
	for (const value of ["2.1.1.1.1.1", "Full criteria and scoped context remain readable.", "parent 2", "Deep scoped attachment"])
		assert.ok(deep.includes(value), `deep ${width}: ${value}`);
	assert.match(capture(`paused-tree-${width}`), /folding paused/);
	assert.match(capture(`paused-tree-${width}`), /accordion off/);
}
assert.match(capture("record-140"), /terminal-eval\/1\.1/);
assert.match(capture("record-140"), /terminal-eval\/1\.2/);
assert.match(capture("original-child-80"), /RECOVERABLE_SENTINEL_1_1/);
assert.doesNotMatch(capture("original-child-80"), /RECOVERABLE_SENTINEL_1_2/);
assert.match(capture("child-unfolded-80"), /Applied\./);
const sibling = capture("sibling-recomposed-80").split("\n");
assert.ok(!sibling.find((line) => line.includes("1.1 Prepare durable carrier"))?.includes("≡"));
assert.ok(sibling.find((line) => line.includes("1.2 Verify linked recovery"))?.includes("≡"));
assert.match(capture("stored-fold-paused-80"), /Stored fold \(folding paused\):/);
assert.doesNotMatch(capture("stored-fold-paused-80"), /As the agent sees it/);
assert.match(capture("tree-paged-80"), /8\/8/);
assert.match(capture("short-36"), /esc back/);
assert.ok(capture("short-36").trimEnd().split("\n").length <= 10);
assert.match(capture("invalid-lists-80"), /Invalid lists: broken/);
assert.match(capture("widget-restored-80"), /▼ Tasks Taskfold reliability/);
assert.match(capture("new-session-tree-80"), /Nothing ran in this session yet/);
assert.doesNotMatch(capture("new-session-tree-80"), /terminal-eval|Prepare durable carrier|2\.1\.1/);
assert.match(capture("create-goal-80"), /Goal:.*█/);
assert.match(capture("created-list-80"), /Created and attached "ui-after-switch"/);
const created = JSON.parse(readFileSync(resolve(root, "project/.pig/tasks/ui-after-switch.json"), "utf8"));
assert.equal(created.goal, "Verify explicit goal collection and fresh-session task binding.");
assert.equal(created.version, 2);
const fixture = JSON.parse(readFileSync(resolve(root, "fixture.json"), "utf8"));
assert.match(capture("created-list-80"), /ui-after-switch.*this session/);
if (created.claim !== null) assert.notEqual(created.claim.session, fixture.sessionId);
const leafs = (nodes) => nodes.flatMap((node) => node.task && !node.folded ? leafs(node.content ?? []) : [node]);
const exports = [];
for (const filename of ["eval-dump.yaml", "paused.yaml"]) {
	const raw = readFileSync(resolve(root, "project", filename), "utf8");
	const doc = Bun.YAML.parse(raw).transcript;
	const leaves = leafs([...(doc.orientation ?? []), ...(doc.body ?? []), ...(doc.tail ?? [])]);
	const sum = leaves.reduce((total, node) => total + (typeof node.tokens === "number" ? node.tokens : node.tokens.live), 0)
		+ doc.system.tokens + (doc.working_set?.tokens ?? 0);
	assert.equal(sum, doc.tokens.live, filename);
	const list = doc.metadata.task_lists.find((list) => list.slug === "terminal-eval");
	assert.equal(list.goal, "Inspect all task context and recover a composed child without losing metadata.");
	assert.ok(list.pins.length && list.attachments.length);
	assert.ok(list.tasks.find((task) => task.id === "1.1").acceptanceCriteria.length);
	assert.ok(list.tasks.find((task) => task.id === "2.1.1.1.1.1").attachments.length);
	assert.ok(JSON.stringify(doc.metadata.list_issues).includes("broken"));
	assert.ok(doc.metadata.block_details.length);
	if (filename === "paused.yaml") assert.equal(doc.tokens.live, doc.tokens.full);
	exports.push({ filename, bytes: Buffer.byteLength(raw), sha256: createHash("sha256").update(raw).digest("hex"), live: doc.tokens.live, leafSum: sum, full: doc.tokens.full,
		metadata: Object.keys(doc.metadata), workingSet: doc.working_set ? "available" : "not built before the first agent start" });
}
const formats = ["txt", "yaml", "xml", "md", "log"].map((extension) => {
	const filename = `eval-dump.${extension}`;
	const bytes = statSync(resolve(root, "project", filename)).size;
	assert.ok(bytes > 0);
	return { extension, bytes };
});
const samples = ["list-36", "list-140", "child-80", "deep-36", "deep-bottom-36", "stored-fold-paused-80", "short-36", "new-session-tree-80", "create-goal-80", "created-list-80"];
console.log(JSON.stringify({ runtime: "Pi-Bolt 1.0.9 / Pi 1.4.0", geometry: { widths, rows: 30, short: "36x10" },
	scope: "Real private tmux terminal, final tracked source eb92e9a; synthetic fixtures, no credentials or provider calls.",
	captureCount: readdirSync(resolve(root, "captures")).filter((file) => file.endsWith(".txt")).length,
	checks: ["four-width task/list/context/record geometry", "short-height controls", "criteria and scoped/inherited facts", "six-level task and attachment", "named composed-child record", "child original sentinel", "human child unfold and sibling recompose", "paused projection versus stored record", "record and session-tree paging", "invalid-list diagnostics", "widget restoration", "new-session isolation", "interactive goal collection", "five native export formats", "YAML parses and exact additive live totals"],
	formats, exports, captures: samples.map((name) => ({ name, screen: capture(name).split("\n").map((line) => line.startsWith("/mnt/Projects/") ? "<fixture project>" : line).join("\n") }))
}, null, 2));
