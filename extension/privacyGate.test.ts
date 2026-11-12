import { describe, expect, test } from "bun:test";
import { attachPolicy, revocationEffect } from "./privacyGate";

describe("privacy gate policy", () => {
	test("a deferred conductor attaches and survives revocation with its tools, gated", () => {
		expect(attachPolicy({ privacy: { deferred: true } })).toBe("attach-and-gate");
		expect(revocationEffect({ privacy: { deferred: true } })).toBe("gate-models");
	});

	test("every other conductor needs consent before it attaches and detaches when it is revoked", () => {
		expect(attachPolicy({ privacy: {} })).toBe("consent-first");
		expect(revocationEffect({ privacy: {} })).toBe("detach");
		expect(attachPolicy({})).toBe("consent-first");
		expect(attachPolicy(undefined)).toBe("consent-first");
		expect(revocationEffect(undefined)).toBe("detach");
	});
});
