// Replays a Pi session JSONL through a real Truth + TaskfoldConductor.
// Usage: bun replay.ts <session.jsonl> <budget> <protect> [none|cal|fixk]  (env: KEEP=keepRecentTasks, K=fixed calibration, DEBUG=<task id>)
import { readFileSync } from "node:fs";
import { TestHost } from "../../../../core/conductor/testhost";
import { TaskfoldConductor, scanTaskSpans } from "../../../../conductors/in-process/taskfold/taskfold";
import { linearize, wireToBlock, type PiMessage } from "../../../../core/wire";

const [file, budgetArg, protectArg, mode] = process.argv.slice(2);
const budget = Number(budgetArg ?? 272000), protect = Number(protectArg ?? 20000);
const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const host = new TestHost();
host.setBudget(budget);
host.setProtect(protect);
if (mode === "fixk") host.truth.setCalibration(Number(process.env.K ?? 1.7), 0);
const c = mode === "none" ? null : new TaskfoldConductor({ keepRecentTasks: Number(process.env.KEEP ?? 1) });
c?.attach(host);
const msgs: PiMessage[] = [];
let n = 0, turn = 0;
const out: string[] = [];
for (let j = 0; j < lines.length; j++) {
	const e = lines[j];
	if (e.type !== "message") continue;
	const m = e.message as PiMessage;
	if ((m as any).role === "system") continue;
	if (m.role === "assistant") {
		// the request for this assistant message departs now
		await host.departWire();
		const s = host.stats();
		const u = (m as any).usage ?? {};
		const real = (u.input ?? 0) + (u.cacheRead ?? 0) + (String((m as any).provider).startsWith("synthetic") && u.cacheWrite === u.input ? 0 : (u.cacheWrite ?? 0));
		const est = host.truth.liveTokens?.() ?? 0;
		if (mode === "cal" && real > 0 && (m as any).stopReason !== "error" && (m as any).stopReason !== "aborted") {
			const blocks = host.truth.blocks; const lastOrder = blocks.length ? blocks[blocks.length - 1].order : null;
			const raw = host.stats().liveTokens / host.truth.calibration; 
			if (lastOrder !== null) host.truth.setCalibration(real / raw, lastOrder);
		}
		out.push(`k=${host.truth.calibration.toFixed(2)}\t` + `${j}\t${s.liveTokens}\t${s.fullTokens}\t${host.groups().length}\t${(m as any).provider}\t${(u.input ?? 0) + (u.cacheRead ?? 0)}`);
	}
	msgs.push(m);
	const all = linearize(msgs);
	const fresh = all.slice(n).map(wireToBlock);
	n = all.length;
	if (fresh.length) host.appendBlocks(fresh);
	if (mode === "fixk") host.truth.setCalibration(Number(process.env.K ?? 1.7));
	if (m.role === "assistant") await host.commitTurn(++turn);
}
console.log("line\tlive\tfull\tgroups\tprovider\treported");
console.log(out.join("\n"));
console.error(host.statusLog.slice(-8).map((s) => s.text).join("\n"));
// diagnostics: live mass by span category at the end
const blocks = host.blocks();
const spans = scanTaskSpans(blocks, (b) => host.textOf(b.id) ?? "");
const k = host.truth.calibration;
const live = (b: any) => (b.folded || b.grouped ? 0 : b.tokens);
const cat = new Map<string, number>();
const groupedIds = new Set(host.groups().filter((g) => g.folded).flatMap((g) => g.memberIds));
blocks.forEach((b, i) => {
	if (groupedIds.has(b.id)) { cat.set("in folded groups (raw)", (cat.get("in folded groups (raw)") ?? 0) + b.tokens); return; }
	const inner = spans.filter((s) => s.start <= i && i <= s.end).sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
	const key = inner ? `${inner.status ?? "OPEN"} ${inner.id}` : `outside:${b.kind}`;
	cat.set(key, (cat.get(key) ?? 0) + (b.folded ? b.foldedTokens : b.tokens));
});
console.error("calibration", k.toFixed(2), "stats", JSON.stringify(host.stats()));
for (const [kk, v] of [...cat].sort((a, b) => b[1] - a[1])) console.error(kk.padEnd(30), v);
console.error("groups:", host.groups().map((g) => (g.summary ?? "").slice(0, 70)).join("\n  "));
if (process.env.DEBUG && c) {
	const bl = host.blocks();
	const sp = c.spans(bl);
	const s = sp.find((x) => x.id === process.env.DEBUG)!;
	console.error("span", s.id, s.start, s.end, s.status);
	const members = bl.slice(s.start, s.end + 1);
	console.error("protected", members.filter((b) => b.protected).length, "held", members.filter((b) => b.held).length, "system", members.filter((b) => b.kind === "system").length, "user", members.filter((b) => b.kind === "user").map((b) => b.id));
	const gOf = new Map<string, string>(); for (const g of host.groups()) for (const id of g.memberIds) gOf.set(id, g.summary?.slice(0, 60) ?? g.id);
	console.error("grouped members", [...new Set(members.map((b) => gOf.get(b.id)).filter(Boolean))]);
	console.error("unit", JSON.stringify((c as any).unit(host, bl, s, sp.filter((o) => o !== s && s.start <= o.start && o.end <= s.end)))?.slice(0, 300));
}
