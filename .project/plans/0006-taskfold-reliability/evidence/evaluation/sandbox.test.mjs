import { test } from "node:test";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { safePath, shellCommand } from "./sandbox.mjs";

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
