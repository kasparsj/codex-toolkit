import { spawn } from "node:child_process";
import { closeSync, constants, existsSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse } from "node:path";
import { fileURLToPath } from "node:url";
import type { RpcInput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { runnerControlRpc, workspaceCommandRpc, workspaceSetupRpc, workspaceSnapshotSchema, workspaceStatusRpc } from "../shared/rpc.ts";

const MAX_OUTPUT = 2 * 1024 * 1024;
const TIMEOUT_MS = 30_000;

export class DeliveryCommandOutcomeUncertainError extends Error {
  readonly code = "COMMAND_OUTCOME_UNCERTAIN";
  constructor() { super("The local command did not finish within the dashboard wait period. Its outcome is unknown; refresh this repository before retrying the exact request."); }
}

interface Config { argv: [string, ...string[]]; workspaceOperatorGrant?: string }

function ownerOnlyFile(path: string): string {
  if (!isAbsolute(path)) throw new Error("dashboard config path must be absolute");
  const parent = dirname(path); const parentStat = lstatSync(parent); const fileStat = lstatSync(path);
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory() || (parentStat.mode & 0o077) !== 0) throw new Error("dashboard config directory must be owner-only and not a symlink");
  if (fileStat.isSymbolicLink() || !fileStat.isFile() || (fileStat.mode & 0o077) !== 0) throw new Error("dashboard config must be an owner-only regular file");
  if (typeof process.getuid === "function" && (parentStat.uid !== process.getuid() || fileStat.uid !== process.getuid())) throw new Error("dashboard config must be owned by the daemon user");
  if (realpathSync(path) !== path || realpathSync(parent) !== parent) throw new Error("dashboard config must not traverse symlinks");
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try { const bytes = readFileSync(fd); if (bytes.length > 64 * 1024) throw new Error("dashboard config exceeds 64 KiB"); return bytes.toString("utf8"); }
  finally { closeSync(fd); }
}

function config(): Config {
  const configuredPath = process.env.PASEO_DELIVERY_DASHBOARD_CONFIG ?? join(homedir(), ".config", "codex-toolkit", "delivery-v2", "dashboard.json");
  if (existsSync(configuredPath)) {
    const parsed = JSON.parse(ownerOnlyFile(configuredPath)) as Record<string, unknown>;
    const argv = parsed.cliArgv;
    if (!Array.isArray(argv) || !argv.length || !argv.every((value) => typeof value === "string") || !isAbsolute(argv[0] as string)) throw new Error("Toolkit Delivery cliArgv must start with an absolute trusted executable");
    const workspaceOperatorGrant = parsed.workspaceOperatorGrant;
    if (workspaceOperatorGrant !== undefined && (typeof workspaceOperatorGrant !== "string" || workspaceOperatorGrant.length < 16 || workspaceOperatorGrant.length > 4096)) throw new Error("Toolkit Delivery workspaceOperatorGrant is invalid");
    return { argv: argv as [string, ...string[]], ...(typeof workspaceOperatorGrant === "string" ? { workspaceOperatorGrant } : {}) };
  }
  const sourceCli = resolveSourceCli(typeof import.meta.url === "string" ? import.meta.url : undefined);
  return { argv: [process.execPath, "--experimental-strip-types", sourceCli] };
}

export function resolveSourceCli(moduleUrl: string | undefined): string {
  if (!moduleUrl) throw new Error("Toolkit Delivery engine location is unavailable in this bundled plugin runtime. Configure an owner-only dashboard cliArgv.");
  let cursor = dirname(fileURLToPath(moduleUrl));
  for (;;) {
    const packageRoot = join(cursor, "packages", "delivery");
    const sourceCli = join(packageRoot, "src", "cli.ts");
    const packageJson = join(packageRoot, "package.json");
    if (existsSync(sourceCli) && existsSync(packageJson)) {
      try {
        const metadata = JSON.parse(readFileSync(packageJson, "utf8")) as { name?: unknown };
        if (metadata.name === "@codex-toolkit/delivery") return sourceCli;
      } catch { /* keep searching only the trusted module ancestor chain */ }
    }
    const parent = dirname(cursor);
    if (parent === cursor || cursor === parse(cursor).root) break;
    cursor = parent;
  }
  throw new Error("Toolkit Delivery engine is not installed. Configure an owner-only dashboard cliArgv or install the repository package beside this plugin.");
}

function cleanEnvironment(operatorGrant?: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "DELIVERY_REGISTRY_DIR", "GH_CONFIG_DIR", "XDG_CONFIG_HOME"]) if (process.env[key] !== undefined) environment[key] = process.env[key];
  if (operatorGrant) environment.DELIVERY_OPERATOR_GRANT = operatorGrant;
  if (process.env.ELECTRON_RUN_AS_NODE !== undefined || process.execPath.includes("Paseo Helper")) environment.ELECTRON_RUN_AS_NODE = "1";
  return environment;
}

export async function runWorkspaceCli(command: string, directory: string, args: string[] = [], input?: unknown, timeoutMs = TIMEOUT_MS): Promise<unknown> {
  const configured = config();
  const [executable, ...prefix] = configured.argv;
  const readOnly = command === "workspace-status";
  const child = spawn(executable, [...prefix, command, "--directory", directory, ...args], {
    cwd: directory, env: cleanEnvironment(configured.workspaceOperatorGrant), stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], windowsHide: true,
  });
  if (input !== undefined) child.stdin!.end(`${JSON.stringify(input)}\n`);
  let stdout = "", stderr = "", overflow = false;
  const append = (current: string, chunk: Buffer) => {
    if (overflow) return current;
    const next = current + chunk.toString("utf8");
    if (Buffer.byteLength(next) > MAX_OUTPUT) { overflow = true; if (readOnly) child.kill("SIGTERM"); return current; }
    return next;
  };
  child.stdout!.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
  child.stderr!.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
  let code: number | null;
  try {
    code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => { if (readOnly) child.kill("SIGTERM"); reject(readOnly ? new Error("Delivery CLI timed out") : new DeliveryCommandOutcomeUncertainError()); }, timeoutMs);
      child.once("error", reject); child.once("close", (value) => { clearTimeout(timer); resolve(value); });
    });
  } catch (error) {
    if (error instanceof DeliveryCommandOutcomeUncertainError || error instanceof Error && error.message === "Delivery CLI timed out") throw error;
    throw new Error("Delivery CLI could not start");
  }
  if (overflow) throw readOnly ? new Error("Delivery CLI output exceeded the safe limit") : new DeliveryCommandOutcomeUncertainError();
  let envelope: unknown;
  try { envelope = JSON.parse(stdout.trim()); } catch { throw readOnly ? new Error(`Delivery CLI returned an invalid response${stderr ? ": command diagnostics are available in plugin logs" : ""}`) : new DeliveryCommandOutcomeUncertainError(); }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) throw readOnly ? new Error("Delivery CLI envelope must be an object") : new DeliveryCommandOutcomeUncertainError();
  const object = envelope as Record<string, unknown>;
  if (code !== 0 || object.ok !== true) {
    const error = object.error && typeof object.error === "object" ? object.error as Record<string, unknown> : undefined;
    if (!readOnly && object.ok !== false) throw new DeliveryCommandOutcomeUncertainError();
    const errorCode = typeof error?.code === "string" && /^[A-Z0-9_:-]{1,80}$/.test(error.code) ? error.code : "COMMAND_FAILED";
    const safeMessage = typeof error?.message === "string" ? error.message.replace(/(?:\/[A-Za-z0-9_.-]+){2,}/g, "[path]").replace(/[\r\n\t]+/g, " ").slice(0, 300) : "Delivery command failed";
    throw new Error(`${errorCode}: ${safeMessage}`);
  }
  return object.data;
}

async function workspaceDirectory(workspaceId: string, context: PluginHandlerContext): Promise<string> {
  const workspace = context.paseo.workspaces.ref(workspaceId);
  const descriptor = await workspace.refresh();
  if (!descriptor || descriptor.archivingAt) throw new Error("The selected Paseo workspace is unavailable");
  const directory = workspace.directory ?? descriptor.workspaceDirectory;
  if (!directory || !isAbsolute(directory)) throw new Error("The selected Paseo workspace has no local directory");
  return directory;
}

async function statusFor(workspaceId: string, context: PluginHandlerContext) {
  const directory = await workspaceDirectory(workspaceId, context);
  return workspaceSnapshotSchema.parse(await runWorkspaceCli("workspace-status", directory));
}

export async function workspaceStatus(input: RpcInput<typeof workspaceStatusRpc>, context: PluginHandlerContext) {
  return statusFor(input.workspaceId, context);
}

export async function workspaceSetup(input: RpcInput<typeof workspaceSetupRpc>, context: PluginHandlerContext) {
  const directory = await workspaceDirectory(input.workspaceId, context);
  const result = await runWorkspaceCli("workspace-setup", directory, ["--expected-revision", String(input.expectedRevision), "--expected-scope", input.expectedScope, "--request-id", input.requestId], input.setup);
  try { return workspaceSnapshotSchema.parse(result); } catch { throw new DeliveryCommandOutcomeUncertainError(); }
}

export async function runnerControl(input: RpcInput<typeof runnerControlRpc>, context: PluginHandlerContext) {
  const directory = await workspaceDirectory(input.workspaceId, context);
  const result = await runWorkspaceCli("runner-control", directory, ["--expected-revision", String(input.expectedRevision), "--expected-scope", input.expectedScope, "--request-id", input.requestId, "--action", input.action, ...(input.issue ? ["--issue", String(input.issue)] : [])]);
  try { return workspaceSnapshotSchema.parse(result); } catch { throw new DeliveryCommandOutcomeUncertainError(); }
}

export async function workspaceCommand(input: RpcInput<typeof workspaceCommandRpc>, context: PluginHandlerContext) {
  const directory = await workspaceDirectory(input.workspaceId, context);
  if ((input.action === "publish_plan" || input.action === "publish_implementation") && !input.draftDigest) throw new Error("Publishing requires the exact projected draft digest");
  const result = await runWorkspaceCli("workspace-command", directory, ["--delivery-id", input.deliveryId, "--expected-revision", String(input.expectedRevision), "--expected-scope", input.expectedScope, "--request-id", input.requestId, "--action", input.action, ...(input.draftDigest ? ["--digest", input.draftDigest] : [])]);
  try { return workspaceSnapshotSchema.parse(result); } catch { throw new DeliveryCommandOutcomeUncertainError(); }
}
