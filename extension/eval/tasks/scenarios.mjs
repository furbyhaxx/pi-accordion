import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

const packageFile = JSON.stringify({ name: "taskfold-eval", private: true, type: "module", scripts: { test: "node --test" } }, null, 2) + "\n";

export const scenarios = {
  refactor: {
    prompt: "Extract the repeated SKU normalization in src/inventory.mjs and src/shipping.mjs into src/sku.mjs, exporting normalizeSku. Preserve their existing behavior and tests. Run the tests.",
    files: {
      "src/inventory.mjs": `export function inventoryKey(sku) { return String(sku).trim().toUpperCase(); }\n`,
      "src/shipping.mjs": `export function shippingLabel(sku) { return 'SKU:' + String(sku).trim().toUpperCase(); }\n`,
      "test/inventory.test.mjs": `import { test } from 'node:test';\nimport { strict as assert } from 'node:assert';\nimport { inventoryKey } from '../src/inventory.mjs';\nimport { shippingLabel } from '../src/shipping.mjs';\ntest('keys', () => { assert.equal(inventoryKey(' a-1 '), 'A-1'); assert.equal(shippingLabel(' a-1 '), 'SKU:A-1'); });\n`,
    },
  },
  bug: {
    prompt: "Cart discounts are calculated incorrectly. Fix src/cart.mjs so the percentage discount applies to the whole cart total, then add a regression test including a fractional-cent result. Run the tests.",
    files: {
      "src/money.mjs": `export function cents(value) { return Math.round((value + Number.EPSILON) * 100) / 100; }\n`,
      "src/cart.mjs": `export function total(prices, percent) { return prices.reduce((sum, price) => sum + price, 0) - percent; }\n`,
      "test/cart.test.mjs": `import { test } from 'node:test';\nimport { strict as assert } from 'node:assert';\nimport { total } from '../src/cart.mjs';\ntest('without discount', () => assert.equal(total([10, 5], 0), 15));\n`,
    },
  },
  docs: {
    prompt: "Add an optional case-insensitive mode to findName(names, query, options), enabled by { caseInsensitive: true }. Keep the default case-sensitive. Document both modes and add tests, then run the tests.",
    files: {
      "src/search.mjs": `export function findName(names, query) { return names.find((name) => name === query); }\n`,
      "README.md": `# Names\n\nfindName(names, query) finds an exact case-sensitive name.\n`,
      "test/search.test.mjs": `import { test } from 'node:test';\nimport { strict as assert } from 'node:assert';\nimport { findName } from '../src/search.mjs';\ntest('exact match', () => assert.equal(findName(['Ada'], 'Ada'), 'Ada'));\n`,
    },
  },
  decision: {
    prompt: "Implement invoice rounding in src/invoice.mjs and add tests. The rounding policy is a product decision: ask the user which policy to use before implementing it. Wait for their answer, then finish and test the implementation.",
    answer: "Use round half up to the nearest whole cent, including half cents. Continue and finish the task.",
    files: {
      "src/invoice.mjs": `export function invoiceCents(amount) { throw new Error('rounding policy not decided'); }\n`,
      "test/invoice.test.mjs": `import { test } from 'node:test';\nimport { strict as assert } from 'node:assert';\nimport { invoiceCents } from '../src/invoice.mjs';\ntest('exact cent', () => assert.equal(invoiceCents(1.23), 123));\n`,
    },
  },
};

// Comprehension of a folded record: after the work is folded away, the model must still know what it
// did, from the record rather than from re-reading files. Phase two asks; the answer is checked.
scenarios.history = {
  prompt: "Add a helper src/format.mjs exporting titleCase(value) that upper-cases the first letter of each space-separated word and leaves the rest unchanged, plus a test, then run the tests. Track the work with the tasks tool and complete its tasks before you reply.",
  followup: "Without reading any files, state in three lines: which file you created, which test command you ran, and what its result was. Answer only from what this conversation still shows you.",
  files: {
    "README.md": "# Format helpers\n\nNone yet.\n",
    "test/format.test.mjs": `import { test } from 'node:test';\nimport { strict as assert } from 'node:assert';\nimport { titleCase } from '../src/format.mjs';\ntest('title', () => assert.equal(titleCase('hello wide world'), 'Hello Wide World'));\n`,
  },
};

export async function createScenario(name, directory) {
  const scenario = scenarios[name];
  if (!scenario) throw new Error(`Unknown scenario: ${name}`);
  await mkdir(directory);
  await writeFile(join(directory, "package.json"), packageFile);
  for (const [file, content] of Object.entries(scenario.files)) {
    await mkdir(join(directory, file, ".."), { recursive: true });
    await writeFile(join(directory, file), content);
  }
}

export async function verifyScenario(name, directory) {
  const load = async (file) => import(`${pathToFileURL(join(directory, file)).href}?run=${randomUUID()}`);
  try {
    if (name === "refactor") {
      const sku = await load("src/sku.mjs");
      const inventory = await load("src/inventory.mjs");
      const shipping = await load("src/shipping.mjs");
      const sources = await Promise.all(["src/inventory.mjs", "src/shipping.mjs"].map((file) => readFile(join(directory, file), "utf8")));
      return sku.normalizeSku(" ab-9 ") === "AB-9" && inventory.inventoryKey(" ab-9 ") === "AB-9" && shipping.shippingLabel(" ab-9 ") === "SKU:AB-9" && sources.every((s) => s.includes("sku.mjs"));
    }
    if (name === "bug") {
      const cart = await load("src/cart.mjs");
      return cart.total([12.35, 7.64], 15) === 16.99 && cart.total([10, 5], 0) === 15;
    }
    if (name === "docs") {
      const search = await load("src/search.mjs");
      const doc = await readFile(join(directory, "README.md"), "utf8");
      return search.findName(["Ada"], "ada") === undefined && search.findName(["Ada"], "ada", { caseInsensitive: true }) === "Ada" && /caseInsensitive/.test(doc) && /case.sensitive/i.test(doc);
    }
    if (name === "history") {
      const format = await load("src/format.mjs");
      return format.titleCase("hello wide world") === "Hello Wide World" && format.titleCase("a b") === "A B";
    }
    if (name === "decision") {
      const invoice = await load("src/invoice.mjs");
      return invoice.invoiceCents(1.23) === 123 && invoice.invoiceCents(1.235) === 124 && invoice.invoiceCents(1.234) === 123;
    }
    throw new Error(`Unknown scenario: ${name}`);
  } catch {
    return false;
  }
}
