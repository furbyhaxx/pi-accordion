import type { ChromeTheme } from "../chrome";
import { matchesKey } from "@earendil-works/pi-tui";
import type { TaskListsHost } from "../taskLists";
import { TASK_LEGEND, TaskViews, type TaskViewsHost, type TaskViewsStart } from "../taskViews";
import type { WidgetTheme } from "../taskWidget";
import type { PanelTab, Shell } from "./types";

/** What the task tabs need beyond the panel host; only a local session provides it. */
export interface TaskTabsHost {
	views: TaskViewsHost;
	/** Store actions for the Lists tab; null while no conductor provides the `tasks` tool. */
	lists: TaskListsHost | null;
	/** The task widget's expanded default, so the panel and the widget agree (SPEC-0001 §5.8). */
	widget?: { expanded(): boolean; setExpanded(expanded: boolean): void };
}

function taskTab(shell: Shell, id: string, title: string, tasks: TaskTabsHost, start: TaskViewsStart): PanelTab {
	const views = new TaskViews({ theme: () => shell.theme() as WidgetTheme & ChromeTheme, keys: shell.keys, say: shell.say, confirm: shell.confirm, update: shell.update }, tasks.views, start, tasks.lists);
	const widget = tasks.widget;
	return {
		id,
		title,
		view: (width, rows) => views.view(width, rows),
		key: (data) => {
			// The widget's expanded default is a session preference; the panel toggles it in place.
			if (widget && matchesKey(data, "alt+e")) {
				const next = !widget.expanded();
				widget.setExpanded(next);
				shell.say(`Task widget ${next ? "expanded" : "collapsed"} by default`, "info");
				return true;
			}
			return views.key(data);
		},
		typing: () => views.typing(),
		query: () => views.query(),
		setFilter: (query) => views.setFilter(query),
		back: () => views.back(),
		dirty: () => 0,
		discard() {},
		legend: () => TASK_LEGEND,
		dispose: () => views.dispose(),
	};
}

/** The Tasks tab: this session's transcript by task. */
export function createTasksTab(shell: Shell, tasks: TaskTabsHost): PanelTab {
	return taskTab(shell, "tasks", "Tasks", tasks, { kind: "session" });
}

/** The Lists tab: the project's task lists, drilling into tasks, details and spans. */
export function createListsTab(shell: Shell, tasks: TaskTabsHost): PanelTab {
	return taskTab(shell, "lists", "Lists", tasks, { kind: "lists" });
}
