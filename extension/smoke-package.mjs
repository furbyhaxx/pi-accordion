import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
if (result.error || result.status !== 0) throw new Error(`npm pack --dry-run failed: ${result.error?.message ?? result.stderr}`);
const parsed = JSON.parse(result.stdout);
const pack = Array.isArray(parsed) ? parsed[0] : Object.values(parsed).find((value) => Array.isArray(value?.files));
if (!pack || !Array.isArray(pack.files)) throw new Error("npm pack did not report package files");
const files = pack.files.map((entry) => entry.path);
const privateFiles = files.filter((file) => /^(?:\.project|\.pig|\.pi|\.worktrees)\//.test(file) || /(?:^|\/)node_modules\//.test(file));
if (privateFiles.length) throw new Error(`Development or installed dependency files would ship: ${privateFiles.slice(0, 5).join(", ")}`);
for (const file of ["app/package.json", "app/package-lock.json", "extension/accordion.ts", "core/truth.ts", "conductors/in-process/taskfold/taskfold.ts", "extension/skills/accordion-task-lists/SKILL.md", "extension/skills/accordion-task-lists/scripts/validate.mjs"]) {
	if (!files.includes(file)) throw new Error(`Required package file missing: ${file}`);
}
if (fs.existsSync(path.join(root, "extension/dist/client/index.html")) && !files.includes("extension/dist/client/index.html")) throw new Error("The built browser index is missing from the package");
console.log("smoke-package: package contains runtime and skill files without development artifacts or installed dependencies");
