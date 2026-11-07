import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { resolve } from "node:path";
import { ModelRuntime, readStoredCredential } from "@earendil-works/pi-coding-agent";
import { foldCode } from "../../../../core/digest.ts";

const root = resolve(process.argv[2]);
const dryRun = process.argv[3] === "--dry-run";
const fixture = JSON.parse(readFileSync(resolve(root, "fixture.json"), "utf8"));
assert.equal(fixture.project, resolve(root, "project"));
const model = "deepseek-flash";
const rates = { input: 0.15, output: 0.6 };
const bounds = { requests: 2, outputTokens: 512, catalogUsd: 0.05, timeoutMs: 90_000 };
const proxyToken = randomUUID();
let realKey, authFile, authHash;
if (!dryRun) {
	authFile = resolve(process.argv[3]);
	authHash = createHash("sha256").update(readFileSync(authFile)).digest("hex");
	const credential = readStoredCredential("deepseek", authFile);
	assert.equal(credential?.type, "api_key", "An existing DeepSeek API-key credential is required");
	const credentials = {
		async read(id) { return id === "deepseek" ? credential : undefined; },
		async list() { return [{ providerId: "deepseek", type: "api_key" }]; },
		async modify() { throw new Error("Live evaluation credential storage is read-only"); },
		async delete() { throw new Error("Live evaluation credential storage is read-only"); },
	};
	const runtime = await ModelRuntime.create({ credentials, modelsPath: null, modelsStorePath: resolve(root, "catalog.json"), allowModelNetwork: false, refreshOnCreate: false });
	realKey = (await runtime.getAuth("deepseek"))?.auth.apiKey;
	assert.ok(realKey, "Could not resolve the existing API key");
}
const content = (value) => typeof value === "string" ? value : (value ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
const leafs = (nodes) => nodes.flatMap((node) => node.task && !node.folded ? leafs(node.content ?? []) : [node]);
const deadline = async (promise, ms, label) => {
	let timer;
	try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms); })]); }
	finally { clearTimeout(timer); }
};
let child, rpcSequence = 0, inputBytes = 0, proxyFailure = null, nonJsonPackets = 0, stderrBytes = 0;
const pending = new Map(), requests = [], recalls = [], receipts = [];
const settled = Promise.withResolvers();
let finalText = "";
async function rpc(command, timeout = 15_000) {
	const id = `eval-${++rpcSequence}`;
	const response = Promise.withResolvers();
	pending.set(id, response);
	try {
		if (!child.stdin.write(JSON.stringify({ id, ...command }) + "\n")) await once(child.stdin, "drain");
		return await deadline(response.promise, timeout, command.type);
	} finally { pending.delete(id); }
}
const proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 120, async fetch(request) {
	if (request.headers.get("authorization") !== `Bearer ${proxyToken}`) return Response.json({ error: { message: "Evaluation proxy unauthorized" } }, { status: 401 });
	if (request.method !== "POST" || !new URL(request.url).pathname.endsWith("/chat/completions")) return new Response(null, { status: 404 });
	try {
		const payload = await request.json();
		const index = requests.length + 1;
		assert.ok(index <= bounds.requests, "Evaluation request bound exceeded");
		assert.equal(payload.model, model);
		payload.max_tokens = bounds.outputTokens;
		delete payload.max_completion_tokens;
		payload.thinking = { type: "disabled" };
		payload.tool_choice = index === 1 ? { type: "function", function: { name: "recall" } } : "none";
		const body = JSON.stringify(payload), bytes = Buffer.byteLength(body);
		const catalogUpperUsd = ((inputBytes + bytes + index * 5000) * rates.input + index * bounds.outputTokens * rates.output) / 1_000_000;
		assert.ok(catalogUpperUsd <= bounds.catalogUsd, "Evaluation catalog-cost bound exceeded");
		const last = payload.messages.at(-1), allText = payload.messages.map((m) => content(m.content)).join("\n");
		await rpc({ type: "prompt", message: `/accordion tasks dump-transcript --formats all live-before-${index}` });
		const doc = Bun.YAML.parse(readFileSync(resolve(fixture.project, `live-before-${index}.yaml`), "utf8")).transcript;
		const state = await rpc({ type: "get_state" });
		writeFileSync(resolve(root, `debug-${index}.json`), JSON.stringify({ roles: payload.messages.slice(-4).map((m) => m.role), workingSetAnywhere: allText.includes("[tasks] terminal-eval"), workingSet: doc.working_set ? { applied: doc.working_set.applied, target: doc.working_set.target_role, tokens: doc.working_set.tokens } : null, tokens: doc.tokens, groups: doc.metadata.groups.length, originalClaimMatchesFixture: doc.metadata.task_lists[0]?.claim?.session === fixture.sessionId, currentSessionMatchesFixture: state.data.sessionId === fixture.sessionId, tools: (payload.tools ?? []).map((tool) => tool.function.name) }));
		assert.ok(doc.working_set, "Working-set cache is missing");
		const suffixIndex = payload.messages.findLastIndex((message) => content(message.content).includes(doc.working_set.text));
		assert.ok(suffixIndex >= 0, "Working set is missing from the actual input");
		const suffixText = content(payload.messages[suffixIndex].content);
		assert.ok(suffixText.includes("Full criteria and scoped context remain readable."));
		assert.ok(suffixText.includes("A scoped fact is not a block pin."));
		assert.ok(suffixText.includes("Deep scoped attachment"));
		assert.ok((payload.tools ?? []).some((tool) => tool.function.name === "recall"));
		assert.equal(allText.includes("RECOVERABLE_SENTINEL_1_1"), index === 2);
		assert.ok(!allText.includes("RECOVERABLE_SENTINEL_1_2"), "Sibling raw content leaked onto the wire");
		if (index === 1) assert.match(allText, /\[task-(?:archive|record)\]/);
		const entry = { index, bytes, catalogUpperUsd, lastRole: last.role, suffixMessageIndex: suffixIndex, messageCount: payload.messages.length, tools: (payload.tools ?? []).map((tool) => tool.function.name), upstreamStatus: null };
		requests.push(entry);
		inputBytes += bytes;
		assert.equal(doc.working_set.applied, true);
		assert.equal(payload.messages[suffixIndex].role, doc.working_set.target_role === "toolResult" ? "tool" : doc.working_set.target_role);
		const leaves = leafs([...(doc.orientation ?? []), ...(doc.body ?? []), ...(doc.tail ?? [])]);
		const sum = leaves.reduce((total, node) => total + (typeof node.tokens === "number" ? node.tokens : node.tokens.live), 0) + doc.system.tokens + doc.working_set.tokens;
		assert.equal(sum, doc.tokens.live);
		for (const node of leaves.filter((node) => node.group || node.folded)) assert.ok(allText.includes(node.wire), "Dump record differs from the actual provider payload");
		entry.snapshot = { live: doc.tokens.live, full: doc.tokens.full, leafSum: sum, workingSet: { applied: true, targetRole: doc.working_set.target_role, tokens: doc.working_set.tokens } };
		if (dryRun) return Response.json({ error: { message: "Intentional credential-free dry-run stop" } }, { status: 400 });
		const upstream = await fetch("https://api.deepseek.com/chat/completions", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${realKey}` }, body, signal: AbortSignal.timeout(60_000) });
		entry.upstreamStatus = upstream.status;
		if (!upstream.ok) { await upstream.body?.cancel(); return Response.json({ error: { message: `Evaluation upstream returned HTTP ${upstream.status}` } }, { status: upstream.status }); }
		return new Response(upstream.body, { status: upstream.status, headers: { "content-type": upstream.headers.get("content-type") ?? "text/event-stream" } });
	} catch (error) {
		proxyFailure = String(error.message).replaceAll(proxyToken, "<redacted>");
		if (realKey) proxyFailure = proxyFailure.replaceAll(realKey, "<redacted>");
		return Response.json({ error: { message: "Evaluation guard or snapshot validation failed" } }, { status: 400 });
	}
} });
const settingsPath = resolve(root, "agent/settings.json"), settings = JSON.parse(readFileSync(settingsPath, "utf8"));
writeFileSync(settingsPath, JSON.stringify({ ...settings, defaultProvider: "deepseek", defaultModel: model, retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0, timeoutMs: 60_000 } }, compaction: { enabled: false }, cacheWarming: "off" }));
writeFileSync(resolve(root, "agent/models.json"), JSON.stringify({ providers: { deepseek: { baseUrl: `http://127.0.0.1:${proxy.port}/v1`, api: "openai-completions", models: [{ id: model, name: "Bounded non-thinking live evaluation", reasoning: true, input: ["text"], contextWindow: 1048576, maxTokens: 512, cost: { input: rates.input, output: rates.output, cacheRead: 0.003, cacheWrite: 0 }, compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false, maxTokensField: "max_tokens" } }] } } }));
const configPath = resolve(root, "accordion/.accordion/config.json"), config = JSON.parse(readFileSync(configPath, "utf8"));
writeFileSync(configPath, JSON.stringify({ ...config, modelDefaults: { "*": { budget: "7k", protect: "512" } } }));
const extension = resolve(import.meta.dirname, "../../../../extension/accordion.ts");
child = spawn("/home/furbyhaxx/.local/bin/pi-bolt", ["--mode", "rpc", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-mcp", "--no-builtin-tools", "--no-themes", "--offline", "--approve", "-e", extension, "--session", fixture.session, "--model", `deepseek/${model}`, "--thinking", "off", "--tools", "recall"], { cwd: fixture.project, env: { HOME: resolve(root, "home"), PATH: process.env.PATH, LANG: "C.UTF-8", TZ: "Europe/Zurich", PI_CODING_AGENT_DIR: resolve(root, "agent"), ACCORDION_HOME: resolve(root, "accordion"), PI_OFFLINE: "1", DEEPSEEK_API_KEY: proxyToken }, stdio: ["pipe", "pipe", "pipe"] });
let buffer = "";
child.stdout.setEncoding("utf8").on("data", (chunk) => {
	buffer += chunk;
	for (let end; (end = buffer.indexOf("\n")) >= 0;) {
		const line = buffer.slice(0, end).replace(/\r$/, ""); buffer = buffer.slice(end + 1);
		let event;
		try { event = JSON.parse(line); } catch { nonJsonPackets++; continue; }
		if (event.type === "response") {
			const response = pending.get(event.id);
			if (event.success) response?.resolve(event); else response?.reject(new Error(`RPC ${event.command} failed`));
		}
		if (event.type === "tool_execution_start" && event.toolName === "recall") recalls.push({ codes: event.args.codes, successful: false });
		if (event.type === "tool_execution_end" && event.toolName === "recall") {
			const value = content(event.result.content);
			recalls.at(-1).successful = !event.isError && value.includes("RECOVERABLE_SENTINEL_1_1") && !value.includes("RECOVERABLE_SENTINEL_1_2");
		}
		if (event.type === "message_end" && event.message.role === "assistant") {
			finalText = content(event.message.content);
			if (event.message.usage?.totalTokens > 0) receipts.push({ ...event.message.usage, stopReason: event.message.stopReason });
		}
		if (event.type === "agent_settled") settled.resolve();
	}
});
child.stderr.on("data", (data) => { stderrBytes += data.length; });
child.on("error", () => settled.reject(new Error("Pi-Bolt could not start")));
let result;
try {
	await rpc({ type: "get_state" });
	await rpc({ type: "set_auto_retry", enabled: false });
	await rpc({ type: "set_auto_compaction", enabled: false });
	const accepted = rpc({ type: "prompt", message: "This is a bounded synthetic recovery evaluation. Find the handle associated with child terminal-eval/1.1 in its folded parent record. Call recall exactly once for that child only; do not recall its sibling or change any tasks. Then reply with only the exact RECOVERABLE sentinel found in that child's original tool result. Do not do other fixture work." }, bounds.timeoutMs);
	await deadline(Promise.all([accepted, settled.promise]), bounds.timeoutMs, "live evaluation");
	assert.equal(proxyFailure, null);
	if (dryRun) assert.equal(requests.length, 1);
	if (!dryRun) {
		assert.deepEqual(requests.map((request) => request.upstreamStatus), [200, 200], "Expected two successful upstream requests");
		assert.deepEqual(recalls, [{ codes: [foldCode("t:terminal-eval/1.1")], successful: true }]);
		assert.equal(finalText.trim(), "RECOVERABLE_SENTINEL_1_1");
		assert.ok(receipts.length === 2 && receipts.every((usage) => usage.input + usage.cacheRead > 0));
	}
	result = { dryRun, runtime: "Pi-Bolt 1.0.9 / Pi 1.4.0", model, catalog: { source: "https://models.dev/api.json", checked: "2026-11-07", rates }, bounds, requests, recalls, receipts, finalSentinelVerified: !dryRun, nonJsonPackets, stderrBytes, authFileUnchanged: dryRun ? null : createHash("sha256").update(readFileSync(authFile)).digest("hex") === authHash, limitations: ["Synthetic fixtures only; no private session content was sent.", "Classifier service is not configured in the isolated fixture.", "Catalog-cost guard uses UTF-8 bytes plus overhead as a conservative input bound; actual provider receipts are separate.", "Fixture tasks remain deliberately open; this is recovery/projection verification, not a task-coaching evaluation."] };
} finally {
	child.stdin.end();
	await Promise.race([once(child, "exit"), Bun.sleep(3000)]);
	if (child.exitCode === null) child.kill("SIGTERM");
	proxy.stop(true);
}
console.log(JSON.stringify(result, null, 2));
