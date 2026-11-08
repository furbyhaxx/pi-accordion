import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const root = process.env.ROOT!;
const load = (p: string) => import(pathToFileURL(resolve(root, p)).href);
const { buildSessionContext, parseSessionEntries } = await import(pathToFileURL(resolve(root, "node_modules/@earendil-works/pi-coding-agent/dist/index.js")).href).catch(() => import("@earendil-works/pi-coding-agent"));
const { TestHost } = await load("core/conductor/testhost.ts");
const { linearize, wireToBlock } = await load("core/wire.ts");
const { TaskfoldConductor, scanTaskSpans } = await load("conductors/in-process/taskfold/taskfold.ts");
const [file, cutArg, budgetArg] = process.argv.slice(2);
const lines = readFileSync(file, "utf8").trim().split("\n");
const cut = Number(cutArg);
const entries = parseSessionEntries(lines.slice(0, cut).join("\n")).filter((e: any) => e.type !== "session");
const { expand } = await import("./session-replay/expand.ts");
let messages = process.env.EXPAND ? expand(buildSessionContext(entries).messages) : buildSessionContext(entries).messages;
// ADOPT=<tasks dir>: overlay the events `/accordion tasks adopt` derives (extension/taskAdoption.ts).
if (process.env.ADOPT) {
  const { deriveAdoption, applyAdoption } = await load("extension/taskAdoption.ts");
  const { parseListFile } = await load("extension/taskSchema.ts");
  const { readdirSync } = await import("node:fs");
  const lists = new Map();
  for (const f of readdirSync(process.env.ADOPT)) if (f.endsWith(".json")) {
    const parsed = parseListFile(JSON.parse(readFileSync(resolve(process.env.ADOPT, f), "utf8")), f.slice(0, -5), { requireGoal: false });
    if (parsed.ok) lists.set(parsed.list.slug, parsed.list.tasks);
  }
  const adoption = deriveAdoption(messages, lists);
  console.log(JSON.stringify({ adoption: adoption.stats }));
  messages = applyAdoption(messages, adoption);
}
const host = new TestHost({ meta: { format: "pi", title: "probe", cwd: "", model: "" }, blocks: linearize(messages).map(wireToBlock), lineCount: entries.length, skipped: 0 });
host.setWireAttached?.(true); host.setBudget(Number(budgetArg ?? 272000)); host.setProtect(20000);
const before = host.stats();
const c = new TaskfoldConductor({});
c.attach(host);
await host.commitTurn(1);
await host.departWire?.();
const after = host.stats();
import { writeFileSync, mkdirSync } from "node:fs";
const { foldCode } = await load("core/digest.ts");
const { resolveRecall } = await load("core/agentView.ts");
const outDir = process.env.OUT!;
mkdirSync(outDir, { recursive: true });

const wire = host.truth.serializeWire(messages as any) as any[];
const text = (c: any) => typeof c === "string" ? c : (c ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n");
const out: any[] = [];
for (const m of wire) {
  if (m.role === "user") out.push({ role: "user", content: text(m.content).slice(0, 60000) || "(empty)" });
  else if (m.role === "assistant") {
    const calls = (m.content ?? []).filter((p: any) => p.type === "toolCall");
    const o: any = { role: "assistant", content: text(m.content) || null, reasoning_content: "" };
    if (calls.length) o.tool_calls = calls.map((c: any) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) } }));
    out.push(o);
  } else if (m.role === "toolResult") out.push({ role: "tool", tool_call_id: m.toolCallId, content: text(m.content).slice(0, 60000) });
}
const answered = new Set(out.filter((m) => m.role === "tool").map((m) => m.tool_call_id));
const called = new Set<string>();
let msgs: any[] = [];
for (const m of out) {
  if (m.role === "assistant") {
    const tcs = (m.tool_calls ?? []).filter((t: any) => answered.has(t.id));
    tcs.forEach((t: any) => called.add(t.id));
    if (!tcs.length && !(m.content ?? "").trim()) continue;
    const o = { ...m }; if (tcs.length) o.tool_calls = tcs; else delete o.tool_calls; msgs.push(o);
  } else if (m.role === "tool") { if (called.has(m.tool_call_id)) msgs.push(m); } else msgs.push(m);
}
const merged: any[] = [];
for (const m of msgs) { if (merged.length && m.role === "user" && merged[merged.length - 1].role === "user") merged[merged.length - 1].content += "\n\n" + m.content; else merged.push(m); }

const rawBlocks = linearize(messages as any).map(wireToBlock);
const spans = scanTaskSpans(rawBlocks as any, (b: any) => b.text) as any[];
const fin = spans.filter((s) => ["done", "failed", "abandoned"].includes(s.status));
const doing = spans.filter((s) => !["done", "failed", "abandoned"].includes(s.status ?? ""));
const idOf = (s: any) => s.id as string;
const parentOf = (s: any) => spans.find((o) => s.id.startsWith(o.id + ".") && !spans.some((p) => p !== o && p.id.startsWith(o.id + ".") && s.id.startsWith(p.id + ".")));
const chain = (s: any) => { const r: string[] = []; for (let x = s; x; x = parentOf(x)) r.push(foldCode(`t:${x.key}`)); return r; };
const rng = (() => { let a = 7; return () => (a = (a * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; })();
const pick = <T,>(xs: T[]) => xs[Math.floor(rng() * xs.length)];
const leaf = [...doing].sort((a, b) => b.id.split(".").length - a.id.split(".").length)[0];
const deepDone = fin.filter((s) => parentOf(s));
const pool = deepDone.length ? deepDone : fin;
const verified = pool.filter((s) => (s.report?.outcome ?? "").length > 0);
const probes: any[] = [];
if (leaf) probes.push({ kind: "current", q: "Which task are you working on right now, and what is its parent task? Give the ids.", gold: { leaf: idOf(leaf), parent: parentOf(leaf)?.id ?? "" } });
if (pool.length) { const x = pick(pool); probes.push({ kind: "status", q: `Did task "${x.title}" get finished, and what was its outcome? Answer briefly.`, gold: { key: x.key, status: x.status, outcome: x.report?.outcome ?? "", codes: chain(x) } }); }
if (verified.length) { const x = pick(verified); probes.push({ kind: "recall", q: `Show me the exact output of the checks you ran for task "${x.title}".`, gold: { key: x.key, codes: chain(x), own: foldCode(`t:${x.key}`) } }); }
if (leaf) probes.push({ kind: "continue", q: "Continue.", gold: { finished: fin.map(idOf), doing: doing.map(idOf) } });
if (pool.length) { const x = pick(pool); probes.push({ kind: "place", q: `Task "${x.title}" needs one follow-up check. Add it as a new subtask of the same parent task that "${x.title}" belongs to, right after it.`, gold: { parent: parentOf(x)?.id ?? "", after: x.id, codes: chain(x) } }); }

const wireText = JSON.stringify(merged);
const codes = [...new Set([...wireText.matchAll(/\{#([0-9a-z]{6}) FOLDED\}/g)].map((m) => m[1]).concat(fin.map((s) => foldCode(`t:${s.key}`))))];
const recalls: Record<string, string> = {};
for (const c of codes) { const r = resolveRecall(host.truth, [c]); if (!r.missing.length) recalls[c] = r.restored.map((x: any) => x.text).join("\n\n").slice(0, 60000); }
const listing = { ok: true, tasks: spans.map((s) => ({ id: s.id, title: s.title, status: fin.includes(s) ? s.status : "doing" })) };
const name = `ctx-real-${cut}-REAL.json`;
writeFileSync(`${outDir}/${name}`, JSON.stringify({ session: "01a1b680", cut, rep: "REAL", messages: merged, probes, listing, recalls }));
console.log(JSON.stringify({ cut, msgs: merged.length, tokensApprox: Math.round(wireText.length / 4), live: after.liveTokens, probes: probes.length, codes: codes.length, recallable: Object.keys(recalls).length }));
