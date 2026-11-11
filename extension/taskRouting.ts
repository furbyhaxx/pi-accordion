/*
 * taskRouting.ts — turns a user message into task-list changes (SPEC-0002 §4.6). Pure: no Pi imports,
 * no model calls. `extractionRequest` builds the prompt, `parseExtraction` validates the model's JSON,
 * `applyRoutedOps` runs each operation through the same store actions the agent uses, so freezing,
 * caps and the verbatim-pin check apply unchanged. A refused operation is dropped, never retried.
 */
import { PinError, type PinKind, type PinLimits } from "./taskPins";
import { PIN_KINDS } from "./taskSchema";
import { symbolFiles, warmSymbols } from "./taskSymbols";
import { RoutingParseError, type RoutingResult, type TaskfoldRouting } from "../conductors/in-process/taskfold/routing";
import { TaskError, runTasksTracked, type TaskList, type TaskStore, type TasksArgs } from "./tasks";

export const ROUTED_KINDS = ["goal", "task", "criterion", "pin", "attach"] as const;
export type RoutedKind = (typeof ROUTED_KINDS)[number];
export type RoutedVerb = "+" | "-" | "~";

/** One proposed list change. `target` is `list` or a task id; `id` names the goal, criterion, pin or attachment acted on. */
export interface RoutedOp {
	op: RoutedVerb;
	kind: RoutedKind;
	target: string;
	id?: string;
	value?: string;
	pinKind?: PinKind;
}

/** A change the store accepted, with what the agent needs to see of it. */
export interface AppliedOp extends RoutedOp {
	/** The id assigned to an added item, or the task id for a task operation. */
	ref?: string;
}

export interface DroppedOp {
	op: RoutedOp;
	reason: string;
}

export interface RoutingOutcome {
	applied: AppliedOp[];
	dropped: DroppedOp[];
}

/** What the extractor said about the message besides its operations. */
export interface Extraction {
	class?: string;
	ops: RoutedOp[];
	/** Operations rejected for shape before reaching the store. */
	rejected: DroppedOp[];
}

const MAX_OPS = 12;
const MAX_VALUE = 600;
const CLASSES = ["chat", "answer", "directive", "correction", "scope-change"];

export const EXTRACT_SYSTEM = `You maintain a coding agent's persistent task list. The list survives when the agent's context is summarized, so anything the user wants to last must be in it. Given the list, the agent's last turn and a new user message, decide which durable changes the message makes to the list.

Change kinds:
- goal: what the whole list must deliver. target "list".
- task: a unit of work. "+" adds one (target: parent task id, or "list" for a root), "-" drops one (target: its id), "~" renames one (target: its id).
- criterion: a checkable statement a task's result must satisfy. target: the task id.
- pin: a rule, convention, constraint, standard or fact that must keep holding. pinKind is one of ${PIN_KINDS.join(", ")}. value MUST be copied word for word from the user message. target: "list" or a task id.
- attach: a file the work must use. value is a path, "path#Heading > Subheading" or "path::symbol". target: "list" or a task id.

Record only what the user asked for or stated as lasting. Questions, approvals ("ok", "go ahead"), reports, chit-chat and one-off instructions for the very next step produce no operations. Do not record the user's complaints about the agent's last step. Prefer no operation over a doubtful one. Use the ids in the list; never invent an id. Started tasks cannot be renamed or dropped by you unless the user clearly says so.

Answer with JSON only: {"class":"chat|answer|directive|correction|scope-change","ops":[{"op":"+|-|~","kind":"goal|task|criterion|pin|attach","target":"list|<task id>","id":"<g1|c2|p3|a4 when removing or editing an item>","value":"<text, path or title>","pinKind":"<only for pins>"}]}`;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The list as the extractor sees it: items with ids, finished tasks reduced to their titles. */
export function routingContext(list: TaskList): Record<string, unknown> {
	const items = (xs: readonly { id: string; text: string }[] | undefined) => (xs?.length ? xs.map(({ id, text }) => ({ id, text })) : undefined);
	const pins = (xs: TaskList["pins"]) => (xs?.length ? xs.map((p) => ({ id: p.id, kind: p.kind, text: p.text })) : undefined);
	const attachments = (xs: TaskList["attachments"]) => (xs?.length ? xs.map((a) => ({ id: a.id, path: a.path, ...(a.anchor ? { anchor: a.anchor } : {}) })) : undefined);
	const finished = (s: string) => s === "done" || s === "failed" || s === "abandoned";
	return {
		slug: list.slug,
		title: list.title,
		goals: items(list.goals),
		pins: pins(list.pins),
		attachments: attachments(list.attachments),
		doing: list.tasks.filter((t) => t.status === "doing").map((t) => t.id),
		tasks: list.tasks.map((t) => (finished(t.status) ? { id: t.id, title: t.title, status: t.status } : { id: t.id, title: t.title, status: t.status, goals: items(t.goals), criteria: items(t.acceptanceCriteria), pins: pins(t.pins), attachments: attachments(t.attachments) })),
	};
}

/** The one user-turn prompt for the extractor. */
export function extractionPrompt(list: TaskList, agentLastTurn: string, message: string): string {
	return JSON.stringify({ list: routingContext(list), agentLastTurn, userMessage: message });
}

function rejectOp(raw: unknown, why: string): DroppedOp {
	const o = isObj(raw) ? raw : {};
	return { op: { op: o.op as RoutedVerb, kind: o.kind as RoutedKind, target: typeof o.target === "string" ? o.target : "" }, reason: why };
}

function shapeOp(raw: unknown): RoutedOp | DroppedOp {
	if (!isObj(raw)) return rejectOp(raw, "not an object");
	const { op, kind, target, id, value, pinKind } = raw;
	if (op !== "+" && op !== "-" && op !== "~") return rejectOp(raw, `unknown op "${String(op)}"`);
	if (typeof kind !== "string" || !(ROUTED_KINDS as readonly string[]).includes(kind)) return rejectOp(raw, `unknown kind "${String(kind)}"`);
	if (typeof target !== "string" || !target.trim()) return rejectOp(raw, "missing target");
	if (value !== undefined && (typeof value !== "string" || value.length > MAX_VALUE)) return rejectOp(raw, `value must be a string of at most ${MAX_VALUE} characters`);
	if (id !== undefined && typeof id !== "string") return rejectOp(raw, "id must be a string");
	const out: RoutedOp = { op, kind: kind as RoutedKind, target: target.trim(), ...(typeof id === "string" && id ? { id } : {}), ...(typeof value === "string" ? { value: value.trim() } : {}) };
	const needsValue = op !== "-";
	if (needsValue && !out.value) return rejectOp(raw, `"${op}" needs a value`);
	if (kind === "task" && op === "-" && out.target === "list") return rejectOp(raw, "a task to drop needs its id as target");
	if (kind === "task" && op === "~" && out.target === "list") return rejectOp(raw, "a task to rename needs its id as target");
	if ((kind === "goal" || kind === "criterion" || kind === "pin" || kind === "attach") && op !== "+" && !out.id) return rejectOp(raw, `"${op}" on a ${kind} needs its id`);
	if (kind === "goal" && out.target !== "list") return rejectOp(raw, 'goals belong to the list: target must be "list"');
	if (kind === "criterion" && out.target === "list") return rejectOp(raw, "a criterion belongs to a task: give its id as target");
	if ((kind === "pin" || kind === "attach") && op === "~") return rejectOp(raw, `a ${kind} cannot be edited; remove it and add it again`);
	if (kind === "pin" && op === "+") {
		if (typeof pinKind !== "string" || !(PIN_KINDS as readonly string[]).includes(pinKind)) return rejectOp(raw, `a pin needs pinKind, one of ${PIN_KINDS.join(", ")}`);
		out.pinKind = pinKind as PinKind;
	}
	return out;
}

/** Parse the first balanced JSON object in the extractor's reply; throws without an `ops` array. */
export function parseExtraction(reply: string): Extraction {
	const start = reply.indexOf("{");
	let end = start, depth = 0, quoted = false, escaped = false;
	for (; end < reply.length && start >= 0; end++) {
		const c = reply[end];
		if (quoted) {
			if (escaped) escaped = false;
			else if (c === "\\") escaped = true;
			else if (c === '"') quoted = false;
		} else if (c === '"') quoted = true;
		else if (c === "{") depth++;
		else if (c === "}" && --depth === 0) { end++; break; }
	}
	let data: unknown;
	try {
		data = JSON.parse(reply.slice(start, end));
	} catch {
		throw new RoutingParseError("the extractor did not return JSON");
	}
	if (!isObj(data) || !Array.isArray(data.ops)) throw new RoutingParseError('the extractor reply has no "ops" array');
	const ops: RoutedOp[] = [];
	const rejected: DroppedOp[] = [];
	for (const raw of data.ops.slice(0, MAX_OPS)) {
		const shaped = shapeOp(raw);
		if ("reason" in shaped) rejected.push(shaped);
		else ops.push(shaped);
	}
	for (const raw of data.ops.slice(MAX_OPS)) rejected.push(rejectOp(raw, `more than ${MAX_OPS} operations`));
	return { ...(typeof data.class === "string" && CLASSES.includes(data.class) ? { class: data.class } : {}), ops, rejected };
}

/** `path`, `path#A > B` or `path::Symbol` as attach input. */
function attachInput(value: string): Record<string, unknown> {
	const symbol = value.indexOf("::");
	if (symbol > 0) return { path: value.slice(0, symbol), symbol: value.slice(symbol + 2) };
	const section = value.indexOf("#");
	if (section > 0) return { path: value.slice(0, section), section: value.slice(section + 1).trim() };
	return { path: value };
}

const holder = (target: string): { id?: string } => (target === "list" ? {} : { id: target });

function callFor(slug: string, op: RoutedOp, said: string): TasksArgs {
	const base = { list: slug };
	const items = () => ({ ...(op.op === "+" ? { add: [op.value!] } : op.op === "-" ? { remove: [op.id!] } : { edit: [{ id: op.id!, text: op.value! }] }) });
	switch (op.kind) {
		case "goal":
			return { action: "update", ...base, goals: items() };
		case "criterion":
			return { action: "update", ...base, id: op.target, acceptanceCriteria: items() };
		case "task":
			if (op.op === "+") return { action: "add", ...base, ...(op.target === "list" ? {} : { parent: op.target }), tasks: [{ title: op.value! }] };
			if (op.op === "-") return { action: "abandon", ...base, id: op.target, report: { outcome: `Dropped because the user said: ${said.replace(/\s+/g, " ").slice(0, 120)}` } };
			return { action: "update", ...base, id: op.target, title: op.value! };
		case "pin":
			return op.op === "+" ? { action: "pin", ...base, ...holder(op.target), items: [{ kind: op.pinKind, text: op.value, source: "user" }] } : { action: "unpin", ...base, ...holder(op.target), pins: [op.id!] };
		case "attach":
			return op.op === "+" ? { action: "attach", ...base, ...holder(op.target), items: [attachInput(op.value!)] } : { action: "detach", ...base, ...holder(op.target), attachments: [op.id!] };
	}
}

/** The id the store assigned to an added item, or the task the operation touched. */
function refOf(op: RoutedOp, result: ReturnType<typeof runTasksTracked>["result"]): string | undefined {
	if (op.op !== "+") return op.id ?? (op.kind === "task" ? op.target : undefined);
	if (op.kind === "goal") return Array.isArray(result.goals) ? result.goals[0] : undefined;
	if (op.kind === "criterion") return Array.isArray(result.criteria) ? result.criteria[0] : undefined;
	if (op.kind === "pin") return result.pins?.[0];
	if (op.kind === "attach") return result.attachments?.[0]?.id;
	return result.ids?.[0];
}

/** Apply `ops` one by one through the store; `said` is the user message every pin must quote. */
export async function applyRoutedOps(store: TaskStore, slug: string, ops: readonly RoutedOp[], said: string, limits: PinLimits): Promise<RoutingOutcome> {
	const applied: AppliedOp[] = [];
	const dropped: DroppedOp[] = [];
	for (const op of ops) {
		try {
			// Ending a started task is the agent's tool call: spans open and close on those events.
			if (op.kind === "task" && op.op === "-" && store.read(slug).tasks.find((t) => t.id === op.target)?.status !== "todo") throw new TaskError("invalid_transition", `Task ${op.target} is not a task that has not started; the agent ends started tasks.`);
			const args = callFor(slug, op, said);
			await warmSymbols(symbolFiles(args, null));
			const run = runTasksTracked(store, args, [said], limits);
			const ref = refOf(op, run.result);
			applied.push({ ...op, ...(ref ? { ref } : {}) });
		} catch (error) {
			if (!(error instanceof TaskError) && !(error instanceof PinError)) throw error;
			dropped.push({ op, reason: error.message });
		}
	}
	return { applied, dropped };
}

export interface RoutingDeps {
	/** The list the session works on, or null when the tasks tool is inactive or no list is attached. */
	attached(): { store: TaskStore; list: TaskList } | null;
	limits(): PinLimits;
	/** Called after every extraction that changed the list. */
	applied(slug: string, outcome: RoutingOutcome): void;
}

/** The port the Taskfold conductor calls for each new user message. */
export function createRouting(deps: RoutingDeps): TaskfoldRouting {
	return {
		prepare(message, agentLastTurn) {
			const a = deps.attached();
			return a ? { system: EXTRACT_SYSTEM, prompt: extractionPrompt(a.list, agentLastTurn, message) } : null;
		},
		async apply(reply, message): Promise<RoutingResult> {
			const extraction = parseExtraction(reply);
			const a = deps.attached();
			if (!a) throw new Error("no task list is attached any more");
			const outcome = await applyRoutedOps(a.store, a.list.slug, extraction.ops, message, deps.limits());
			outcome.dropped.push(...extraction.rejected);
			if (outcome.applied.length) deps.applied(a.list.slug, outcome);
			const ids = outcome.applied.map((o) => o.ref).filter((r): r is string => !!r);
			return { ids, applied: outcome.applied.length, dropped: outcome.dropped.length };
		},
	};
}
