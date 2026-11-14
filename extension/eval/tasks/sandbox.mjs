import fs from "node:fs";
import path from "node:path";

function inside(root, target) {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

export function safePath(root, input) {
  if (typeof input !== "string" || !input || input.startsWith("~")) return false;
  const base = fs.realpathSync(root);
  const target = path.resolve(base, input);
  if (!inside(base, target)) return false;
  let current = target;
  for (;;) {
    try {
      const info = fs.lstatSync(current);
      if (info.isSymbolicLink()) {
        try { return inside(base, fs.realpathSync(current)); } catch { return false; }
      }
      return inside(base, fs.realpathSync(current));
    } catch (error) {
      if (error?.code !== "ENOENT") return false;
      const parent = path.dirname(current);
      if (parent === current) return false;
      current = parent;
    }
  }
}

function safeTaskStore(root) {
  const relative = ".pig/tasks";
  if (!safePath(root, relative)) return false;
  try {
    return fs.readdirSync(path.join(root, relative)).every((name) => safePath(root, path.join(relative, name)));
  } catch (error) { return error?.code === "ENOENT"; }
}

export function quote(text) { return `'${text.replaceAll("'", "'\\''")}'`; }

export function sandboxArgs(root, command, mounts = []) {
  return ["--die-with-parent", "--unshare-pid", "--unshare-net", "--new-session", "--ro-bind", "/usr", "/usr", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64", "--symlink", "usr/bin", "/bin", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--bind", root, "/work", ...mounts, "--chdir", "/work", "--clearenv", "--setenv", "HOME", "/work", "--setenv", "PATH", "/usr/bin:/bin", "/usr/bin/bash", "-c", command];
}

export function shellCommand(root, command) {
  return ["bwrap", ...sandboxArgs(root, command)].map(quote).join(" ");
}

export default function sandbox(pi) {
  pi.on("tool_call", (event, ctx) => {
    if (!["bash", "read", "edit", "write", "tasks", "unfold", "recall"].includes(event.toolName)) return { block: true, reason: "This tool is unavailable in the synthetic evaluation." };
    const messages = ctx.sessionManager.getBranch();
    const assistant = messages.findLast((entry) => entry.type === "message" && entry.message?.role === "assistant")?.message;
    const calls = Array.isArray(assistant?.content) ? assistant.content.filter((part) => part.type === "toolCall") : [];
    if (!calls.some((call) => call.id === event.toolCallId)) return { block: true, reason: "Cannot verify the evaluation tool batch." };
    if (calls.length > 1 && calls.some((call) => call.name === "bash")) return { block: true, reason: "Run shell and other tools in separate turns in this synthetic evaluation." };
    if (event.toolName === "tasks" && !safeTaskStore(ctx.cwd)) return { block: true, reason: "The synthetic task store must remain inside its project." };
    if (event.toolName === "bash") {
      event.input.command = shellCommand(ctx.cwd, event.input.command);
      return;
    }
    if (["read", "edit", "write"].includes(event.toolName) && !safePath(ctx.cwd, event.input.path)) {
      return { block: true, reason: "The synthetic evaluation permits files only inside its project." };
    }
  });
}
