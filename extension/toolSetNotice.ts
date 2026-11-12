/**
 * The agent learns about conductor-provided tools appearing or vanishing with its next prompt.
 * The tool set is a silent side effect of attaching or detaching a conductor, so an agent that
 * only ever saw one shape of the toolbox would keep asking for a tool that is no longer there.
 */

/** One line describing what changed, or null when the set is unchanged. */
export function toolSetNotice(before: readonly string[], after: readonly string[]): string | null {
	const had = new Set(before);
	const has = new Set(after);
	const added = after.filter((t) => !had.has(t));
	const removed = before.filter((t) => !has.has(t));
	if (!added.length && !removed.length) return null;
	const parts: string[] = [];
	if (added.length) parts.push(`${added.map(quote).join(", ")} ${added.length > 1 ? "are" : "is"} available now`);
	if (removed.length) parts.push(`${removed.map(quote).join(", ")} ${removed.length > 1 ? "are" : "is"} no longer available`);
	return `Tool availability changed: ${parts.join("; ")}.`;
}

function quote(name: string): string {
	return `\`${name}\``;
}
