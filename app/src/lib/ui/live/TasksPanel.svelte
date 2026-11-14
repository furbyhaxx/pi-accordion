<script lang="ts">
	/*
	 * TasksPanel.svelte — the session's task tree on the web surface (SPEC-0001 §4.4, §9).
	 *
	 * The host sends the projection (`tasks` message); nothing here reads a list file. `buildTaskRows`
	 * turns it into rows: indented by depth, the TUI's glyphs, `≡` and `full → live` tokens on folded
	 * tasks, finished siblings gathered into one `… N finished` row. Clicking a row with subtasks opens
	 * or closes them; clicking the finished row expands or collapses the run.
	 */
	import { SvelteMap, SvelteSet } from "svelte/reactivity";
	import { hostTasks } from "$lib/live/liveClient.svelte";
	import { TASK_GLYPH, buildTaskRows, formatProgress, glyphTone, summarizeTasks, type FoldTokens } from "$lib/live/taskTree";

	const toggles = new SvelteMap<string, boolean>();
	const revealed = new SvelteSet<string>();

	const list = $derived(hostTasks.list);
	const rows = $derived(
		buildTaskRows(list?.tasks ?? [], { folded: new Set(hostTasks.folded), foldTokens: hostTasks.foldTokens, toggles, revealed }),
	);
	const summary = $derived(summarizeTasks(list?.tasks ?? [], hostTasks.folded));
	const tokens = $derived(hostTasks.tokens);

	function k(n: number): string {
		return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
	}
	function arrow(t: FoldTokens): string {
		return `${k(t.full)} → ${k(t.live)}`;
	}
	function toggleRun(key: string): void {
		if (revealed.has(key)) revealed.delete(key);
		else revealed.add(key);
	}
	function toggleTask(id: string, open: boolean): void {
		toggles.set(id, !open);
	}
	const MARK = { folded: "≡", raw: "·", inconsistent: "!" } as const;
</script>

<div class="tasks">
	<header>
		<span class="mono title">{list?.title ?? "No list attached"}</span>
		{#if list?.claim}<span class="mono note">claimed</span>{/if}
		{#if list}<span class="mono note">{summary.done}/{summary.total}</span>{/if}
		{#if summary.folded}<span class="mono note">≡{summary.folded}</span>{/if}
		{#if tokens}<span class="mono note">{arrow(tokens)} tok</span>{/if}
	</header>
	{#if !rows.length}
		<p class="mono note">No tasks in this session's list.</p>
	{:else}
		<ul role="tree">
			{#each rows as row (row.kind === "task" ? `t:${row.id}` : `f:${row.key}`)}
				<li class="mono" style="--depth:{row.depth}" role="none">
					{#if row.kind === "finished"}
						<button class="row run" role="treeitem" aria-selected="false" aria-expanded={row.open} aria-label="{row.count} finished tasks" onclick={() => toggleRun(row.key)}>
							<span class="glyph">{row.open ? "▾" : "…"}</span>
							<span class="name">{row.open ? `hide ${row.count} finished` : `${row.count} finished`}</span>
							{#if row.folded}<span class="meta">({row.folded}≡{row.tokens ? ` · ${arrow(row.tokens)}` : ""})</span>{/if}
						</button>
					{:else}
						{@const meta = [row.progress ? formatProgress(row.progress) : "", row.tokens ? arrow(row.tokens) : "", row.foldedBelow ? `${row.foldedBelow}≡` : ""].filter(Boolean).join(" · ")}
						{#if row.hasChildren}
							<button class="row" role="treeitem" aria-selected="false" aria-expanded={row.open} aria-label="{row.id} {row.title}, {row.state}" onclick={() => toggleTask(row.id, row.open)}>
								<span class="chev">{row.open ? "▾" : "▸"}</span>
								<span class="glyph tone-{glyphTone(row.state)}">{TASK_GLYPH[row.state]}</span>
								<span class="id">{row.id}</span>
								<span class="name" class:dim={row.state === "todo" || row.state === "abandoned"} class:struck={row.state === "abandoned"}>{row.title}</span>
								<span class="mark" class:warn={row.mark === "inconsistent"}>{row.mark ? MARK[row.mark] : ""}</span>
								{#if meta}<span class="meta">({meta})</span>{/if}
							</button>
						{:else}
							<div class="row static" role="treeitem" aria-selected="false" aria-label="{row.id} {row.title}, {row.state}">
								<span class="chev"></span>
								<span class="glyph tone-{glyphTone(row.state)}">{TASK_GLYPH[row.state]}</span>
								<span class="id">{row.id}</span>
								<span class="name" class:dim={row.state === "todo" || row.state === "abandoned"} class:struck={row.state === "abandoned"}>{row.title}</span>
								<span class="mark" class:warn={row.mark === "inconsistent"}>{row.mark ? MARK[row.mark] : ""}</span>
								{#if meta}<span class="meta">({meta})</span>{/if}
							</div>
						{/if}
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</div>

<style>
	.tasks {
		display: flex;
		flex-direction: column;
		gap: 12px;
		color: var(--text);
		overflow: auto;
		max-height: 100%;
	}
	header {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 8px;
	}
	.title {
		font-weight: 600;
	}
	.note {
		color: var(--muted);
		font-size: 11px;
	}
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 1px;
	}
	li {
		padding-left: calc(var(--depth) * 12px);
	}
	.row {
		display: flex;
		align-items: baseline;
		gap: 6px;
		width: 100%;
		min-width: 0;
		padding: 2px 4px;
		background: transparent;
		border: 0;
		border-radius: var(--radius-xs);
		color: inherit;
		font: inherit;
		text-align: left;
	}
	button.row {
		cursor: pointer;
	}
	button.row:hover {
		background: var(--accent-soft);
	}
	button.row:focus-visible {
		outline: none;
		box-shadow: var(--focus-ring);
	}
	.chev {
		width: 1em;
		color: var(--muted);
		flex: none;
	}
	.glyph {
		width: 1.2em;
		flex: none;
	}
	.tone-success {
		color: var(--ok);
	}
	.tone-error {
		color: var(--danger);
	}
	.tone-warning {
		color: var(--warn);
	}
	.tone-muted {
		color: var(--muted);
	}
	.tone-text {
		color: var(--text);
	}
	.id {
		flex: none;
		min-width: 2.4em;
		color: var(--muted);
	}
	.name {
		flex: 0 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.name.dim,
	.run .name {
		color: var(--muted);
	}
	.name.struck {
		text-decoration: line-through;
	}
	.mark {
		color: var(--muted);
		flex: none;
	}
	.mark.warn {
		color: var(--warn);
	}
	.meta {
		color: var(--muted);
		font-size: 11px;
		white-space: nowrap;
		flex: none;
	}
</style>
