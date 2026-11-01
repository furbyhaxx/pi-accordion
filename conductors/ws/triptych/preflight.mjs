/*
 * Triptych's runtime readiness gate. Static host readiness deliberately stays generic and cheap:
 * it proves the runner and declared packages resolve. Before the runner dials Accordion, this gate
 * proves the defining tree-sitter engine can actually initialize every grammar. A corrupt or
 * incompatible install therefore exits before Triptych can attach as a summaries-only conductor.
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

function hasRustGrammar() {
  try {
    const pkg = require.resolve("tree-sitter-wasms/package.json");
    return existsSync(path.join(path.dirname(pkg), "out", "tree-sitter-rust.wasm"));
  } catch {
    return false;
  }
}

export async function initializeSkeletonizer(skeletonizer, rustGrammarInstalled = hasRustGrammar) {
  if (!skeletonizer || typeof skeletonizer.init !== "function" || typeof skeletonizer.ready !== "function") {
    throw new Error("skeleton engine does not implement init()/ready()");
  }

  if (!rustGrammarInstalled()) throw new Error("rust grammar not installed (tree-sitter-wasms)");
  await skeletonizer.init();
  if (!skeletonizer.ready()) throw new Error("skeleton engine initialization completed without becoming ready");
}
