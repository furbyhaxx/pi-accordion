#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { compareIds } from "./taskSchema.ts";

const exempt = new Set(["tasks", "unfold", "recall"]);
const terminal = new Set(["complete", "fail", "abandon"]);

function branch(entries) {
	const nodes = entries.filter((entry) => entry.type !== "session");
	if (!nodes.length) return [];
	if (!nodes.every((entry) => typeof entry.id === "string" && "parentId" in entry)) {
		throw new Error("session entries lack branch identifiers");
	}
	const index = new Map(nodes.map((entry) => [entry.id, entry]));
	if (index.size !== nodes.length) throw new Error("duplicate session entry id");
	const selected = [];
	const seen = new Set();
	let node = nodes.at(-1);
	while (node) {
		if (seen.has(node.id)) throw new Error("cyclic session branch");
		seen.add(node.id);
		selected.push(node);
		if (node.parentId === null) break;
		node = index.get(node.parentId);
		if (!node) throw new Error("missing session branch parent");
	}
	return selected.reverse();
}

function taskKey(args) {
	return typeof args?.list === "string" && typeof args?.id === "string" ? `${args.list}/${args.id}` : null;
}

function hasReplacement(items) {
	return Array.isArray(items) && items.some((item) => item && typeof item === "object" && (typeof item.supersedes === "string" || hasReplacement(item.subtasks)));
}

function initialOrder(inputs) {
	if (!Array.isArray(inputs)) return null;
	const nodes = new Map();
	function visit(items, parent = "") {
		return items.every((item, index) => {
			if (!item || typeof item !== "object" || (item.subtasks !== undefined && !Array.isArray(item.subtasks))) return false;
			const id = parent ? `${parent}.${index + 1}` : String(index + 1);
			nodes.set(id, "todo");
			return item.subtasks === undefined || visit(item.subtasks, id);
		});
	}
	return visit(inputs) ? nodes : null;
}

function orderStep(nodes, action, id) {
	if (!nodes?.has(id)) return null;
	if (action === "start") {
		const leaves = [...nodes.keys()].filter((key) => ![...nodes.keys()].some((other) => other.startsWith(`${key}.`))).sort(compareIds);
		const pending = leaves.filter((key) => !["done", "failed", "abandoned"].includes(nodes.get(key)));
		const first = pending[0];
		if (!first || pending.some((key) => nodes.get(key) === "blocked" || [...nodes.keys()].some((parent) => key.startsWith(`${parent}.`) && nodes.get(parent) === "blocked"))) return null;
		const violation = first !== id;
		nodes.set(id, "doing");
		return violation;
	}
	if (action === "block") nodes.set(id, "blocked");
	if (terminal.has(action)) {
		nodes.set(id, action === "complete" ? "done" : action === "fail" ? "failed" : "abandoned");
		if (action !== "complete") for (const key of nodes.keys()) if (key.startsWith(`${id}.`)) nodes.set(key, "abandoned");
	}
	return false;
}

/** Aggregate recorded protocol activity; no message content is returned. */
export function auditSession(entries, diagnostics = []) {
	const calls = new Map();
	const active = new Set();
	const blocked = new Set();
	const seenLists = new Set();
	const orders = new Map();
	let orderViolations = 0;
	let orderUnknownStarts = 0;
	let orderEvaluatedStarts = 0;
	let bound = null;
	let firstStart = false;
	let beforeStartAmbiguous = false;
	let stateKnown = entries[0]?.type === "session" && !entries[0].parentSession;
	let incompleteNested = 0;
	let incompleteTasks = 0;
	const concurrent = new Set();
	let beforeFirstStart = 0;
	let work = 0;
	let tracked = 0;
	let uncertain = 0;
	let taskCalls = 0;
	let rejected = 0;
	let blocks = 0;
	let resumes = 0;
	let repairs = 0;
	let explicitRepairActions = 0;
	let prompts = 0;
	let prematureStops = 0;
	let modelChanges = 0;
	let requests = 0;

	function task(args, ok, ambiguous = false) {
		taskCalls++;
		if (ok === null) { incompleteTasks++; stateKnown = false; orders.clear(); return; }
		if (!ok) { rejected++; return; }
		const action = args?.action;
		const list = args?.list;
		const key = taskKey(args);
		if (typeof list === "string") {
			if (action === "create") orders.set(list, ambiguous ? null : initialOrder(args.tasks ?? []));
			else if (["claim", "add", "move"].includes(action)) orders.set(list, null);
			else if (key && ["start", "block", ...terminal].includes(action)) {
				const state = ambiguous ? null : orderStep(orders.get(list), action, args.id);
				if (action === "start") {
					if (state === null) orderUnknownStarts++;
					else { orderEvaluatedStarts++; if (state) orderViolations++; }
				}
				if (state === null) orders.set(list, null);
			}
		}
		if (typeof list === "string" && ["create", "claim", "add", "start", "block", "complete", "fail", "abandon"].includes(action)) {
			bound = list;
			seenLists.add(list);
		}
		if (action === "release" && list === bound) bound = null;
		if (["add", "move", "update", "abandon"].includes(action)) repairs++;
		if ((action === "abandon" && typeof args.supersededBy === "string") || (action === "add" && hasReplacement(args.tasks))) explicitRepairActions++;
		if (!key) return;
		if (action === "start") {
			stateKnown = !ambiguous;
			firstStart = true;
			if (blocked.delete(key)) resumes++;
			active.add(key);
		} else if (action === "block") {
			blocks++;
			active.delete(key);
			blocked.add(key);
		} else if (terminal.has(action)) {
			active.delete(key);
			blocked.delete(key);
		}
	}

	function nonExempt(name, ambiguous = false) {
		if (exempt.has(name)) return;
		work++;
		if (!firstStart) {
			beforeFirstStart++;
			if (ambiguous) beforeStartAmbiguous = true;
		}
		if (ambiguous || !stateKnown) uncertain++;
		else if (bound && [...active].some((key) => key.startsWith(`${bound}/`))) tracked++;
	}

	for (const entry of branch(entries)) {
		if (entry.type === "model_change") modelChanges++;
		if (entry.type === "custom" && entry.customType === "accordion.tasks.binding") {
			active.clear();
			blocked.clear();
			bound = typeof entry.data?.slug === "string" ? entry.data.slug : null;
			stateKnown = bound === null && entry.data?.slug === null;
			if (bound && orders.has(bound)) orders.set(bound, null);
			if (bound) seenLists.add(bound);
		}
		if (entry.type === "custom" && entry.customType === "accordion.tasks.idle" && ["in-progress", "pending"].includes(entry.data?.state)) prematureStops++;
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message?.role === "user") prompts++;
		if (message?.role === "assistant") {
			requests++;
			const parts = (Array.isArray(message.content) ? message.content : []).filter((part) => part?.type === "toolCall" && typeof part.id === "string");
			if (parts.length > 1 && parts.some((part) => part.name === "tasks" || part.name === "codemode")) {
				for (const part of parts) concurrent.add(part.id);
				if (!firstStart && parts.some((part) => !exempt.has(part.name))) beforeStartAmbiguous = true;
			}
			for (const part of parts) calls.set(part.id, part);
		}
		if (message?.role !== "toolResult") continue;
		const call = calls.get(message.toolCallId);
		if (message.toolName === "tasks") {
			task(call?.arguments, call ? !message.isError : null, concurrent.has(message.toolCallId));
			continue;
		}
		const nested = message.nestedCalls;
		if (Array.isArray(nested?.calls) && nested.complete === true) {
			const lifecycle = concurrent.has(message.toolCallId) || nested.calls.some((item) => item?.name === "tasks" && ["start", "block", ...terminal].includes(item.arguments?.action) && item.status === "ok");
			const taskOrderUnknown = concurrent.has(message.toolCallId) || nested.calls.filter((item) => item?.name === "tasks" && item.status === "ok").length > 1;
			if (!firstStart && lifecycle && nested.calls.some((item) => typeof item?.name === "string" && !exempt.has(item.name))) beforeStartAmbiguous = true;
			for (const item of nested.calls) {
				if (item?.name === "tasks") task(item.arguments, item.status === "ok" ? true : item.status === "error" ? false : null, taskOrderUnknown);
				else if (typeof item?.name === "string") nonExempt(item.name, lifecycle);
			}
		} else {
			const name = message.toolName ?? call?.name ?? "unknown";
			if (name === "codemode" || Array.isArray(message.details?.taskEvents)) {
				orders.clear();
				incompleteNested++;
				for (const event of Array.isArray(message.details?.taskEvents) ? message.details.taskEvents : []) {
					if (event && typeof event.action === "string" && typeof event.list === "string" && typeof event.id === "string") task(event, true, true);
				}
				stateKnown = false;
			}
			nonExempt(name, !!nested || name === "codemode" || concurrent.has(message.toolCallId));
		}
	}
	return {
		prompts, requests, modelChanges, lists: seenLists.size,
		taskCalls, rejected, incompleteTasks, rejectionsPer100: taskCalls && !incompleteTasks && !incompleteNested ? 100 * rejected / taskCalls : null,
		outOfOrderStarts: orderUnknownStarts || incompleteNested || incompleteTasks ? null : orderViolations,
		orderViolationsObserved: orderViolations, orderEvaluatedStarts, orderUnknownStarts,
		planRepairs: null, explicitRepairActions,
		workResults: work, trackedResults: tracked, uncertainResults: uncertain, incompleteNested,
		trackedFraction: work && !uncertain && !incompleteNested ? tracked / work : null,
		callsBeforeFirstStart: firstStart && !beforeStartAmbiguous && !incompleteNested ? beforeFirstStart : null,
		blocks, resumes, planChanges: repairs, prematureStops,
		prematureStopsPerPrompt: prompts ? prematureStops / prompts : null,
		tokens: tokenMetrics(requests, diagnostics),
	};
}

const positive = (value) => typeof value === "number" && Number.isFinite(value) && value > 0;

/**
 * Pairs session requests with debug measurements. One `request` record is written per finished
 * assistant message, so equal counts are the only evidence that record i measured request i; any
 * surplus, shortage or rejected receipt leaves the request unknown rather than guessed.
 */
export function tokenMetrics(requests, diagnostics) {
	const records = diagnostics.filter((entry) => entry?.type === "request");
	const usable = records.every((record) => record.receipt === undefined && positive(record.realInput) && positive(record.estimate) && positive(record.budget));
	const paired = requests > 0 && records.length === requests && usable;
	const trusted = paired ? records.length : 0;
	const overBudget = paired ? records.filter((record) => record.realInput > record.budget).length : null;
	return {
		requestsObserved: requests,
		trustedRequests: trusted,
		unknownRequests: requests - trusted,
		requestsOverBudget: overBudget,
		leafTokensPerBudgetP90: null,
		diagnosticRequests: records.length,
		unmeasured: [
			...(requests > records.length ? [`${requests - records.length} request(s) have no diagnostic record`] : []),
			...(records.length > requests ? [`${records.length - requests} diagnostic record(s) have no session request`] : []),
			...(paired ? [] : records.filter((record) => record.receipt !== undefined || !positive(record.realInput) || !positive(record.estimate) || !positive(record.budget)).length
				? ["a diagnostic record is rejected, unpriced or missing its budget"] : []),
			"leaf token spans are not stored in the session file, so leaf tokens per budget stay unknown",
		],
	};
}

export async function readJsonLines(file) {
	const text = await readFile(file, "utf8");
	return text.split(/\r?\n/).flatMap((line, i) => {
		if (!line.trim()) return [];
		try { return [JSON.parse(line)]; }
		catch { throw new Error(`invalid JSON on line ${i + 1}`); }
	});
}
async function main() {
	if (process.argv.length !== 3 && process.argv.length !== 5) throw new Error("usage: node extension/audit-tasks.mjs <session.jsonl> [--diagnostics <debug.jsonl>]");
	if (process.argv.length === 5 && process.argv[3] !== "--diagnostics") throw new Error("expected --diagnostics");
	const entries = await readJsonLines(process.argv[2]);
	if (process.argv.length === 5) {
		const header = entries.find((entry) => entry?.type === "session");
		if (typeof header?.id !== "string" || basename(process.argv[4]) !== `${encodeURIComponent(header.id)}.jsonl`) throw new Error("diagnostic file does not match the session id");
	}
	const diagnostics = process.argv.length === 5 ? await readJsonLines(process.argv[4]) : [];
	console.log(JSON.stringify(auditSession(entries, diagnostics), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
