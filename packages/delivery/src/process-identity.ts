import { execFileSync } from "node:child_process";
import { canonicalJson, digest } from "./core.ts";

export type ProcessOwnership = "match" | "lost" | "unknown";

export function processIdentity(pid: number): string | undefined {
  try {
    const startedAt = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const command = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return startedAt && command ? canonicalJson({ started_at: startedAt, argv_digest: digest(command) }) : undefined;
  } catch { return undefined; }
}

export function processOwnership(pid: number, expectedIdentity: string): ProcessOwnership {
  try { process.kill(pid, 0); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? "lost" : "unknown"; }
  const actual = processIdentity(pid);
  if (!actual) return "unknown";
  if (actual === expectedIdentity) return "match";
  try {
    const expected = JSON.parse(expectedIdentity) as { started_at?: unknown }, observed = JSON.parse(actual) as { started_at?: unknown };
    return typeof expected.started_at === "string" && typeof observed.started_at === "string" && expected.started_at !== observed.started_at ? "lost" : "unknown";
  } catch { return "unknown"; }
}

export function processOwnershipLost(pid: number, expectedIdentity: string): boolean {
  return processOwnership(pid, expectedIdentity) === "lost";
}
