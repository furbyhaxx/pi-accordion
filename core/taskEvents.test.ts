import { describe, expect, it } from "vitest";
import { TaskEventQueue, outerCallId, taskEventsIn, withTaskEvents, type TaskEvent } from "./taskEvents";

const ev = (action: TaskEvent["action"], id: string): TaskEvent => ({ action, list: "w", id });

describe("task events", () => {
	it("queues nested executions under the model-issued call, in order", () => {
		const q = new TaskEventQueue();
		expect(q.queue("call_1", ev("start", "1"))).toBe(false);
		expect(q.queue("call_2/1", ev("complete", "1"))).toBe(true);
		expect(q.queue("call_2/1/3", ev("start", "2"))).toBe(true);
		expect(q.take("call_2")).toEqual([ev("complete", "1"), ev("start", "2")]);
		expect(q.take("call_2")).toEqual([]);
		expect(outerCallId("a/b/c")).toBe("a");
	});

	it("merges into the outer details without losing the tool's own fields", () => {
		expect(withTaskEvents({ calls: 2, taskEvents: [ev("start", "1")] }, [ev("complete", "1")])).toEqual({ calls: 2, taskEvents: [ev("start", "1"), ev("complete", "1")] });
		expect(withTaskEvents(undefined, [ev("start", "1")])).toEqual({ taskEvents: [ev("start", "1")] });
		expect(withTaskEvents({ a: 1 }, [])).toBeNull();
		expect(withTaskEvents("text", [ev("start", "1")])).toBeNull();
	});

	it("reads only well-formed lifecycle events", () => {
		expect(taskEventsIn({ taskEvents: [ev("start", "1"), { action: "list", list: "w", id: "1" }, null, { action: "complete", list: "w" }] })).toEqual([ev("start", "1")]);
		expect(taskEventsIn(undefined)).toEqual([]);
	});
});
