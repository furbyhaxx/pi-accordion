import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import accordion from "../../../../../extension/accordion.ts";
import { openAccordionPanel } from "../../../../../extension/tui/panel.ts";
import type { AccordionTuiHost } from "../../../../../extension/tui/host.ts";
import type { SettingsSnapshot } from "../../../../../extension/settingsStore.ts";
import type { SettingsPatch } from "../../../../../extension/settingsValidation.ts";

const safeSnapshot = (snapshot: SettingsSnapshot) => ({ ...snapshot, settings: { ...snapshot.settings, customToken: snapshot.settings.customToken === null ? null : "[redacted]" } });

export default function settingsSyncFixture(pi: ExtensionAPI): void {
	const channel = process.env.ACCORDION_TEST_CHANNEL;
	if (!channel) throw new Error("ACCORDION_TEST_CHANNEL is required");
	let host: AccordionTuiHost | undefined;
	let firstHost: AccordionTuiHost | undefined;
	let panelOpen = false;
	let busy = false;
	let timer: ReturnType<typeof setInterval> | undefined;
	const write = (name: string, value: unknown) => {
		const file = path.join(channel, name);
		fs.writeFileSync(`${file}.tmp`, JSON.stringify(value), { mode: 0o600 });
		fs.renameSync(`${file}.tmp`, file);
	};
	const publish = () => {
		const snapshot = host?.settings?.();
		const web = host?.webInfo?.();
		write("state.json", {
			at: Date.now(), pid: process.pid, panelOpen, sessionId: host?.sessionId?.(), canSteer: host?.canSteer?.(),
			settings: snapshot && safeSnapshot(snapshot), dials: host?.dials?.(), stats: host?.truth()?.stats(),
			folding: host?.folding(), conductor: host?.activeConductor()?.id,
			web: web && { port: web.port, doorPort: web.doorPort, bindHost: web.bindHost, tokenHash: createHash("sha256").update(web.token).digest("hex") },
		});
	};
	accordion(pi, {
		openPanel: async (ctx, current, start) => {
			host = current;
			firstHost ??= current;
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
					const target = request.action === "saveOld" ? firstHost : host;
					if (!target?.updateSettings) throw new Error("Open the native panel first");
					const saved = await target.updateSettings(request.patch as SettingsPatch, request.baseRev);
					result = saved.ok ? { ...saved, snapshot: safeSnapshot(saved.snapshot) } : saved;
				} else if (request.action === "rotate") {
					if (!host?.regenerateToken) throw new Error("Open the native panel first");
					result = { ok: true, tokenHash: createHash("sha256").update(await host.regenerateToken()).digest("hex") };
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
	pi.on("session_shutdown", () => { if (timer) clearInterval(timer); timer = undefined; });
}
