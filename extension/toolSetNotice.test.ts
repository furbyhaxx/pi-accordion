import { describe, expect, test } from "bun:test";
import { toolSetNotice } from "./toolSetNotice";

describe("tool set notice", () => {
	test("stays silent when nothing changed", () => {
		expect(toolSetNotice([], [])).toBeNull();
		expect(toolSetNotice(["tasks"], ["tasks"])).toBeNull();
	});

	test("names additions and removals", () => {
		expect(toolSetNotice([], ["tasks"])).toBe("Tool availability changed: `tasks` is available now.");
		expect(toolSetNotice(["tasks"], [])).toBe("Tool availability changed: `tasks` is no longer available.");
		expect(toolSetNotice(["tasks"], ["tasks", "recall"])).toBe("Tool availability changed: `recall` is available now.");
	});

	test("reports both directions in one line", () => {
		expect(toolSetNotice(["tasks"], ["recall"])).toBe(
			"Tool availability changed: `recall` is available now; `tasks` is no longer available.",
		);
	});
});
