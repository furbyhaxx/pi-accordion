<script lang="ts">
	/*
	 * TasksPanel.svelte — the session's task tree on the web surface (SPEC-0001 §9).
	 *
	 * The host sends the projection (`tasks` message); nothing here reads a list file. The glyphs
	 * match the TUI's task views so a human reading both sees the same state.
	 */
	import type { WireTask, WireTaskList } from "$core/protocol";
	import { hostTasks } from "$lib/live/liveClient.svelte";

	const GLYPH: Record<string, string> = {
		done: "▣",
		failed: "☒",
		abandoned: "⊘",
		blocked: "⧗",
		doing: "▶",
		todo: "☐",
	};

	/** Depth from the dotted id, so children indent under their parents. */
	function depthOf(id: string): number {
		return id.split(".").length - 1;
	}

	const list = $derived(hostTasks.list as WireTaskList | null);
	const tasks = $derived<WireTask[]>(list?.tasks ?? []);
	const folded = $derived(hostTasks.folded.length);
	const tokens = $derived(hostTasks.tokens);
</script>

<div class="tasks">
	<header>
		<span class="mono title">{list?.title ?? "No list attached"}</span>
		{#if list?.claim}<span class="mono note">claimed</span>{/if}
		{#if folded}<span class="mono note">{folded} folded</span>{/if}
		{#if tokens}<span class="mono note">{Math.round(tokens.live / 100) / 10}k / {Math.round(tokens.full / 100) / 10}k</span>{/if}
	</header>
	{#if !tasks.length}
		<p class="mono note">No tasks in this session's list.</p>
	{:else}
		<ul>
			{#each tasks as task (task.id)}
				<li class="mono" style={`--depth:${depthOf(task.id)}`}>
					<span class="glyph">{GLYPH[task.status] ?? "☐"}</span>
					<span class="id">{task.id}</span>
					<span class="name" class:closed={task.status === "done" || task.status === "failed" || task.status === "abandoned"}>{task.title}</span>
				</li>
			{/each}
		</ul>
	{/if}
</div>

<style>
	.tasks {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 12px;
		color: var(--text);
		overflow: auto;
		max-height: 100%;
	}
	header {
		display: flex;
		align-items: center;
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
		display: flex;
		gap: 6px;
		padding-left: calc(var(--depth) * 12px);
	}
	.glyph {
		width: 1.2em;
		color: var(--muted);
	}
	.id {
		width: 3.2em;
		color: var(--muted);
	}
	.name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.name.closed {
		color: var(--muted);
	}
</style>
