import { spawn } from "node:child_process";
import { closeSync, constants, existsSync, lstatSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { processIdentity } from "./process-identity.ts";

interface Job {
  schema_version: 1;
  execution_id: string;
  record_path: string;
  cancel_path: string;
  argv: [string, ...string[]];
  cwd: string;
  env: Record<string, string>;
  packet: Record<string, unknown>;
  timeout_ms: number;
  max_output_bytes: number;
}

type Status = "running" | "completed" | "failed" | "cancelled" | "timeout";
interface RecordValue { execution_id: string; status: Status; worker_pid?: number; worker_process_identity?: string; target_pid?: number; target_process_identity?: string; result?: Record<string, unknown>; error?: string; diagnostics?: string }

function privateJson(path: string): unknown {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > 8 * 1024 * 1024) throw new Error("unsafe executable worker input");
  return JSON.parse(readFileSync(path, "utf8"));
}

function atomic(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}`;
  const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try { writeFileSync(fd, `${JSON.stringify(value)}\n`); } finally { closeSync(fd); }
  renameSync(temporary, path);
}

function append(current: string, chunk: Buffer, limit: number): { text: string; overflow: boolean } {
  const text = current + chunk.toString("utf8");
  return Buffer.byteLength(text) > limit ? { text: current, overflow: true } : { text, overflow: false };
}

function result(text: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(text.trim()); } catch (error) { throw new Error(`launcher produced invalid JSON: ${error instanceof Error ? error.message : String(error)}`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("launcher result must be one JSON object");
  return value as Record<string, unknown>;
}

async function main(jobPath: string): Promise<void> {
  const job = privateJson(jobPath) as Job;
  if (job.schema_version !== 1 || !Array.isArray(job.argv) || !job.argv.length || typeof job.execution_id !== "string") throw new Error("invalid executable worker job");
  const [command, ...args] = job.argv;
  const child = spawn(command, args, { cwd: job.cwd, env: job.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let stdout = ""; let stderr = ""; let overflow = false; let timedOut = false; let cancelled = false; let finished = false;
  let ownership: Pick<RecordValue, "worker_pid" | "worker_process_identity" | "target_pid" | "target_process_identity"> = {};
  const publish = (value: RecordValue) => { if (!finished || value.status === "running") atomic(job.record_path, { ...ownership, ...value }); if (value.status !== "running") finished = true; };
  const workerIdentity = processIdentity(process.pid), targetIdentity = child.pid ? processIdentity(child.pid) : undefined;
  if (!workerIdentity || !child.pid || !targetIdentity) { child.kill("SIGTERM"); publish({ execution_id: job.execution_id, status: "failed", error: "executable worker could not establish process ownership identity" }); return; }
  ownership = { worker_pid: process.pid, worker_process_identity: workerIdentity, target_pid: child.pid, target_process_identity: targetIdentity };
  publish({ execution_id: job.execution_id, status: "running" });
  child.stdout.on("data", (chunk: Buffer) => { const next = append(stdout, chunk, job.max_output_bytes); stdout = next.text; if (next.overflow) { overflow = true; child.kill("SIGTERM"); } });
  child.stderr.on("data", (chunk: Buffer) => { const next = append(stderr, chunk, job.max_output_bytes); stderr = next.text; if (next.overflow) { overflow = true; child.kill("SIGTERM"); } });
  child.stdin.on("error", () => undefined);
  child.stdin.end(`${JSON.stringify(job.packet)}\n`);
  const timeout = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 1_000).unref(); }, job.timeout_ms);
  const cancellation = setInterval(() => { if (!cancelled && existsSync(job.cancel_path)) { cancelled = true; child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 1_000).unref(); } }, 25);
  await new Promise<void>((accept) => {
    child.once("error", (error) => { clearTimeout(timeout); clearInterval(cancellation); publish({ execution_id: job.execution_id, status: "failed", error: error.message, diagnostics: stderr }); accept(); });
    child.once("close", (code, signal) => {
      clearTimeout(timeout); clearInterval(cancellation);
      if (finished) return accept();
      if (cancelled) publish({ execution_id: job.execution_id, status: "cancelled", diagnostics: stderr });
      else if (overflow) publish({ execution_id: job.execution_id, status: "failed", error: `launcher output exceeded ${job.max_output_bytes} bytes`, diagnostics: stderr });
      else if (timedOut) publish({ execution_id: job.execution_id, status: "timeout", error: `launcher exceeded ${job.timeout_ms}ms`, diagnostics: stderr });
      else if (code !== 0) publish({ execution_id: job.execution_id, status: "failed", error: `launcher exited ${code ?? signal ?? "unknown"}`, diagnostics: stderr });
      else { try { publish({ execution_id: job.execution_id, status: "completed", result: result(stdout), diagnostics: stderr }); } catch (error) { publish({ execution_id: job.execution_id, status: "failed", error: error instanceof Error ? error.message : String(error), diagnostics: stderr }); } }
      accept();
    });
  });
}

const jobPath = process.argv[2];
if (!jobPath) throw new Error("executable worker job path required");
await main(jobPath);
