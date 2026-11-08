// Replays a session prefix by prefix through the real Taskfold conductor and prints the folded
// carriers at every cut: ROOT=<repo> bun sweep.ts <session.jsonl> <budget> <protect>
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const root = process.env.ROOT!;
const load = (p: string) => import(pathToFileURL(resolve(root, p)).href);
const { buildSessionContext, parseSessionEntries } = await import(pathToFileURL(resolve(root, "extension/node_modules/@earendil-works/pi-coding-agent/dist/index.js")).href);
const { TestHost } = await load("core/conductor/testhost.ts");
const { linearize, wireToBlock } = await load("core/wire.ts");
const { TaskfoldConductor } = await load("conductors/in-process/taskfold/taskfold.ts");
const [file, budget, protect] = process.argv.slice(2);
const lines = readFileSync(file, "utf8").trim().split("\n");
let last = "";
for (let cut = 3; cut <= lines.length; cut++) {
  const entries = parseSessionEntries(lines.slice(0, cut).join("\n")).filter((e: any) => e.type !== "session");
  const messages = buildSessionContext(entries).messages;
  if (!messages.length || messages[messages.length - 1].role === "assistant") continue;
  const host = new TestHost({ meta: { format: "pi", title: "sweep", cwd: "", model: "" }, blocks: linearize(messages).map(wireToBlock), lineCount: entries.length, skipped: 0 });
  host.setWireAttached?.(true); host.setBudget(Number(budget)); host.setProtect(Number(protect));
  const c = new TaskfoldConductor({});
  c.attach(host);
  await host.commitTurn(1);
  await host.departWire?.();
  const groups = host.groups().filter((g: any) => g.folded).map((g: any) => `${g.summary?.slice(0, 7)}${(g.summary ?? "").includes('"history"') ? " H" : (g.summary ?? "").includes('"task"') ? " R" : " ?"}[${g.memberIds.length}]`);
  const line = `msgs=${messages.length} live=${host.stats().liveTokens} ${groups.join(" ")}`;
  if (line.replace(/msgs=\d+ /, "") !== last.replace(/msgs=\d+ /, "")) console.log(line);
  last = line;
}
