import { describe, it, expect } from "vitest";
import { Truth } from "./truth";
import { foldCode, foldTag } from "./digest";
import { estTokens } from "./tokens";
import { resolveUnfoldBounded } from "./agentView";
import { RECALL_POLICY, RecallAccount, SMALL_RESULT_TOKENS, isRecallResult, serveRecall } from "./recallAccount";
import { expireRecall } from "./recallExpiry";
import { guardResults } from "./resultGuard";
import type { Block } from "./types";

/*
 * SPEC-0003 §1: whatever the agent calls, retrieval cannot push the context over its budget and
 * nothing it retrieved stays that cannot be shrunk again. Random agents against the same sequence
 * of steps the extension runs (serve → land → guard → release near the budget).
 */

const META = { format: "pi" as const, title: "t", cwd: "", model: "" };
const HIGH = 0.8;
const UNFOLD_TOKENS = 20_000;
const GUARD_TOKENS = 16_000;
const KEEP_STEPS = 3;
const WORDS = ["alpha", "commit", "error", "path", "zzz-none", "entry", "17", "fold"];

function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

class Session {
	readonly truth: Truth;
	readonly account = new RecallAccount();
	readonly codes: string[] = [];
	readonly entries: number[] = [];
	private n = 0;
	private order: number;

	constructor(private readonly rand: () => number) {
		const blocks: Block[] = [this.block("u:0", "user", 0, "Do the work.")];
		const groups: string[][] = [];
		let order = 1;
		const folds = 2 + this.int(5);
		for (let f = 0; f < folds; f++) {
			const ids: string[] = [];
			// Some folds are small enough to unfold; most are far too large.
			const small = this.rand() < 0.3;
			const count = small ? 1 + this.int(3) : 1 + this.int(40);
			for (let i = 0; i < count; i++) {
				// Mostly small entries, some far larger than one call may return.
				const chars = !small && this.rand() < 0.15 ? 40_000 + this.int(160_000) : 200 + this.int(12_000);
				const kind = i % 2 ? "tool_result" : "tool_call";
				const b = this.block(`${kind === "tool_call" ? "a" : "r"}:f${f}e${i}`, kind, order++, `fold ${f} entry ${i} alpha commit ${"path error 17 ".repeat(Math.ceil(chars / 14))}`, { toolName: "bash" });
				blocks.push(b);
				ids.push(b.id);
			}
			groups.push(ids);
			this.entries.push(count);
		}
		blocks.push(this.block("u:start", "user", order++, "Next."));
		this.order = order;
		this.truth = new Truth({ meta: META, blocks, lineCount: 0, skipped: 0 });
		this.truth.setProtect(0);
		const r = this.truth.apply(groups.map((ids) => ({ kind: "group" as const, ids, summary: `${foldTag(`g:${ids[0]}`)} done` })), "auto");
		expect(r.results.every((x) => x.applied)).toBe(true);
		for (const ids of groups) this.codes.push(foldCode(`g:${ids[0]}`));
		// A budget the folded log fits in, from tight to roomy.
		this.truth.setBudget(this.truth.stats().liveTokens + 3_000 + this.int(300_000));
		this.sent();
	}

	int(n: number): number {
		return Math.floor(this.rand() * n);
	}

	private block(id: string, kind: Block["kind"], order: number, text: string, extra: Partial<Block> = {}): Block {
		return { id, kind, turn: 1, order, text, tokens: estTokens(text), override: null, autoFolded: false, by: null, ...extra };
	}

	append(kind: Block["kind"], text: string, extra: Partial<Block> = {}): Block {
		const b = this.block(`${kind === "user" ? "u" : kind === "tool_result" ? "r" : "a"}:n${this.n++}${kind === "text" || kind === "tool_call" ? ":p0" : ""}`, kind, this.order++, text, extra);
		this.truth.append([b]);
		return b;
	}

	sent(): void {
		const last = this.truth.blocks[this.truth.blocks.length - 1];
		this.truth.markSent(last.order);
	}

	/** What the `context` hook does before a request leaves. */
	request(): number {
		const clipped = guardResults(this.truth, GUARD_TOKENS);
		if (clipped.length) this.truth.apply(clipped, "auto");
		if (this.live() >= HIGH * this.truth.budget) this.release(false);
		this.sent();
		return clipped.length;
	}

	release(earlierPrompts: boolean): void {
		const ops = expireRecall(this.truth, { keepSteps: KEEP_STEPS, earlierPrompts });
		if (ops.length) this.truth.apply(ops, "auto");
	}

	live(): number {
		return this.truth.stats().liveTokens;
	}

	address(): string {
		const f = this.int(this.codes.length);
		const r = this.rand();
		if (r < 0.35) return this.codes[f];
		if (r < 0.45) return `${this.codes[f]}.entries`;
		if (r < 0.5) return "nocode";
		return `${this.codes[f]}.${1 + this.int(this.entries[f] + 2)}`;
	}

	recallArgs(): { codes: string[]; query?: string; page?: number } {
		const r = this.rand();
		const codes = r < 0.15 ? [] : Array.from({ length: 1 + this.int(this.rand() < 0.2 ? 12 : 3) }, () => this.address());
		const query = !codes.length || this.rand() < 0.3 ? Array.from({ length: 1 + this.int(2) }, () => WORDS[this.int(WORDS.length)]).join(" ") : undefined;
		const page = this.rand() < 0.4 ? 1 + this.int(60) : undefined;
		return { codes, ...(query ? { query } : {}), ...(page ? { page } : {}) };
	}
}

interface Seen { served: number; refused: number; unfolded: number; unfoldRefused: number; clipped: number }

function run(seed: number, seen: Seen): void {
	const rand = rng(seed);
	const s = new Session(rand);
	const { truth, account } = s;
	const policy = RECALL_POLICY;
	const at = (what: string) => `seed ${seed}: ${what}`;
	for (let step = 0; step < 40; step++) {
		const r = rand();
		if (r < 0.55) {
			// One assistant message with one or several recall calls; results land together.
			const calls = Array.from({ length: rand() < 0.4 ? 2 + s.int(7) : 1 }, () => s.recallArgs());
			const out: { id: string; text: string; args: object }[] = [];
			let reserved = 0;
			for (const args of calls) {
				const id = `call${seed}-${step}-${out.length}`;
				const before = s.live();
				const served = serveRecall(truth, account, id, args, () => s.release(true));
				const tokens = estTokens(served.text);
				if (served.view) {
					expect(tokens, at("one call returns at most callTokens")).toBeLessThanOrEqual(policy.callTokens);
					// `s.live()` may have dropped through the release the call triggered.
					expect(Math.min(before, s.live()) + reserved + tokens, at("a served call leaves the context within its budget")).toBeLessThanOrEqual(truth.budget);
					reserved += tokens;
					seen.served++;
				} else {
					seen.refused++;
					expect(tokens, at("a refusal carries no archive text")).toBeLessThan(SMALL_RESULT_TOKENS);
				}
				out.push({ id, text: served.text, args });
			}
			for (const c of out) s.append("tool_call", `recall ${JSON.stringify(c.args)}`, { toolName: "recall", callId: c.id });
			for (const c of out) s.append("tool_result", c.text, { toolName: "recall", callId: c.id });
			expect(account.outstanding(truth), at("recalled text standing at once")).toBeLessThanOrEqual(policy.liveTokens);
		} else if (r < 0.7) {
			const codes = Array.from({ length: 1 + s.int(4) }, () => s.codes[s.int(s.codes.length)]);
			const ceiling = HIGH * truth.budget;
			const before = s.live();
			const res = resolveUnfoldBounded(truth, codes, { maxTokens: UNFOLD_TOKENS, ceiling });
			seen.unfoldRefused += res.refused.length;
			if (res.restored.length) {
				seen.unfolded++;
				expect(s.live(), at("an unfold stays below the fold threshold")).toBeLessThan(ceiling);
				expect(s.live() - before, at("an unfold adds at most its allowance per code")).toBeLessThanOrEqual(UNFOLD_TOKENS * codes.length);
			} else {
				expect(s.live(), at("a refused unfold changes nothing")).toBe(before);
			}
			s.append("tool_result", "unfolded", { toolName: "unfold", callId: `u${step}` });
		} else if (r < 0.85) {
			// Any other tool, sometimes with a result far beyond the guard.
			const chars = rand() < 0.3 ? 80_000 + s.int(1_500_000) : 100 + s.int(8_000);
			s.append("tool_call", `bash {"command":"x"}`, { toolName: "bash", callId: `b${step}` });
			s.append("tool_result", "output line\n".repeat(Math.ceil(chars / 12)), { toolName: "bash", callId: `b${step}` });
		} else if (r < 0.93) {
			s.append("text", "Thinking about the next step.");
		} else {
			s.append("user", "Go on.");
		}
		seen.clipped += s.request();
		for (const b of truth.blocks) {
			// A new result is clipped by the guard; an archived one stands only through an unfold, within its allowance.
			if (b.kind === "tool_result" && !truth.inFoldedGroup(b.id)) expect(truth.effTokens(b), at(`no result stands above its bound (${b.id})`)).toBeLessThanOrEqual(b.id.startsWith("r:n") ? GUARD_TOKENS : UNFOLD_TOKENS);
		}
	}
	// Whatever was retrieved can be given back: after a new prompt, releasing leaves no recalled text.
	s.append("user", "Something else now.");
	// One release takes the used results; with none left, the next takes the rest of earlier prompts.
	s.release(true);
	s.release(true);
	let standing = 0;
	for (const b of truth.blocks) if (isRecallResult(b) && !truth.inFoldedGroup(b.id)) standing += truth.effTokens(b);
	const results = truth.blocks.filter(isRecallResult).length;
	expect(standing, at("released recall results are one line each")).toBeLessThan(results * SMALL_RESULT_TOKENS + 1);
	expect(account.outstanding(truth), at("the account is empty again")).toBe(0);
}

describe("recall invariant under random agents", () => {
	// RECALL_SEEDS=1000 widens the run.
	const seeds = Number(process.env.RECALL_SEEDS) || 40;
	it("holds over seeded sessions of mixed recall, parallel recall, paging, search, unfold and oversized tool results", () => {
		const seen: Seen = { served: 0, refused: 0, unfolded: 0, unfoldRefused: 0, clipped: 0 };
		for (let seed = 1; seed <= seeds; seed++) run(seed, seen);
		// Every path was exercised often enough to mean something.
		for (const n of Object.values(seen)) expect(n, JSON.stringify(seen)).toBeGreaterThan(20);
	}, 60_000 + seeds * 500);
});
