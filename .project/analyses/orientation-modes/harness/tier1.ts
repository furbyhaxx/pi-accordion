/*
 * tier1.ts — replay probes. For each session and cut point: build every arm's outgoing context,
 * ask the session's fact probes against it, grade, and write a results table.
 *
 *   bun .project/analyses/orientation-modes/harness/tier1.ts <session.jsonl>... [--budget 0.5] [--cap 3]
 */
import fs from "node:fs";
import path from "node:path";
import { ARMS, cutPoints, loadSession, replay } from "./replay";
import { briefFor, costUsd, probesFor, retention, score, spent, transcript } from "./probe";
import { linearize, wireToBlock } from "../../../../core/wire";
import { orientationSpan, scanTaskSpans } from "../../../../conductors/in-process/taskfold/taskfold";

const args = process.argv.slice(2);
const flag = (name: string, d: number) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? Number(args.splice(i, 2)[1]) : d;
};
const budgetFactor = flag("budget", 0.5);
const capUsd = flag("cap", 3);
const files = args;
const root = path.resolve(import.meta.dir, "..", "evidence", "tier1");

const rows: string[] = [];
for (const file of files) {
	const s = loadSession(file);
	const name = path.basename(file, ".jsonl").slice(-12);
	const blocks = linearize(s.messages).map(wireToBlock);
	const o = orientationSpan(blocks, (b) => b.text, scanTaskSpans(blocks, (b) => b.text), false);
	if (!o) {
		console.log(`${name}: no task started; skipped`);
		continue;
	}
	const orientText = blocks
		.slice(0, o.span.end + 1)
		.map((b) => `[${b.kind}${b.toolName ? ` ${b.toolName}` : ""}] ${b.text}`)
		.join("\n\n");
	const dir = path.join(root, name);
	const probes = await probesFor(orientText, path.join(dir, "probes.json"), dir);
	// The brief comes from the orientation without the probes' answers in sight: same material, separate call.
	const brief = await briefFor(orientText, path.join(dir, "brief.txt"), dir);
	for (const cut of cutPoints(s)) {
		for (const arm of ARMS) {
			if (costUsd() > capUsd) throw new Error(`spending cap $${capUsd} reached`);
			const out = path.join(dir, `result-${arm.id}-cut${cut}.json`);
			if (fs.existsSync(out)) {
				const prev = JSON.parse(fs.readFileSync(out, "utf8"));
				const kinds = Object.entries(prev.byKind as Record<string, number>).map(([k, v]) => `${k} ${v}`).join(", ");
				rows.push(`| ${name} | ${cut} | ${arm.id} | ${(prev.fullTokens / 1000).toFixed(1)}k | ${(prev.liveTokens / 1000).toFixed(1)}k | ${prev.overall} | ${prev.wrong} | ${kinds} | ${prev.cacheBreakAt ?? "–"} |`);
				continue;
			}
			const r = await replay(s, cut, arm, budgetFactor, brief);
			const sc = await score(`${arm.id}-cut${cut}`, transcript(r.wire), probes, dir);
			const ret = retention(sc, probes);
			fs.writeFileSync(out, JSON.stringify({ ...sc, ...ret, fullTokens: r.fullTokens, liveTokens: r.liveTokens, cacheBreakAt: r.cacheBreakAt, groups: r.groups.map((g) => ({ key: g.key, members: g.members, tokens: g.summary.length })) }, null, 2));
			const kinds = Object.entries(ret.byKind).map(([k, v]) => `${k} ${v}`).join(", ");
			rows.push(`| ${name} | ${cut} | ${arm.id} | ${(r.fullTokens / 1000).toFixed(1)}k | ${(r.liveTokens / 1000).toFixed(1)}k | ${ret.overall} | ${ret.wrong} | ${kinds} | ${r.cacheBreakAt ?? "–"} |`);
			console.log(rows[rows.length - 1]);
		}
	}
}
const table = ["| session | cut (msgs) | arm | full | sent | retention % | wrong | by kind % | cache break (block) |", "|---|---|---|---|---|---|---|---|---|", ...rows].join("\n");
fs.mkdirSync(root, { recursive: true });
fs.writeFileSync(path.join(root, `results-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.md`), `${table}\n\nbudget factor ${budgetFactor} · spent $${costUsd().toFixed(3)} (${spent.prompt} prompt, ${spent.cached} cached, ${spent.completion} completion tokens)\n`);
console.log(`spent $${costUsd().toFixed(3)}`);
