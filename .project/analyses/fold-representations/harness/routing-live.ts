// Live check of the shipped extractor: real prompt, real parser, real store, DeepSeek flash.
// Usage: bun routing-live.ts <corpus.json> <out-dir> [reps]; then: python3 routing_live_score.py <out-dir>
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PIN_LIMITS } from "../../../../extension/taskPins";
import { applyRoutedOps, EXTRACT_SYSTEM, extractionPrompt, parseExtraction } from "../../../../extension/taskRouting";
import { TaskStore, runTasks, runTasksTracked } from "../../../../extension/tasks";

const [corpusPath, outDir, repsArg] = process.argv.slice(2);
const reps = Number(repsArg ?? 1);
const key = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".pig/agent/auth.json"), "utf8")).deepseek.key as string;
const corpus = JSON.parse(fs.readFileSync(corpusPath!, "utf8")) as { id: string; list: any; last: string; msg: string }[];
fs.mkdirSync(outDir!, { recursive: true });

function build(item: { list: any }): { store: TaskStore; dir: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "route-live-"));
	fs.mkdirSync(path.join(dir, "docs"));
	fs.writeFileSync(path.join(dir, "docs/spec.md"), "# Spec\n\n## Interface\nget/set/delete\n");
	fs.writeFileSync(path.join(dir, "docs/security.md"), "# Security\n\n## Key handling\nnever log secrets\n");
	const store = new TaskStore(dir, () => "live");
	const l = item.list;
	const roots = l.tasks.filter((t: any) => !t.id.includes("."));
	const kids = (id: string) => l.tasks.filter((t: any) => t.id.startsWith(`${id}.`) && t.id.split(".").length === id.split(".").length + 1);
	const node = (t: any): any => ({ title: t.title, ...(t.criteria?.length ? { acceptanceCriteria: t.criteria.map((c: any) => c.text) } : {}), ...(kids(t.id).length ? { subtasks: kids(t.id).map(node) } : {}) });
	runTasks(store, { action: "create", list: l.list, title: l.title, goals: l.goals, tasks: roots.map(node) });
	for (const p of l.pins ?? []) runTasksTracked(store, { action: "pin", list: l.list, items: [{ kind: p.kind, text: p.text, source: "user" }] }, [p.text]);
	for (const t of l.tasks) for (const a of t.attachments ?? []) {
		const [file, section] = String(a.ref).split("#");
		runTasks(store, { action: "attach", list: l.list, id: t.id, items: [{ path: file, section }] });
	}
	const done = l.tasks.filter((t: any) => t.status === "done").map((t: any) => t.id);
	const doing = l.tasks.filter((t: any) => t.status === "doing").map((t: any) => t.id);
	for (const id of l.tasks.map((t: any) => t.id)) {
		if (done.includes(id) && !kids(id).length) { runTasks(store, { action: "start", list: l.list, id }); runTasks(store, { action: "complete", list: l.list, id, report: { outcome: "done" } }); }
	}
	for (const id of l.tasks.map((t: any) => t.id)) {
		if (done.includes(id) && kids(id).length && store.read(l.list).tasks.find((t) => t.id === id)?.status !== "done") runTasks(store, { action: "complete", list: l.list, id, report: { outcome: "done" } });
	}
	for (const id of doing.filter((i: string) => !kids(i).length)) runTasks(store, { action: "start", list: l.list, id });
	return { store, dir };
}

async function post(body: unknown): Promise<any> {
	let err = "";
	for (let k = 0; k < 4; k++) {
		try {
			const r = await fetch("https://api.deepseek.com/chat/completions", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: "deepseek-flash", ...(body as object) }) });
			if (r.ok) return await r.json();
			err = (await r.text()).slice(0, 300);
		} catch (e) { err = String(e); }
		await new Promise((r) => setTimeout(r, 5000 * (k + 1)));
	}
	return { error: err };
}

async function runItem(item: (typeof corpus)[number], rep: number): Promise<void> {
	const file = path.join(outDir!, `res-${item.id}-${rep}.json`);
	if (fs.existsSync(file)) return;
	const { store, dir } = build(item);
	const slug = item.list.list;
	const reply = await post({ messages: [{ role: "system", content: EXTRACT_SYSTEM }, { role: "user", content: extractionPrompt(store.read(slug), item.last, item.msg) }], response_format: { type: "json_object" }, max_tokens: 4000 });
	const text = reply.choices?.[0]?.message?.content as string | undefined;
	const out: Record<string, unknown> = { id: item.id, usage: reply.usage ?? {} };
	if (!text) Object.assign(out, { error: String(reply.error ?? "no content"), B: [], applied: [], dropped: [], rejected: [] });
	else {
		try {
			const ex = parseExtraction(text);
			const r = await applyRoutedOps(store, slug, ex.ops, item.msg, PIN_LIMITS);
			Object.assign(out, { B: ex.ops, rejected: ex.rejected, applied: r.applied, dropped: r.dropped });
		} catch (e) { Object.assign(out, { error: String(e), B: [], applied: [], dropped: [], rejected: [] }); }
	}
	fs.rmSync(dir, { recursive: true, force: true });
	fs.writeFileSync(file, JSON.stringify(out));
}

const jobs = Array.from({ length: reps }, (_, r) => corpus.map((it) => [it, r] as const)).flat();
let next = 0;
await Promise.all(Array.from({ length: 8 }, async () => { for (;;) { const j = jobs[next++]; if (!j) return; await runItem(j[0], j[1]); } }));
fs.writeFileSync(path.join(outDir!, "corpus.json"), JSON.stringify(corpus));
console.log(`${jobs.length} runs written to ${outDir}`);
