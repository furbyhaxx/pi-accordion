import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildSessionContext, parseSessionEntries } from "@earendil-works/pi-coding-agent";
import type { PiMessage } from "../../../../core/wire";
import type { DumpDoc, DumpNode } from "../../../../extension/tui/transcriptDump";

const [sessionFile, listFile, output, mode, sourceRoot, legacyFile] = process.argv.slice(2);
assert.ok(sessionFile && listFile && output && (mode === "baseline" || mode === "repaired"));
const root = resolve(sourceRoot ?? fileURLToPath(new URL("../../../../", import.meta.url)));
const load = (path: string) => import(pathToFileURL(resolve(root, path)).href);
const { TestHost } = await load("core/conductor/testhost.ts");
const { linearize, wireToBlock } = await load("core/wire.ts");
const { TaskfoldConductor, scanTaskSpans } = await load("conductors/in-process/taskfold/taskfold.ts");
const { VerdictLedger, verdictsOf, unfoldStatesOf } = await load("conductors/in-process/taskfold/verdicts.ts");
const { resolveRecall } = await load("core/agentView.ts");
const { foldCode } = await load("core/digest.ts");
const { parseListFile, toListFile } = await load("extension/taskSchema.ts");
const { workingSet } = await load("extension/taskPins.ts");
const { estTokens } = await load("core/tokens.ts");
const { transcriptSource, spanTokens } = await load("extension/tui/taskTranscript.ts");
const { dumpDocument, renderDump, DUMP_FORMATS, FORMAT_EXTENSION } = await load("extension/tui/transcriptDump.ts");
const digest = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const inputs = [sessionFile, listFile, ...(legacyFile ? [legacyFile] : [])];
const before = inputs.map(digest);
const raw = readFileSync(sessionFile, "utf8");
for (const line of raw.trim().split("\n")) JSON.parse(line);
const entries = parseSessionEntries(raw).filter((entry) => entry.type !== "session");
const messages: PiMessage[] = buildSessionContext(entries).messages;
const listInput: unknown = JSON.parse(readFileSync(listFile, "utf8"));
assert.ok(listInput && typeof listInput === "object" && "slug" in listInput && typeof listInput.slug === "string");
const listResult = parseListFile(listInput, listInput.slug);
assert.ok(listResult.ok, "Current list must validate");
const list = listResult.list;
let historicalRoundTrip: { tasks: number; depth: number; identitiesPreserved: boolean; goalTakenFromCurrentList: boolean } | null = null;
if (mode === "repaired" && legacyFile) {
	const backup = JSON.parse(readFileSync(legacyFile, "utf8"));
	const goalTakenFromCurrentList = !backup.goal;
	assert.ok(!goalTakenFromCurrentList || list.goal, "A missing historical goal requires an explicitly authored current goal");
	const original = parseListFile(goalTakenFromCurrentList ? { ...backup, goal: list.goal } : backup, list.slug);
	assert.ok(original.ok, "Legacy backup must load");
	const migrated = parseListFile(toListFile(original.list), list.slug);
	assert.ok(migrated.ok, "Migrated backup must remain readable");
	assert.ok(JSON.stringify(original.list.tasks) === JSON.stringify(migrated.list.tasks), "Migration must preserve every task fact and identity");
	historicalRoundTrip = { tasks: migrated.list.tasks.length, depth: Math.max(...migrated.list.tasks.map((t: { id: string }) => t.id.split(".").length)), identitiesPreserved: true, goalTakenFromCurrentList };
}
mkdirSync(output, { recursive: true });
const leafs = (nodes: DumpNode[]): DumpNode[] => nodes.flatMap((n) => n.kind === "task" && !n.folded ? leafs(n.children) : [n]);
const results = [];
for (const budget of [272_000, 100_000]) {
	const started = performance.now();
	const ledger = new VerdictLedger();
	ledger.reset(verdictsOf(entries), null, unfoldStatesOf(entries));
	const host = new TestHost({ meta: { format: "pi", title: "Read-only replay", cwd: "", model: "" },
		blocks: linearize(messages).map(wireToBlock), lineCount: entries.length, skipped: 0 });
	host.setWireAttached(true); host.setBudget(budget); host.setProtect(10_000);
	const conductor = new TaskfoldConductor({}, ledger);
	conductor.attach(host);
	await host.resync();
	for (let i = 0; i < 32; i++) {
		const rev = host.stats().rev;
		await host.commitTurn();
		if (host.stats().rev === rev) break;
		assert.ok(i < 31, "Replay must settle within bounded epochs");
	}
	assert.equal(host.completeLog.length, 0); assert.equal(host.classifyLog.length, 0);
	assert.equal(messages.at(-1)?.role, "assistant", "This historical snapshot ends after the assistant; its suffix is cached, not appended");
	const suffix = workingSet(list, resolve(listFile, "../../.."), "inline");
	const src = transcriptSource(host.truth, (id: string) => ledger.get(id), ledger.threshold, { lists: [list],
		workingSet: { text: suffix, tokens: host.truth.calTokens(estTokens(suffix)), applied: false, targetRole: null } });
	const spans = scanTaskSpans(src.blocks, (b: { text: string }) => b.text);
	const target = spans.find((s: { id: string }) => s.id === "3.4.1");
	assert.ok(target, "Historical late child must be present");
	const stats = host.stats();
	const doc: DumpDoc = dumpDocument({ source: src, meta: { sessionId: "read-only-replay", model: "uncalibrated" },
		system: null, totals: { full: stats.fullTokens, live: stats.liveTokens, budget }, generatedAt: new Date(0) });
	const recovered = resolveRecall(host.truth, [foldCode(`t:${target.key}`)]);
	const metrics = { budget, messages: messages.length, blocks: src.blocks.length, spans: spans.length,
		full: stats.fullTokens, live: stats.liveTokens, groups: host.groups().filter((g: { folded: boolean }) => g.folded).length,
		target: spanTokens(src, target), targetRecallable: recovered.restored.length > 0,
		elapsedMs: Math.round(performance.now() - started), carrierCount: 0, exportedLive: 0, checks: [] as string[] };
	if (mode === "repaired") {
		const carriers = host.truth.projectContext();
		const actual = linearize(host.truth.serializeWire(messages)).map((b: { text: string }) => b.text);
		const projected = carriers.filter((p: { text: string | null }) => p.text !== null).map((p: { text: string }) => p.text);
		if (JSON.stringify(actual) !== JSON.stringify(projected)) console.error(JSON.stringify({ budget, actual: actual.length, projected: projected.length,
			firstMismatch: actual.findIndex((text: string, i: number) => text !== projected[i]) }));
		assert.ok(JSON.stringify(actual) === JSON.stringify(projected), "Carrier text/order must match actual serializeWire output");
		const ids = doc.wire.flatMap((n) => n.kind === "group" ? [...n.memberIds] : [n.block.id, ...(n.result ? [n.result.id] : [])]);
		assert.equal(new Set(ids).size, src.blocks.length); assert.equal(ids.length, src.blocks.length);
		const tree = leafs([...doc.orientation, ...doc.body, ...doc.tail]);
		assert.equal(tree.length, doc.wire.length); assert.equal(new Set(tree).size, tree.length);
		assert.equal(tree.reduce((n, x) => n + x.tokens.full, 0), stats.fullTokens);
		assert.equal(tree.reduce((n, x) => n + x.tokens.live, 0), stats.liveTokens);
		assert.equal(doc.wire.reduce((n, x) => n + x.tokens.live, 0), stats.liveTokens);
		if (budget === 100_000) assert.ok(metrics.targetRecallable, "Pressure must recoverably fold the stranded late child");
		for (const format of DUMP_FORMATS) writeFileSync(resolve(output, `${budget}${FORMAT_EXTENSION[format]}`), renderDump(doc, format), { flag: "wx", mode: 0o600 });
		assert.equal(doc.metadata.task_lists[0].goal, list.goal);
		assert.ok(doc.metadata.block_details.length > 0, "Structured task result details must survive export");
		assert.equal(doc.workingSet?.text, suffix); assert.equal(doc.workingSet?.applied, false);
		metrics.carrierCount = doc.wire.length;
		metrics.exportedLive = tree.reduce((n, x) => n + x.tokens.live, 0);
		metrics.checks = ["actual-wire-text-and-order", "each-block-once", "each-leaf-once", "full-and-live-additive", "metadata-present", "cached-working-set-explicit"];
	}
	conductor.detach();
	results.push(metrics);
}
assert.deepEqual(inputs.map(digest), before, "Original input bytes must remain unchanged");
const report = { mode, calibration: "none: synthetic snapshot replay, not historical provider receipts", system: "host prompt intentionally excluded; runtime materialization and provider receipts are not recreated", historicalRoundTrip, originalsUnchanged: true, externalModelCalls: 0, results };
writeFileSync(resolve(output, "report.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
