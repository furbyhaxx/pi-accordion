/*
 * routing.ts — the seam between the Taskfold conductor and the task store. The conductor cannot
 * import the store, so the extension installs a `TaskfoldRouting` here while a list is attached.
 * The conductor owns the model call; the port owns the prompt, the parsing and the store writes.
 */

/** The extractor prompt for one user message. */
export interface RoutingRequest {
	system: string;
	prompt: string;
}

/** What applying an extraction changed. */
export interface RoutingResult {
	/** Ids of the items added or changed. */
	ids: string[];
	applied: number;
	dropped: number;
}

export interface TaskfoldRouting {
	/** The prompt for `message`, or null when no list is attached or nothing can be routed. */
	prepare(message: string, agentLastTurn: string): RoutingRequest | null;
	/** Parse the extractor's `reply` and apply it for the user message `message`. Throws when the reply is unusable. */
	apply(reply: string, message: string): Promise<RoutingResult>;
}

/** Holds the installed routing port; one Pi session runs per extension process. */
export interface RoutingPort {
	current: TaskfoldRouting | null;
}

/** The process-wide port, null until the extension installs one. */
export const taskfoldRouting: RoutingPort = { current: null };
