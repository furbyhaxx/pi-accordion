<script lang="ts">
	/*
	 * SettingsPanel.svelte — the session host's settings, edited from the browser (SPEC-0001 §9).
	 *
	 * The extension owns the schema and validates every write, so this panel renders the paths the
	 * host sent, groups them by their prefix, and stages edits locally until Save sends one patch
	 * against the revision it saw. A conflict (another surface saved first) is reported, never
	 * silently overwritten. Read-only surfaces see the values without editors.
	 */
	import { hostSettings, isController, saveHostSettings } from "$lib/live/liveClient.svelte";

	let { onClose = undefined }: { onClose?: () => void } = $props();

	let staged = $state<Record<string, string>>({});
	let error = $state("");
	let saved = $state("");
	let saving = $state(false);

	const snapshot = $derived(hostSettings.snapshot);
	const settings = $derived((snapshot?.settings ?? {}) as Record<string, unknown>);
	const sources = $derived(snapshot?.sources ?? ({} as Record<string, string>));

	/** Flatten the settings document into its dotted paths, leaving arrays and objects as values. */
	function flatten(value: unknown, prefix = ""): { path: string; value: unknown }[] {
		if (!value || typeof value !== "object" || Array.isArray(value)) return prefix ? [{ path: prefix, value }] : [];
		return Object.entries(value as Record<string, unknown>).flatMap(([key, inner]) => {
			const path = prefix ? `${prefix}.${key}` : key;
			const primitive = inner === null || typeof inner !== "object" || Array.isArray(inner);
			return primitive ? [{ path, value: inner }] : flatten(inner, path);
		});
	}

	const rows = $derived(flatten(settings));

	/** Editing a value keeps its JSON type: a number stays a number, `true` a boolean. */
	function parse(text: string): { ok: true; value: unknown } | { ok: false } {
		const trim = text.trim();
		if (trim === "true") return { ok: true, value: true };
		if (trim === "false") return { ok: true, value: false };
		if (trim === "null") return { ok: true, value: null };
		if (/^-?\d+(\.\d+)?$/.test(trim)) return { ok: true, value: Number(trim) };
		if (trim.startsWith("[") || trim.startsWith("{")) {
			try {
				return { ok: true, value: JSON.parse(trim) };
			} catch {
				return { ok: false };
			}
		}
		return { ok: true, value: text };
	}

	function show(value: unknown): string {
		return typeof value === "string" ? value : JSON.stringify(value);
	}

	function locked(path: string): string | null {
		const source = sources[path];
		return source === "env" || source === "flag" ? source : null;
	}

	/**
	 * Staged values stay until the host answers: success clears the ones it saved, an error or a
	 * conflict keeps them all and shows the host's text.
	 */
	async function save(): Promise<void> {
		error = "";
		saved = "";
		const sent = { ...staged };
		const patch: Record<string, unknown> = {};
		for (const [path, text] of Object.entries(sent)) {
			const parsed = parse(text);
			if (!parsed.ok) {
				error = `${path}: not valid JSON`;
				return;
			}
			patch[path] = parsed.value;
		}
		if (!Object.keys(patch).length) return;
		saving = true;
		const result = await saveHostSettings(patch);
		saving = false;
		if (result.refused === "read-only") error = "Another surface steers; take control to save.";
		else if (result.error) error = result.conflict ? `Conflict: ${result.error}` : result.error;
		else if (result.conflict) error = "Conflict: another surface changed these settings first.";
		if (error) return;
		const rest = { ...staged };
		for (const [path, text] of Object.entries(sent)) if (rest[path] === text) delete rest[path];
		staged = rest;
		saved = "Saved to the session host.";
	}

	const groups = $derived.by(() => {
		const map = new Map<string, { path: string; value: unknown }[]>();
		for (const row of rows) {
			const head = row.path.includes(".") ? row.path.split(".")[0] : "General";
			if (!map.has(head)) map.set(head, []);
			map.get(head)!.push(row);
		}
		return [...map.entries()];
	});

	const dirty = $derived(Object.keys(staged).length > 0);
</script>

<div class="settings">
	<header>
		<span class="mono title">Session host</span>
		{#if !isController()}<span class="mono note">read-only · another surface steers</span>{/if}
		{#if dirty}<span class="mono note">{Object.keys(staged).length} staged</span>{/if}
		{#if onClose}<button class="mono" onclick={onClose}>Close</button>{/if}
	</header>
	{#if !snapshot}
		<p class="mono note">The session host has not sent its settings yet.</p>
	{:else}
		<div class="rows">
			{#each groups as [head, items] (head)}
				<div class="group mono">{head}</div>
				{#each items as row (row.path)}
					{@const source = locked(row.path)}
					<label class="row" class:staged={Object.hasOwn(staged, row.path)}>
						<span class="mono path" title={row.path}>{row.path.split(".").slice(1).join(".") || row.path}</span>
						<input
							class="mono"
							value={Object.hasOwn(staged, row.path) ? staged[row.path] : show(row.value)}
							disabled={!isController() || !!source}
							oninput={(e) => {
								const text = (e.currentTarget as HTMLInputElement).value;
								const next = { ...staged };
								if (text === show(row.value)) delete next[row.path];
								else next[row.path] = text;
								staged = next;
							}}
						/>
						<span class="mono source">{source ?? (sources[row.path] === "default" ? "" : sources[row.path] ?? "")}</span>
					</label>
				{/each}
			{/each}
		</div>
		{#if error}<p class="mono err">{error}</p>{/if}
		{#if saved}<p class="mono ok">{saved}</p>{/if}
		<footer>
			<button class="mono" disabled={!dirty || !isController() || saving} onclick={() => (staged = {})}>Discard</button>
			<button class="mono primary" disabled={!dirty || !isController() || saving} onclick={save}>{saving ? "Saving…" : "Save"}</button>
		</footer>
	{/if}
</div>

<style>
	.settings {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 12px;
		color: var(--text);
		overflow: auto;
		max-height: 100%;
	}
	header,
	footer {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	footer {
		justify-content: flex-end;
	}
	.title {
		font-weight: 600;
	}
	.note,
	.source,
	.group {
		color: var(--muted);
		font-size: 11px;
	}
	.group {
		margin-top: 6px;
		text-transform: uppercase;
		letter-spacing: 0.08em;
	}
	.rows {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.row {
		display: grid;
		grid-template-columns: minmax(120px, 1fr) minmax(140px, 1.4fr) 48px;
		gap: 8px;
		align-items: center;
	}
	.row.staged input {
		border-color: var(--line-strong);
	}
	input {
		background: var(--bg);
		border: 1px solid var(--line);
		color: var(--text);
		padding: 4px 6px;
	}
	input:disabled {
		color: var(--muted);
	}
	button {
		background: transparent;
		border: 1px solid var(--line);
		color: var(--text);
		padding: 4px 10px;
		cursor: pointer;
	}
	button.primary:not(:disabled) {
		border-color: var(--line-strong);
	}
	button:disabled {
		opacity: 0.4;
		cursor: default;
	}
	.err {
		color: var(--danger);
		border-left: 2px solid var(--danger);
		padding-left: 8px;
	}
	.ok {
		color: var(--muted);
	}
</style>
