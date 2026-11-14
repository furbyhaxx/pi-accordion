import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createScenario, scenarios, verifyScenario } from "./scenarios.mjs";
import { evaluate, observedDecisionBlock, run } from "./run.mjs";

const scratch = join(process.cwd(), ".pi");

test("fresh scenarios are independent, initially incomplete, and never overwrite existing directories", async () => {
  const base = await mkdtemp(join(scratch, "eval-fixtures-"));
  try {
    for (const name of Object.keys(scenarios)) {
      const dir = join(base, name);
      await createScenario(name, dir);
      assert.equal(await verifyScenario(name, dir), false, name);
      await assert.rejects(createScenario(name, dir), { code: "EEXIST" });
    }
    await writeFile(join(base, "bug/src/cart.mjs"), `import { cents } from './money.mjs'; export function total(prices, percent) { return cents(prices.reduce((sum, price) => sum + price, 0) * (1 - percent / 100)); }`);
    assert.equal(await verifyScenario("bug", join(base, "bug")), true);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("all scenario verifiers accept behavioral fixes and detect missing regression tests", async () => {
  const base = await mkdtemp(join(scratch, "eval-verifiers-"));
  try {
    for (const name of Object.keys(scenarios)) await createScenario(name, join(base, name));
    const files = {
      "refactor/src/sku.mjs": `export function normalizeSku(s) { return String(s).trim().toUpperCase(); }`,
      "refactor/src/inventory.mjs": `import { normalizeSku } from './sku.mjs'; export function inventoryKey(s) { return normalizeSku(s); }`,
      "refactor/src/shipping.mjs": `import { normalizeSku } from './sku.mjs'; export function shippingLabel(s) { return 'SKU:' + normalizeSku(s); }`,
      "bug/src/cart.mjs": `import { cents } from './money.mjs'; export function total(p, n) { return cents(p.reduce((a, b) => a+b, 0) * (1-n/100)); }`,
      "docs/src/search.mjs": `export function findName(names, query, options = {}) { return names.find(n => options.caseInsensitive ? n.toLowerCase() === query.toLowerCase() : n === query); }`,
      "docs/README.md": `findName supports case-sensitive matching by default; use caseInsensitive to ignore case.`,
      "decision/src/invoice.mjs": `export function invoiceCents(n) { return Math.floor(n * 100 + 0.50000001); }`,
      "history/src/format.mjs": `export function titleCase(v) { return String(v).split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' '); }`,
    };
    for (const [path, value] of Object.entries(files)) {
      await mkdir(join(base, path, ".."), { recursive: true });
      await writeFile(join(base, path), value);
    }
    for (const name of Object.keys(scenarios)) assert.equal(await verifyScenario(name, join(base, name)), true, name);
    const noRegression = await evaluate("bug", join(base, "bug"), base);
    assert.equal(noRegression.testsPassed, true);
    assert.equal(noRegression.regressionDetected, false);
    await writeFile(join(base, "bug/test/regression.test.mjs"), `import { test } from 'node:test'; import { strict as assert } from 'node:assert'; import { total } from '../src/cart.mjs'; test('discount', () => assert.equal(total([12.35,7.64],15),16.99));`);
    const regression = await evaluate("bug", join(base, "bug"), base);
    assert.equal(regression.behaviorPassed, true);
    assert.equal(regression.testsPassed, true);
    assert.equal(regression.regressionDetected, true);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("unavailable model is recorded as a failure", async () => {
  const base = await mkdtemp(join(scratch, "eval-failure-"));
  try {
    const result = await run({ model: "nonexistent-provider/nonexistent-model", scenario: "bug", output: join(base, "run"), timeoutMs: 10000, maxRequests: 2 });
    assert.notEqual(result.process.code, 0);
    assert.equal(result.behaviorPassed, false);
    assert.equal(result.metrics, null);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("only a successful unresolved user-decision block counts as waiting", () => {
  const action = (id, args, isError = false) => [
    { message: { role: "assistant", content: [{ type: "toolCall", id, name: "tasks", arguments: { list: "l", id: "1", ...args } }] } },
    { message: { role: "toolResult", toolCallId: id, isError } },
  ];
  const block = action("a", { action: "block", reason: "user-decision" });
  assert.equal(observedDecisionBlock([]), false);
  assert.equal(observedDecisionBlock(action("a", { action: "block", reason: "user-decision" }, true)), false);
  assert.equal(observedDecisionBlock(block), true);
  assert.equal(observedDecisionBlock([...block, ...action("b", { action: "start" })]), false);
  assert.equal(observedDecisionBlock(action("a", { action: "block", reason: "third-party" })), false);
});
