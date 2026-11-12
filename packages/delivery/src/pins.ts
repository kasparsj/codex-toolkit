import { lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { digest, requireCondition } from "./core.ts";

function files(root: string, current = root, result: Record<string, string> = {}): Record<string, string> {
  const info = lstatSync(current);
  requireCondition(!info.isSymbolicLink(), `symlink in pinned package: ${current}`);
  if (info.isFile()) { result[relative(root, current).replaceAll("\\", "/")] = digest(readFileSync(current)); return result; }
  requireCondition(info.isDirectory(), `unsupported pinned package entry: ${current}`);
  for (const name of readdirSync(current).sort()) files(root, join(current, name), result);
  return result;
}

export function hashPackage(path: string): string { return digest(files(path)); }

const RUNTIME_ARTIFACT_KEYS = new Set(["profile", "policy", "foreground_policy", "publisher_config", "executor", "checker", "reviewer", "runtime"]);

/** Hash security-relevant configuration and executable inputs, never mutable worktrees. */
export function runtimeArtifactHashes(locations: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, path] of Object.entries(locations).sort(([left], [right]) => left.localeCompare(right))) {
    if (!RUNTIME_ARTIFACT_KEYS.has(name) && !/^(executor|checker|reviewer)_arg_[0-9]+$/.test(name)) continue;
    result[name] = hashPackage(path);
  }
  return result;
}
export function skillHashes(root: string, names = ["next-issue", "plan-pr", "implement-plan", "pr-closeout"]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of names) {
    const path = join(root, name);
    requireCondition(statSync(join(path, "SKILL.md")).isFile(), `missing pinned skill package: ${path}`);
    result[name] = hashPackage(path);
  }
  return result;
}
export function verifyPins(expected: Record<string, string>, root: string): void {
  const current: Record<string, string> = {};
  for (const name of Object.keys(expected)) current[name] = hashPackage(join(root, basename(name)));
  requireCondition(JSON.stringify(current) === JSON.stringify(expected), "pinned skill source changed");
}
