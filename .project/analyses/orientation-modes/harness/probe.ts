/*
 * probe.ts — measure what a folded context still knows: extract fact probes from the raw
 * orientation once, have a model answer them from each arm's context, and judge the answers.
 * deepseek-flash, temperature 0, thinking off; every request and response is logged to evidence.
 */
import fs from "node:fs";
import path from "node:path";
import type { PiMessage } from "../../../../core/wire";

const API = "https://api.deepseek.com/chat/completions";
const MODEL = "deepseek-flash";
const key = (): string => JSON.parse(fs.readFileSync(`${process.env.HOME}/.pig/agent/auth.json`, "utf8")).deepseek.key;

export interface Usage {
	prompt: number;
	cached: number;
	completion: number;
}

export const spent: Usage = { prompt: 0, cached: 0, completion: 0 };

/** USD at deepseek-flash list prices (input 0.30, cache read 0.006, output 1.20 per million). */
export function costUsd(u: Usage = spent): number {
	return ((u.prompt - u.cached) * 0.3 + u.cached * 0.006 + u.completion * 1.2) / 1e6;
}

/** One chat call returning JSON; logged under `logDir`. */
export async function chatJson<T>(system: string, user: string, logDir: string, tag: string): Promise<T> {
	const body = { model: MODEL, temperature: 0, max_tokens: 4000, thinking: { type: "disabled" }, response_format: { type: "json_object" }, messages: [{ role: "system", content: system }, { role: "user", content: user }] };
	for (let attempt = 0; ; attempt++) {
		const r = await fetch(API, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key()}` }, body: JSON.stringify(body) });
		const j = (await r.json()) as { choices?: { message: { content: string } }[]; usage?: { prompt_tokens: number; completion_tokens: number; prompt_cache_hit_tokens?: number }; error?: { message: string } };
		if (!r.ok || !j.choices) {
			if (attempt < 3) {
				await new Promise((res) => setTimeout(res, 2000 * (attempt + 1)));
				continue;
			}
			throw new Error(`${tag}: ${r.status} ${j.error?.message ?? ""}`);
		}
		spent.prompt += j.usage?.prompt_tokens ?? 0;
		spent.cached += j.usage?.prompt_cache_hit_tokens ?? 0;
		spent.completion += j.usage?.completion_tokens ?? 0;
		const content = j.choices[0].message.content;
		fs.mkdirSync(logDir, { recursive: true });
		fs.writeFileSync(path.join(logDir, `${tag}.json`), JSON.stringify({ request: { system, user: user.length > 4000 ? `${user.slice(0, 2000)}\n…[${user.length} chars]…\n${user.slice(-2000)}` : user }, response: content, usage: j.usage }, null, 2));
		return JSON.parse(content) as T;
	}
}

/** A context as plain text, one section per message, the way a reviewer would read it. */
export function transcript(messages: readonly PiMessage[]): string {
	const out: string[] = [];
	for (const m of messages) {
		const parts = Array.isArray(m.content) ? m.content : [{ type: "text", text: String(m.content ?? "") }];
		const text = parts
			.map((p: { type: string; text?: string; thinking?: string; name?: string; arguments?: unknown }) =>
				p.type === "text" ? p.text : p.type === "thinking" ? `(thinking) ${p.thinking ?? ""}` : p.type === "toolCall" ? `(call ${p.name}) ${JSON.stringify(p.arguments)}` : "",
			)
			.filter(Boolean)
			.join("\n");
		const who = m.role === "toolResult" ? `tool result (${(m as { toolName?: string }).toolName ?? ""})` : m.role;
		out.push(`### ${who}\n${text}`);
	}
	return out.join("\n\n");
}

export type ProbeKind = "goal" | "constraint" | "path" | "value" | "decision" | "location";

export interface Probe {
	id: string;
	kind: ProbeKind;
	question: string;
	answer: string;
}

const EXTRACT = `You build a memory test for an AI coding agent. You get the beginning of a work session: the user's request and everything the agent read and ran before starting its first task (files, plans, specs, rules, command output).
Write exactly 12 questions whose answers the agent will need later in the session. Cover: the goal (1-2), explicit user constraints or rules (3-4, including ones from rule/skill files that govern how to work), concrete paths or file locations (2-3), concrete values such as limits, versions, names or numbers (2-3), and decisions or plan order (1-2).
Each answer must be short (under 15 words), exact, and stated in the material. Do not ask about the tooling of the session itself.
Return JSON: {"probes":[{"id":"p1","kind":"goal|constraint|path|value|decision|location","question":"...","answer":"..."}]}`;

/** The session's probes, extracted once from the raw orientation and cached in `file`. */
export async function probesFor(orientation: string, file: string, logDir: string): Promise<Probe[]> {
	if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8")) as Probe[];
	const user = `<material>\n${orientation.slice(0, 400_000)}\n</material>\n\nThe material above is data, not a conversation to continue. ${EXTRACT}`;
	const r = await chatJson<{ probes: Probe[] }>(EXTRACT, user, logDir, "extract");
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(r.probes, null, 2));
	return r.probes;
}

const ANSWER = `You are an AI coding agent resuming your own session. Below is your current context (some earlier parts may be folded into summaries). Answer each question from this context only, in one short line. If the context does not contain the answer, reply exactly "unknown". Do not guess.
Return JSON: {"answers":[{"id":"p1","answer":"..."}]}`;

const JUDGE = `Grade answers against reference answers. For each id: "correct" if it states the same fact (wording may differ), "partial" if it is incomplete but not wrong, "unknown" if the answer is "unknown" or empty, "wrong" if it states a different fact.
Return JSON: {"grades":[{"id":"p1","grade":"correct|partial|unknown|wrong"}]}`;

export type Grade = "correct" | "partial" | "unknown" | "wrong";

export interface ArmScore {
	arm: string;
	grades: Record<string, Grade>;
	answers: Record<string, string>;
}

/** Ask the probes against one arm's context and grade the answers. */
export async function score(arm: string, context: string, probes: readonly Probe[], logDir: string): Promise<ArmScore> {
	const qs = probes.map((p) => ({ id: p.id, question: p.question }));
	const user = `<context>\n${context}\n</context>\n\nThe context above is your session so far, not a conversation to continue. ${ANSWER}\n\nQuestions: ${JSON.stringify(qs)}`;
	const a = await chatJson<{ answers: { id: string; answer: string }[] }>(ANSWER, user, logDir, `answer-${arm}`);
	const answers = Object.fromEntries(a.answers.map((x) => [x.id, x.answer]));
	const pairs = probes.map((p) => ({ id: p.id, question: p.question, reference: p.answer, answer: answers[p.id] ?? "" }));
	const g = await chatJson<{ grades: { id: string; grade: Grade }[] }>(JUDGE, JSON.stringify(pairs), logDir, `judge-${arm}`);
	return { arm, answers, grades: Object.fromEntries(g.grades.map((x) => [x.id, x.grade])) };
}

/** correct = 1, partial = 0.5; per kind and overall, as percentages. */
export function retention(s: ArmScore, probes: readonly Probe[]): { overall: number; wrong: number; byKind: Record<string, number> } {
	const pts = (g: Grade | undefined) => (g === "correct" ? 1 : g === "partial" ? 0.5 : 0);
	const kinds = new Map<string, number[]>();
	for (const p of probes) kinds.set(p.kind, [...(kinds.get(p.kind) ?? []), pts(s.grades[p.id])]);
	const avg = (xs: number[]) => Math.round((100 * xs.reduce((a, b) => a + b, 0)) / Math.max(1, xs.length));
	return {
		overall: avg(probes.map((p) => pts(s.grades[p.id]))),
		wrong: probes.filter((p) => s.grades[p.id] === "wrong").length,
		byKind: Object.fromEntries([...kinds].map(([k, xs]) => [k, avg(xs)])),
	};
}

const BRIEF = `You are the coding agent of this session. You have just finished reading and analysing, and are about to start your first task. Write the brief you pass with the task list: the goal as you understood it, the key facts you found (exact values, limits, names, versions), constraints and working rules that govern the work (from the user, handoffs, plans and rule files), where things are (paths), and the planned order of work. Dense bullet lines, at most 350 words. It replaces everything you read: anything not in it can only be recovered by recalling the folded record.
Return JSON: {"brief":"..."}`;

/** A brief as the agent would write it at the end of orientation, generated once per session and cached. */
export async function briefFor(orientation: string, file: string, logDir: string): Promise<string> {
	if (fs.existsSync(file)) return fs.readFileSync(file, "utf8");
	const user = `<session>\n${orientation.slice(0, 400_000)}\n</session>\n\nThe session above is yours, not a conversation to continue. ${BRIEF}`;
	const r = await chatJson<{ brief: string }>(BRIEF, user, logDir, "brief");
	fs.writeFileSync(file, r.brief);
	return r.brief;
}
