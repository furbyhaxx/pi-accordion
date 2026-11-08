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
const { expand } = await import("./expand.ts");
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
console.log(JSON.stringify({ cut, msgs: messages.length, before: before.liveTokens, after: after.liveTokens, groups: host.groups().length }));
console.log(host.statusLog.slice(-6).map((s: any) => s.text).join("\n"));
const blocks = host.blocks();
const spans = scanTaskSpans(blocks, (b: any) => host.textOf(b.id) ?? "");
const grouped = new Set(host.groups().filter((g: any) => g.folded).flatMap((g: any) => g.memberIds));
const mass = new Map<string, number>();
blocks.forEach((b: any, i: number) => {
  if (grouped.has(b.id)) return;
  const inner = spans.filter((s: any) => (s.intervals ?? [{start: s.start, end: s.end}]).some((v: any) => (v.start ?? v[0]) <= i && i <= (v.end ?? v[1]))).sort((a: any, b: any) => b.id.split(".").length - a.id.split(".").length)[0];
  const key = inner ? `${inner.status ?? "OPEN"} ${inner.id}` : `outside`;
  mass.set(key, (mass.get(key) ?? 0) + b.tokens);
});
console.log([...mass].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, v]) => `${k}\t${v}`).join("\n"));
