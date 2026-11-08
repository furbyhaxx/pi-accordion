#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { parseListFile } from "../../../taskSchema.ts";

const file = process.argv[2];
if (!file || process.argv.length !== 3) {
	console.error("Usage: node validate.mjs <task-list.json>");
	process.exitCode = 2;
} else {
	try {
		const raw = JSON.parse(await readFile(file, "utf8"));
		const slug = basename(file, ".json");
		if (raw?.version !== 3) {
			console.error("version: expected 3; use the tasks tool to migrate an older list before editing it");
			process.exitCode = 1;
		} else {
			const result = parseListFile(raw, slug);
			if (!result.ok) {
				for (const error of result.errors) console.error(error);
				process.exitCode = 1;
			} else console.log(`Valid task list: ${result.list.slug} (${result.list.tasks.length} tasks)`);
		}
	} catch (error) {
		console.error(`Cannot validate ${file}: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}
