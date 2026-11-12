import { test } from "node:test";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import sandbox, { safePath, shellCommand } from "./sandbox.mjs";

test("file paths stay within the synthetic project, including symlink targets", async () => {
  const base = await mkdtemp(join(process.cwd(), ".pi/eval-sandbox-"));
  try {
    const project = join(base, "project");
    await mkdir(project);
    await writeFile(join(base, "private"), "outside");
    await symlink(join(base, "private"), join(project, "escape"));
    await symlink(join(base, "missing"), join(project, "dangling"));
    assert.equal(safePath(project, "new/file"), true);
    assert.equal(safePath(project, "../private"), false);
    assert.equal(safePath(project, "escape"), false);
    assert.equal(safePath(project, "dangling"), false);
    assert.equal(safePath(project, "/etc/passwd"), false);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("isolated bash can work in the project but cannot see a host canary", async () => {
  const base = await mkdtemp(join(process.cwd(), ".pi/eval-shell-"));
  try {
    const project = join(base, "project");
    await mkdir(project);
    await writeFile(join(project, "inside"), "ok");
    const outside = resolve(base, "private");
    await writeFile(outside, "secret");
    const command = shellCommand(project, `test "$(cat inside)" = ok && test ! -e '${outside}' && echo isolated`);
    assert.equal(execFileSync("/usr/bin/bash", ["-c", command], { encoding: "utf8" }).trim(), "isolated");
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("a shell cannot run concurrently with a guarded tool", () => {
  let handler;
  sandbox({ on(name, callback) { assert.equal(name, "tool_call"); handler = callback; } });
  const events = [{ type: "message", message: { role: "assistant", content: [
    { type: "toolCall", id: "sh", name: "bash" },
    { type: "toolCall", id: "rd", name: "read" },
  ] } }];
  const ctx = { cwd: process.cwd(), sessionManager: { getBranch: () => events } };
  assert.equal(handler({ toolName: "bash", toolCallId: "sh", input: { command: "true" } }, ctx).block, true);
  assert.equal(handler({ toolName: "read", toolCallId: "rd", input: { path: "package.json" } }, ctx).block, true);
  events[0].message.content.pop();
  const event = { toolName: "bash", toolCallId: "sh", input: { command: "true" } };
  assert.equal(handler(event, ctx), undefined);
  assert.match(event.input.command, /bwrap/);
  assert.equal(handler({ toolName: "bash", toolCallId: "missing", input: { command: "true" } }, ctx).block, true);
});

test("task store cannot follow an outside list symlink", async () => {
  const base = await mkdtemp(join(process.cwd(), ".pi/eval-task-store-"));
  try {
    const project = join(base, "project");
    await mkdir(join(project, ".pig/tasks"), { recursive: true });
    await writeFile(join(base, "private"), "outside");
    await symlink(join(base, "private"), join(project, ".pig/tasks/list.json"));
    let handler;
    sandbox({ on(_name, callback) { handler = callback; } });
    const ctx = { cwd: project, sessionManager: { getBranch: () => [{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "task", name: "tasks" }] } }] } };
    assert.equal(handler({ toolName: "tasks", toolCallId: "task", input: { action: "list" } }, ctx).block, true);
  } finally { await rm(base, { recursive: true, force: true }); }
});
