#!/usr/bin/env node
// Validates a hand-written task list: its structure, then every pin and attachment against the files it names.
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";

// The store's modules import each other without extensions; resolve those to their .ts files.
registerHooks({
	resolve(specifier, context, next) {
		if (/^\.\.?\//.test(specifier) && !path.extname(specifier) && context.parentURL?.endsWith(".ts")) return next(`${specifier}.ts`, context);
		return next(specifier, context);
	},
});
const { parseListFile } = await import("../../../taskSchema.ts");
const { checkPinCap, makeAttachment, makePin, PIN_LIMITS } = await import("../../../taskPins.ts");
const { warmSymbols, symbolLang } = await import("../../../taskSymbols.ts");

const USAGE = `Usage: node validate.mjs [--project <dir>] [--root <dir>]... <list.json>

Checks the list structure, then resolves every pin and attachment: files exist, sections and
symbols are found, quotes are exact and unique, attached parts fit the line cap, pin quotes
appear in their source. Name the file .pig/tasks/<slug>.json (a symlink to a list kept next to
its plan is fine).

  --project <dir>  project root that relative paths resolve against
                   (default: the directory holding .pig/tasks/, else the current directory)
  --root <dir>     extra directory outside the project that may be attached; added to
                   tasks.attachments.roots from ~/.accordion/config.json`;

let args;
try {
	args = parseArgs({ allowPositionals: true, options: { project: { type: "string" }, root: { type: "string", multiple: true }, help: { type: "boolean", short: "h" } } });
} catch (error) {
	console.error(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
	process.exit(2);
}
if (args.values.help) {
	console.log(USAGE);
	process.exit(0);
}
if (args.positionals.length !== 1) {
	console.error(USAGE);
	process.exit(2);
}

const file = path.resolve(args.positionals[0]);
const slug = path.basename(file, ".json");
const inTasksDir = path.basename(path.dirname(file)) === "tasks" && path.basename(path.dirname(path.dirname(file))) === ".pig";
const projectDir = path.resolve(args.values.project ?? (inTasksDir ? path.dirname(path.dirname(path.dirname(file))) : process.cwd()));

/** Roots the running extension would allow: the user's config plus `--root`. */
async function configuredRoots() {
	const config = path.join(process.env.ACCORDION_HOME || os.homedir(), ".accordion", "config.json");
	let roots = [];
	try {
		roots = JSON.parse(await readFile(config, "utf8"))?.tasks?.attachments?.roots ?? [];
	} catch {
		// No config: no extra roots.
	}
	return [...(Array.isArray(roots) ? roots : []), ...(args.values.root ?? [])]
		.filter((r) => typeof r === "string" && r.trim())
		.map((r) => path.resolve(r.trim().replace(/^~(?=\/|$)/, os.homedir())));
}

/** A quote delivers exactly its text; one this short is usually a prefix of the passage meant. */
const SHORT_QUOTE = 60;

/** Every reference problem, as `where: message`. */
async function checkReferences(list, roots) {
	const limits = { ...PIN_LIMITS, roots };
	const ctx = { projectDir, userTexts: [], limits, now: "" };
	const holders = [{ where: "list", holder: list, cap: limits.listTokens }, ...list.tasks.map((t) => ({ where: `task ${t.id}`, holder: t, cap: limits.taskTokens }))];
	await warmSymbols(holders.flatMap(({ holder }) => (holder.attachments ?? []).filter((a) => a.anchor?.symbol && symbolLang(a.path)).map((a) => a.path)));
	const errors = [];
	let pins = 0;
	let attachments = 0;
	let userPins = 0;
	const shortQuotes = [];
	for (const { where, holder, cap } of holders) {
		const made = [];
		for (const p of holder.pins ?? []) {
			pins++;
			if (p.source.trim() === "user") {
				userPins++;
				continue;
			}
			try {
				made.push(makePin(p, ctx, p.id, made));
			} catch (error) {
				errors.push(`${where} pin ${p.id}: ${error.message}`);
			}
		}
		try {
			checkPinCap(holder.pins ?? [], cap, where);
		} catch (error) {
			errors.push(`${where}: ${error.message}`);
		}
		const seen = [];
		for (const a of holder.attachments ?? []) {
			attachments++;
			const anchor = a.anchor ?? {};
			const input = { path: a.path, note: a.note, section: anchor.section, symbol: anchor.symbol, quote: anchor.quote?.exact, lines: a.lines };
			if (input.quote && input.quote.trim().length < SHORT_QUOTE) shortQuotes.push(`${where} ${a.id}`);
			try {
				seen.push(makeAttachment(input, ctx, a.id, seen));
			} catch (error) {
				errors.push(`${where} attachment ${a.id} (${a.path}): ${error.message}`);
			}
		}
	}
	return { errors, pins, attachments, userPins, shortQuotes };
}

/** Leaves whose own and inherited context carries no pin or attachment. */
function bareLeaves(list) {
	const byId = new Map(list.tasks.map((t) => [t.id, t]));
	const has = (t) => !!(t.pins?.length || t.attachments?.length);
	return list.tasks.filter((t) => {
		if (list.tasks.some((x) => x.id.startsWith(`${t.id}.`))) return false;
		for (let id = t.id; id; id = id.includes(".") ? id.slice(0, id.lastIndexOf(".")) : "") if (has(byId.get(id))) return false;
		return true;
	});
}

try {
	const raw = JSON.parse(await readFile(file, "utf8"));
	if (raw?.version !== 3) {
		console.error("version: expected 3; use the tasks tool to migrate an older list before editing it");
		process.exit(1);
	}
	const result = parseListFile(raw, slug);
	if (!result.ok) {
		for (const error of result.errors) console.error(error);
		if (typeof raw.slug === "string" && raw.slug !== slug) console.error(`Validate the list through .pig/tasks/${raw.slug}.json (a symlink to this file is fine).`);
		process.exit(1);
	}
	const list = result.list;
	const refs = await checkReferences(list, await configuredRoots());
	if (refs.errors.length) {
		for (const error of refs.errors) console.error(error);
		process.exit(1);
	}
	console.log(`Valid task list: ${list.slug} (${list.tasks.length} tasks, ${refs.pins} pins, ${refs.attachments} attachments resolved against ${projectDir})`);
	if (refs.shortQuotes.length) console.log(`note: quote attachments deliver exactly the quoted text; these are under ${SHORT_QUOTE} characters: ${refs.shortQuotes.join(", ")}. Quote the whole bullet or paragraph the task needs.`);
	if (refs.userPins) console.log(`note: ${refs.userPins} pin(s) quote the user; only the tasks tool can check those against the session.`);
	const bare = bareLeaves(list);
	if (bare.length) console.log(`note: ${bare.length} leaf task(s) start with no pin or attachment of their own or from a parent: ${bare.slice(0, 8).map((t) => t.id).join(", ")}${bare.length > 8 ? ", …" : ""}. List-level ones still apply; check that each leaf gets the plan or spec part it needs.`);
} catch (error) {
	console.error(`Cannot validate ${file}: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
}
