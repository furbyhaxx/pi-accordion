import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { entryById } from "../../../../../core/conductor/registry.ts";
import { scanTaskSpans } from "../../../../../conductors/in-process/taskfold/taskfold.ts";
import accordion from "../../../../../extension/accordion.ts";
import { openAccordionPanel } from "../../../../../extension/tui/panel.ts";
import type { AccordionTuiHost } from "../../../../../extension/tui/host.ts";
import type { SettingsSnapshot } from "../../../../../extension/settingsStore.ts";
import type { Block } from "../../../../../core/types.ts";
import type { SettingsPatch } from "../../../../../extension/settingsValidation.ts";

const safeSnapshot = (snapshot: SettingsSnapshot) => ({ ...snapshot, settings: { ...snapshot.settings, customToken: snapshot.settings.customToken === null ? null : "[redacted]" } });

export default function settingsSyncFixture(pi: ExtensionAPI): void {
	const channel = process.env.ACCORDION_TEST_CHANNEL;
	if (!channel) throw new Error("ACCORDION_TEST_CHANNEL is required");
	// Pi reactivates extensions on /new; retain the actual old host across activations.
	const world = globalThis as typeof globalThis & {
		accordionSettingsFixtureActivations?: number;
		accordionSettingsRememberedHost?: AccordionTuiHost;
		accordionSettingsRememberedSession?: string;
		accordionSettingsRememberedActivation?: number;
	};
	const activation = (world.accordionSettingsFixtureActivations ?? 0) + 1;
	world.accordionSettingsFixtureActivations = activation;
	let host: AccordionTuiHost | undefined;
	let panelOpen = false;
	let busy = false;
	let pendingSave = false;
	let timer: ReturnType<typeof setInterval> | undefined;
	let attachCount = 0;
	let unobserve: (() => void) | undefined;
	let providerCalls = 0;
	const unexpectedRequest = (): never => { providerCalls++; throw new Error("This routing fixture must not call a provider"); };
	const write = (name: string, value: unknown) => {
		const file = path.join(channel, name);
		fs.writeFileSync(`${file}.tmp`, JSON.stringify(value), { mode: 0o600 });
		fs.renameSync(`${file}.tmp`, file);
	};
	const publish = () => {
		const snapshot = host?.settings?.();
		const web = host?.webInfo?.();
		write("state.json", {
			at: Date.now(), pid: process.pid, fixtureVersion: 11, activation, providerCalls, panelOpen, pendingSave, sessionId: host?.sessionId?.(), canSteer: host?.canSteer?.(),
			rememberedSessionId: world.accordionSettingsRememberedSession, rememberedActivation: world.accordionSettingsRememberedActivation,
			consentKey: entryById("taskfold")?.privacy?.consentKey,
			settings: snapshot && safeSnapshot(snapshot), dials: host?.dials?.(), stats: host?.truth()?.stats(),
			folding: host?.folding(), conductor: host?.activeConductor()?.id, attachCount,
			seedGroup: host?.truth()?.groups.find(group => group.memberIds.includes("a:fixture-start:p0")) ?? null,
			seedSpans: host?.truth() && scanTaskSpans(host.truth()!.blocks, block => block.text).filter(span => span.list === "work"),
			seedBlockCount: host?.truth()?.blocks.filter(block => block.id.includes("fixture-")).length,
			conductorStatus: host?.conductorStatus?.(),
			web: web && { port: web.port, doorPort: web.doorPort, bindHost: web.bindHost, tokenHash: createHash("sha256").update(web.token).digest("hex") },
		});
	};
	accordion(pi, {
		openPanel: async (ctx, current, start) => {
			host = current;
			unobserve?.();
			unobserve = current.truth()?.onEvent(event => { if (event.type === "locks" && event.holder === "Taskfold") attachCount++; });
			panelOpen = true;
			try { await openAccordionPanel(ctx, current, start); }
			finally { panelOpen = false; publish(); }
		},
	});
	const tick = async () => {
		if (busy) return;
		busy = true;
		try {
			publish();
			const file = path.join(channel, "request.json");
			if (!fs.existsSync(file)) return;
			const request: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
			fs.unlinkSync(file);
			if (!request || typeof request !== "object" || !("id" in request) || !Number.isSafeInteger(request.id) || !("action" in request)) throw new Error("Invalid fixture request");
			let result: unknown;
			try {
				if (request.action === "save" || request.action === "saveOld") {
					if (!("patch" in request) || !request.patch || typeof request.patch !== "object" || Array.isArray(request.patch) || !("baseRev" in request) || typeof request.baseRev !== "string") throw new Error("Invalid save request");
					const target = request.action === "saveOld" ? world.accordionSettingsRememberedHost : host;
					if (!target?.updateSettings) throw new Error("Open the native panel first");
					const remove = "remove" in request ? request.remove : [];
					if (!Array.isArray(remove) || !remove.every((key: unknown) => typeof key === "string")) throw new Error("Invalid removed fields");
					const patch = { ...request.patch, ...Object.fromEntries(remove.map(key => [key, undefined])) };
					const pending = target.updateSettings(patch as SettingsPatch, request.baseRev);
					pendingSave = true;
					publish();
					try {
						const saved = await pending;
						result = saved.ok ? { ...saved, snapshot: safeSnapshot(saved.snapshot) } : saved;
					} finally { pendingSave = false; }
				} else if (request.action === "rememberHost") {
					if (!host) throw new Error("Open the native panel first");
					world.accordionSettingsRememberedHost = host;
					world.accordionSettingsRememberedSession = host.sessionId?.();
					world.accordionSettingsRememberedActivation = activation;
					result = { ok: true, sessionId: host.sessionId?.() };
				} else if (request.action === "budgetOld") {
					const old = world.accordionSettingsRememberedHost;
					if (!old || !("value" in request) || typeof request.value !== "number" || !Number.isSafeInteger(request.value) || request.value <= 0) throw new Error("Invalid stale budget request");
					result = await old.command({ kind: "setBudget", value: request.value });
				} else if (request.action === "rotate") {
					if (!host?.regenerateToken) throw new Error("Open the native panel first");
					result = { ok: true, tokenHash: createHash("sha256").update(await host.regenerateToken()).digest("hex") };
				} else if (request.action === "seedTask") {
					const truth = host?.truth();
					if (!truth || host?.activeConductor()?.id !== "taskfold") throw new Error("Attach Taskfold first");
					let order = (truth.blocks.at(-1)?.order ?? -1) + 1;
					const turn = (truth.blocks.at(-1)?.turn ?? 0) + 1;
					const block = (id: string, kind: Block["kind"], text: string, extra: Partial<Block> = {}): Block => ({
						id, kind, text, turn, order: order++, tokens: Math.ceil(text.length / 4), override: null, autoFolded: false, by: null, ...extra,
					});
					const task = (action: string, report?: object) => `tasks ${JSON.stringify({ action, list: "work", id: "1", ...(report ? { report } : {}) })}`;
					truth.append([
						block("a:fixture-start:p0", "tool_call", task("start"), { toolName: "tasks", callId: "fixture-start" }),
						block("r:fixture-start", "tool_result", 'Started work/1 "Fixture".', { toolName: "tasks", callId: "fixture-start" }),
						block("a:fixture-work:p0", "tool_call", 'bash {"command":"fixture"}', { toolName: "bash", callId: "fixture-work" }),
						block("r:fixture-work", "tool_result", "fixture result ".repeat(300), { toolName: "bash", callId: "fixture-work" }),
						block("a:fixture-finish:p0", "tool_call", task("complete", { outcome: "Fixture finished" }), { toolName: "tasks", callId: "fixture-finish" }),
						block("r:fixture-finish", "tool_result", "work/1 is done.", { toolName: "tasks", callId: "fixture-finish" }),
						block("a:fixture-tail:p0", "tool_call", 'bash {"command":"tail"}', { toolName: "bash", callId: "fixture-tail" }),
						block("r:fixture-tail", "tool_result", "tail output", { toolName: "bash", callId: "fixture-tail" }),
					]);
					result = { ok: true };
				} else if (request.action === "registerRoutes") {
					for (const [provider, baseUrl] of [["settings-local", "http://127.0.0.1:9"], ["settings-remote", "https://settings-fixture.invalid"]] as const) {
						pi.registerProvider(provider, {
							baseUrl, apiKey: "fixture-unused", api: "openai-completions", streamSimple: unexpectedRequest,
							classifiers: { "settings-fixture-classifier": { classify: async () => unexpectedRequest() } },
							models: [
								{ type: "chat", id: "chat", name: `${provider} chat`, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 16000, maxTokens: 100 },
								{ type: "classifier", id: "classifier", name: `${provider} classifier`, api: "settings-fixture-classifier", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 16000 },
							],
						});
					}
					result = { ok: true };
				} else throw new Error("Unsupported fixture action");
			} catch (error) { result = { ok: false, error: error instanceof Error ? error.message : String(error) }; }
			write("response.json", { id: request.id, result });
			publish();
		} finally { busy = false; }
	};
	pi.on("session_start", () => {
		timer = setInterval(() => { void tick(); }, 100);
		timer.unref();
	});
	pi.on("session_shutdown", () => { if (timer) clearInterval(timer); timer = undefined; unobserve?.(); unobserve = undefined; });
}
