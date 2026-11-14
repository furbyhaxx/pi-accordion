<script lang="ts">
	/*
	 * CompactDialog.svelte — the web form of SPEC-0001 §7.6: choose a strategy, see what each one
	 * projects, then run it. The projections are estimates the host would apply, so the dialog never
	 * claims a saving it has not measured; a real pass reports back through the `compaction` toast.
	 */
	import type { CompactStrategy } from "$core/protocol";
	import { compactionPreview, isController, runCompaction } from "$lib/live/liveClient.svelte";
	import Icon from "$lib/ui/Icon.svelte";

	let { store, onclose }: { store: { liveTokens: number; fullTokens: number }; onclose: () => void } = $props();

	let instructions = $state("");
	let strategy = $state<CompactStrategy | null>(null);

	const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

	/** `…` until the host's dry-run reply (or a field of it) is here; the host measures, the dialog never estimates. */
	const rows = $derived.by<{ strategy: CompactStrategy; label: string; projection: string }[]>(() => {
		const { received, projection } = compactionPreview;
		const aggressive = received && projection.aggressive !== null ? `−${k(projection.aggressive)} → ${k(Math.max(0, store.liveTokens - projection.aggressive))}` : "…";
		const pass = !received ? "…" : projection.pass !== null ? `≈ −${k(projection.pass)}` : "Taskfold decides";
		const bake = received && projection.bake !== null ? `summary ≈ ${k(projection.bake)} · permanent, no recall` : "…";
		return [
			{ strategy: "pass", label: "pass", projection: pass },
			{ strategy: "aggressive", label: "aggressive", projection: aggressive },
			{ strategy: "bake", label: "bake", projection: bake },
			{ strategy: "native", label: "native", projection: "pi summarizes (model call) · unknown" },
		];
	});

	// A dry run on open and again when the strategy changes (SPEC-0001 §7.6); it applies nothing.
	$effect(() => {
		const chosen = strategy ?? "pass";
		if (isController()) void runCompaction(chosen, undefined, true);
	});

	function run(): void {
		if (!strategy) return;
		void runCompaction(strategy, instructions.trim() || undefined);
		onclose();
	}

	let card = $state<HTMLDivElement>();
	$effect(() => {
		card?.focus();
		function onKey(e: KeyboardEvent): void {
			if (e.key === "Escape") {
				e.stopPropagation();
				onclose();
			}
		}
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	});
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="compact-backdrop" onclick={onclose}>
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="compact-card" role="dialog" tabindex="-1" aria-modal="true" aria-labelledby="compact-title" bind:this={card} onclick={(e) => e.stopPropagation()}>
		<div class="compact-head">
			<Icon name="activity" size={12} />
			<span id="compact-title" class="mono">Compact the context</span>
		</div>
		<div class="compact-rows">
			{#each rows as row (row.strategy)}
				<button class="compact-row" class:selected={strategy === row.strategy} onclick={() => (strategy = row.strategy)}>
					<span class="mono name">{row.label}</span>
					<span class="mono projection">{row.projection}</span>
				</button>
			{/each}
		</div>
		<label class="compact-instructions">
			<span class="mono eyebrow">INSTRUCTIONS</span>
			<input class="mono" bind:value={instructions} placeholder="optional guidance for the pass" />
		</label>
		<div class="compact-actions">
			<button class="mono" onclick={onclose}>Cancel</button>
			<button class="mono primary" disabled={!strategy} onclick={run}>Run {strategy ?? ""}</button>
		</div>
	</div>
</div>

<style>
	.compact-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.55);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 60;
	}
	.compact-card {
		width: min(520px, 92vw);
		background: var(--panel);
		border: 1px solid var(--line-strong);
		padding: 16px;
		display: flex;
		flex-direction: column;
		gap: 12px;
	}
	.compact-head {
		display: flex;
		align-items: center;
		gap: 8px;
		color: var(--text);
	}
	.compact-rows {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.compact-row {
		display: flex;
		justify-content: space-between;
		gap: 12px;
		padding: 6px 8px;
		background: transparent;
		border: 1px solid var(--line);
		color: var(--text);
		text-align: left;
		cursor: pointer;
	}
	.compact-row.selected {
		border-color: var(--line-strong);
		background: var(--panel-2);
	}
	.projection {
		color: var(--muted);
	}
	.compact-instructions {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.eyebrow {
		color: var(--muted);
		font-size: 10px;
		letter-spacing: 0.08em;
	}
	.compact-instructions input {
		background: var(--bg);
		border: 1px solid var(--line);
		color: var(--text);
		padding: 6px;
	}
	.compact-actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
	}
	.compact-actions button {
		background: transparent;
		border: 1px solid var(--line);
		color: var(--text);
		padding: 6px 10px;
		cursor: pointer;
	}
	.compact-actions button.primary:not(:disabled) {
		border-color: var(--line-strong);
	}
	.compact-actions button:disabled {
		opacity: 0.4;
		cursor: default;
	}
</style>
