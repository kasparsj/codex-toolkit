import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { processIdentity as currentProcessIdentity, processOwnership } from "./process-identity.ts";
import { canonicalJson, digest, repoIdentity, requireCondition } from "./core.ts";
import { acquireDirectoryLockSync, ensurePrivateDirectorySync, readDirectoryLockOwnerSync, recoverDirectoryLockSync, releaseDirectoryLockSync, type DirectoryIdentity, type DirectoryLockOwner } from "./locks.ts";
import { AdapterReceiptStore, type AdapterReceipt } from "./adapter-receipts.ts";
import type { AdapterOutcome, AdapterOutcomeExpectedContext, AdapterOutcomeProofResolution, AdapterRole } from "./ports.ts";

export type ExecutionStatus = "running" | "completed" | "failed" | "cancelled" | "permission" | "timeout" | "uncertain";

export interface ExecutionRecord {
  execution_id: string;
  status: ExecutionStatus;
  result?: Record<string, unknown>;
  error?: string;
  diagnostics?: string;
}

export interface ExecutorAdapter {
  dispatch(packet: Record<string, unknown>): Promise<Record<string, unknown>>;
  inspect(executionId: string): Promise<Record<string, unknown>>;
  collect(executionId: string): Promise<Record<string, unknown>>;
  cancel(executionId: string): Promise<Record<string, unknown>>;
  resolveOutcomeProof?(outcome: AdapterOutcome, expectedContext: AdapterOutcomeExpectedContext): Promise<AdapterOutcomeProofResolution>;
}

const DEFAULT_LIMIT = 1024 * 1024;
const PASEO_CODEX_ASSISTANT_BOUNDARY = "\n\n---\n\n";
const execFileAsync = promisify(execFile);
const FULL_SHA = /^[0-9a-f]{40}$/;
const SAFE_REF = /^(?!-)(?!.*\.\.)(?!.*[\s~^:?*\[\\])[^/]+(?:\/[^/]+)*$/;

function oneJsonObject(text: string, label: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error(`${label} produced no JSON result`);
  let value: unknown;
  try { value = JSON.parse(trimmed); } catch (error) {
    throw new Error(`${label} produced invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} result must be one JSON object`);
  return value as Record<string, unknown>;
}

function boundedAppend(current: string, chunk: Buffer, limit: number, label: string): string {
  const next = current + chunk.toString("utf8");
  if (Buffer.byteLength(next) > limit) throw new Error(`${label} exceeded ${limit} bytes`);
  return next;
}

function cleanEnvironment(allowed: readonly string[], additions: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of allowed) if (process.env[key] !== undefined) env[key] = process.env[key];
  for (const [key, value] of Object.entries(additions)) env[key] = value;
  return env;
}

function stableUuid(value: string): string {
  const chars = createHash("sha256").update(value).digest("hex").slice(0, 32).split("");
  chars[12] = "5"; chars[16] = ((Number.parseInt(chars[16]!, 16) & 0x3) | 0x8).toString(16);
  const hex = chars.join(""); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface ExecutableAdapterOptions {
  argv: readonly [string, ...string[]];
  cwd: string;
  stateDir: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  allowedEnvironment?: readonly string[];
  environment?: Readonly<Record<string, string>>;
}

export class ExecutableJsonAdapter implements ExecutorAdapter {
  readonly options: ExecutableAdapterOptions;
  constructor(options: ExecutableAdapterOptions) {
    if (!isAbsolute(options.stateDir)) throw new Error("executable stateDir must be absolute");
    mkdirSync(options.stateDir, { recursive: true, mode: 0o700 });
    const info = lstatSync(options.stateDir);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new Error("executable stateDir must be an owner-only directory");
    this.options = { ...options, stateDir: resolve(options.stateDir) };
  }

  async dispatch(packet: Record<string, unknown>): Promise<Record<string, unknown>> {
    const taskId = packet.task_id;
    if (typeof taskId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(taskId)) throw new Error("executable dispatch requires a stable task_id from the durable engine intent");
    const executionId = `process:${taskId}`;
    const paths = this.#paths(executionId);
    if (existsSync(paths.record)) return this.#public(this.#read(executionId)) as unknown as Record<string, unknown>;
    try { mkdirSync(paths.directory, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      for (let attempt = 0; attempt < 50 && !existsSync(paths.record); attempt += 1) await new Promise((accept) => setTimeout(accept, 10));
      if (existsSync(paths.record)) return this.#current(executionId) as unknown as Record<string, unknown>;
      throw new Error("executable dispatch intent exists without a readable receipt");
    }
    const job = { schema_version: 1, execution_id: executionId, record_path: paths.record, cancel_path: paths.cancel, argv: this.options.argv, cwd: this.options.cwd, env: cleanEnvironment(this.options.allowedEnvironment ?? ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"], this.options.environment ?? {}), packet, timeout_ms: this.options.timeoutMs ?? 15 * 60_000, max_output_bytes: this.options.maxOutputBytes ?? DEFAULT_LIMIT };
    this.#atomic(paths.job, job);
    const initial: StoredExecution = { execution_id: executionId, status: "running", started_at: new Date().toISOString() };
    this.#atomic(paths.record, initial);
    const workerPath = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./executable-worker.ts" : "./executable-worker.js", import.meta.url));
    const worker = spawn(process.execPath, [...(workerPath.endsWith(".ts") ? ["--experimental-strip-types"] : []), workerPath, paths.job], { detached: true, stdio: "ignore", windowsHide: true });
    try { await new Promise<void>((accept, reject) => { worker.once("spawn", accept); worker.once("error", reject); }); }
    catch (error) { const failed: StoredExecution = { execution_id: executionId, status: "failed", error: error instanceof Error ? error.message : String(error) }; this.#atomic(paths.record, failed); return this.#public(failed) as unknown as Record<string, unknown>; }
    worker.unref();
    for (let attempt = 0; attempt < 100; attempt += 1) { const record = this.#read(executionId); if (record.worker_pid || record.status !== "running") return this.#public(record) as unknown as Record<string, unknown>; await new Promise((accept) => setTimeout(accept, 10)); }
    return this.#public(initial) as unknown as Record<string, unknown>;
  }

  async inspect(executionId: string): Promise<Record<string, unknown>> { return this.#current(executionId) as unknown as Record<string, unknown>; }
  async collect(executionId: string): Promise<Record<string, unknown>> {
    const deadline = Date.now() + (this.options.timeoutMs ?? 15 * 60_000) + 10_000;
    let uncertaintyDeadline: number | undefined;
    while (Date.now() < deadline) {
      const current = this.#current(executionId);
      if (current.status === "uncertain") {
        uncertaintyDeadline ??= Date.now() + 500;
        if (Date.now() >= uncertaintyDeadline) return current as unknown as Record<string, unknown>;
      } else if (current.status !== "running") return current as unknown as Record<string, unknown>;
      await new Promise((accept) => setTimeout(accept, 20));
    }
    return { execution_id: executionId, status: "uncertain", error: "executable worker did not publish a terminal record" };
  }
  async cancel(executionId: string): Promise<Record<string, unknown>> {
    const current = this.#current(executionId);
    if (current.status === "running") {
      const paths = this.#paths(executionId); this.#atomic(paths.cancel, { requested_at: new Date().toISOString() });
      const deadline = Date.now() + 6_000;
      while (Date.now() < deadline) {
        const observed = this.#current(executionId);
        // The worker can exit immediately after atomically publishing its terminal
        // receipt. A concurrent read may still hold the prior running record and
        // briefly classify that exit as uncertain; wait for the durable terminal
        // receipt instead of exposing that transition as the cancellation result.
        if (observed.status !== "running" && observed.status !== "uncertain") return observed as unknown as Record<string, unknown>;
        await new Promise((accept) => setTimeout(accept, 20));
      }
      return { execution_id: executionId, status: "uncertain", error: "launcher did not publish a terminal record after cancellation" };
    }
    return current as unknown as Record<string, unknown>;
  }
  async resolveOutcomeProof(outcome: AdapterOutcome, expectedContext: AdapterOutcomeExpectedContext): Promise<AdapterOutcomeProofResolution> {
    return this.#receiptStore(expectedContext.role).resolve(outcome, expectedContext);
  }
  #paths(id: string) { const directory = join(this.options.stateDir, createHash("sha256").update(id).digest("hex")); return { directory, job: join(directory, "job.json"), record: join(directory, "record.json"), cancel: join(directory, "cancel.json") }; }
  #atomic(path: string, value: unknown): void { const temporary = `${path}.${process.pid}.${randomUUID()}`; const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); try { writeFileSync(fd, `${JSON.stringify(value)}\n`); } finally { closeSync(fd); } renameSync(temporary, path); }
  #read(id: string): StoredExecution { const path = this.#paths(id).record; if (!existsSync(path)) throw new Error(`unknown execution ${id}`); const info = lstatSync(path); if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > DEFAULT_LIMIT) throw new Error("unsafe executable execution record"); const value = JSON.parse(readFileSync(path, "utf8")) as StoredExecution; if (value.execution_id !== id || !["running", "completed", "failed", "cancelled", "timeout", "uncertain"].includes(value.status)) throw new Error("invalid executable execution record"); return value; }
  #current(id: string): ExecutionRecord { const stored = this.#read(id); if (stored.status === "running" && stored.worker_pid) { if (!stored.worker_process_identity) return { execution_id: id, status: "uncertain", error: "executable worker ownership record lacks a process identity" }; const ownership = processOwnership(stored.worker_pid, stored.worker_process_identity); if (ownership !== "match") return { execution_id: id, status: "uncertain", error: ownership === "lost" ? "executable worker ownership was lost" : "executable worker ownership cannot be proven" }; } if (stored.status === "running" && !stored.worker_pid && stored.started_at && Date.now() - Date.parse(stored.started_at) > 2_000) return { execution_id: id, status: "uncertain", error: "executable worker did not claim its durable intent" }; return this.#public(stored); }
  #public(record: StoredExecution): ExecutionRecord {
    const { execution_id, status, result, error, diagnostics } = record;
    const legacy = { execution_id, status, ...(result ? { result } : {}), ...(error ? { error } : {}), ...(diagnostics ? { diagnostics } : {}) };
    try {
      const job = JSON.parse(readFileSync(this.#paths(execution_id).job, "utf8")) as { packet?: Record<string, unknown> };
      const packet = job.packet, role: AdapterRole = packet?.kind === "review" ? "reviewer" : "agent";
      if (!packet || typeof packet.repo !== "string" || typeof packet.delivery_id !== "string" || typeof packet.task_id !== "string") return legacy;
      const reference = `ar_${digest({ execution_id, role }).slice(0, 32)}`, store = this.#receiptStore(role);
      const terminal = status === "running" ? "nonterminal" : status === "completed" ? "completed" : status === "cancelled" ? "cancelled" : status === "timeout" ? "timeout" : status === "failed" ? "failed" : "nonterminal";
      const effect = status === "uncertain" ? "unknown" : "accepted";
      const outcome: AdapterOutcome = { execution_id, status, effect, terminal, proof: { kind: terminal === "nonterminal" ? "run_receipt" : "process_exit", reference }, ...(result ? { result } : {}), ...(error ? { error } : {}) };
      let prior: AdapterReceipt | undefined;
      if (existsSync(store.path(reference))) {
        prior = store.read(reference);
        if (prior.execution_id === execution_id && prior.packet_digest === digest(packet) && (terminal === "nonterminal" && prior.state === "accepted" || terminal !== "nonterminal" && prior.state === "terminal" && canonicalJson(prior.outcome) === canonicalJson(outcome))) return { ...outcome, ...(diagnostics ? { diagnostics } : {}) } as ExecutionRecord;
      }
      const now = new Date().toISOString();
      const receipt: AdapterReceipt = { schema_version: 1, adapter: "executable", reference, role, repo: repoIdentity(packet.repo), delivery_id: packet.delivery_id, task_id: packet.task_id, packet_digest: digest(packet), execution_id, state: terminal === "nonterminal" ? "accepted" : "terminal", created_at: prior?.created_at ?? now, updated_at: now, ...(terminal === "nonterminal" ? {} : { proof_kind: "process_exit", outcome }) };
      const persisted = store.write(receipt), authoritative = persisted.outcome ?? outcome;
      return { ...authoritative, ...(diagnostics ? { diagnostics } : {}) } as ExecutionRecord;
    } catch { return legacy; }
  }
  #receiptStore(role: AdapterRole): AdapterReceiptStore { return new AdapterReceiptStore(join(this.options.stateDir, `adapter-receipts-${role}`), role); }
}

interface StoredExecution extends ExecutionRecord { worker_pid?: number; worker_process_identity?: string; target_pid?: number; target_process_identity?: string; started_at?: string }

export interface PaseoAgentLike {
  readonly id: string;
  readonly status: string | null;
  readonly pendingPermissions: readonly unknown[] | null;
  readonly lastError: unknown;
  refresh(requestId?: string): Promise<unknown>;
  current?(): Record<string, unknown>;
  send(text: string, options?: { messageId?: string }): Promise<void>;
  waitForFinish(timeoutMs?: number): Promise<{ status: "idle" | "error" | "permission" | "timeout"; error: string | null; lastMessage: string | null }>;
  reload(options?: { requestId?: string }): Promise<unknown>;
  archive(): Promise<unknown>;
}
export interface PaseoWorkspaceLike { readonly id: string; readonly directory: string | null; readonly agents: { create(options: Record<string, unknown>): Promise<PaseoAgentLike> }; refresh(options?: { requestId?: string }): Promise<unknown>; current?(): Record<string, unknown>; archive(requestId?: string): Promise<unknown> }
type PaseoFeature = { type: "toggle"; id: string; value: boolean } | { type: "select"; id: string; value: string | null; options: Array<{ id: string }> };
export interface PaseoApiLike {
  readonly providers: {
    listAvailable(options?: { requestId?: string }): Promise<{ providers: Array<{ provider: string; available: boolean; error?: string | null }>; error?: string | null }>;
    listModels(provider: string, options?: { cwd?: string; requestId?: string }): Promise<{ provider?: string; models?: Array<{ id: string; isSelectable?: boolean }>; error?: string | null; fetchedAt?: string }>;
    listModes(provider: string, options?: { cwd?: string; requestId?: string }): Promise<{ provider?: string; modes?: Array<{ id: string }>; error?: string | null; fetchedAt?: string }>;
    listFeatures(config: { provider: string; cwd: string; modeId?: string; featureValues?: Record<string, unknown> }, options?: { requestId?: string }): Promise<{ provider?: string; features?: PaseoFeature[]; error?: string | null; fetchedAt?: string }>;
  };
  readonly workspaces: { create(options: Record<string, unknown>): Promise<PaseoWorkspaceLike>; ref(id: string): PaseoWorkspaceLike; list(options?: Record<string, unknown>): Promise<{ entries: Array<{ id: string; title?: string | null; directory?: string | null }> }> };
  readonly agents: { ref(id: string): PaseoAgentLike; list(options?: Record<string, unknown>): Promise<{ entries: Array<{ agent: { id: string; workspaceId?: string; labels?: Record<string, string> } }> }> };
}

export interface PaseoAdapterOptions {
  paseo: PaseoApiLike;
  hostId: string;
  stateDir: string;
  role: AdapterRole;
  repositoryRepo: string;
  repositoryPath: string;
  repositoryCommonDir: string;
  baseRef: string;
  baseSha: string;
  provider: string;
  model: string;
  modeId?: string;
  featureValues: Record<string, unknown>;
  options: Record<string, unknown>;
  toolPolicy?: { preapproved: Array<{ kind: "mcp"; server: string; tool: string }> };
  timeoutMs?: number;
  branchName(executionId: string, packet: Record<string, unknown>): string;
  prompt(packet: Record<string, unknown>): string;
}

type PaseoIdentity = { hostId: string; workspaceId: string; agentId: string };
function encodePaseoIdentity(value: PaseoIdentity): string { return `paseo:${Buffer.from(JSON.stringify(value)).toString("base64url")}`; }
function decodePaseoIdentity(value: string): PaseoIdentity {
  if (!value.startsWith("paseo:")) throw new Error("invalid Paseo execution identity");
  const parsed = oneJsonObject(Buffer.from(value.slice(6), "base64url").toString("utf8"), "Paseo identity");
  if (typeof parsed.hostId !== "string" || typeof parsed.workspaceId !== "string" || typeof parsed.agentId !== "string") throw new Error("invalid Paseo execution identity");
  return parsed as unknown as PaseoIdentity;
}

const CODEX_SELECTED_OPTIONS = {
  approval_policy: "on-request",
  sandbox_mode: "workspace-write",
  sandbox_workspace_write: { network_access: false, writable_roots: [], exclude_slash_tmp: true, exclude_tmpdir_env_var: true },
} as const;

function plainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function validPaseoFeature(value: unknown): value is PaseoFeature {
  if (!plainRecord(value) || typeof value.id !== "string" || value.id.length === 0) return false;
  if (value.type === "toggle") return typeof value.value === "boolean";
  if (value.type !== "select" || (value.value !== null && typeof value.value !== "string") || !Array.isArray(value.options)) return false;
  const optionIds = value.options.map((option) => plainRecord(option) && typeof option.id === "string" && option.id.length > 0 ? option.id : undefined);
  return optionIds.every((id) => id !== undefined) && new Set(optionIds).size === optionIds.length && (value.value === null || optionIds.includes(value.value));
}

function validatePaseoSelectedSettings(options: Pick<PaseoAdapterOptions, "provider" | "modeId" | "featureValues" | "options" | "toolPolicy">): void {
  requireCondition(options.modeId === undefined || (typeof options.modeId === "string" && options.modeId.length > 0), "Paseo executor mode must be omitted or one non-empty identifier");
  requireCondition(plainRecord(options.featureValues), "Paseo executor featureValues must be one JSON object");
  requireCondition(plainRecord(options.options), "Paseo executor native options must be one JSON object");
  canonicalJson(options.featureValues); canonicalJson(options.options);
  requireCondition(options.toolPolicy === undefined, "Paseo Delivery does not configure MCP servers, so toolPolicy preapproval is unsupported");
  const providerName = options.provider.split("/")[0]!;
  if (providerName === "codex") {
    requireCondition(options.modeId === "auto", "Paseo Codex executor requires the selected auto mode");
    requireCondition(Object.keys(options.featureValues).every((key) => key === "plan_mode") && (options.featureValues.plan_mode === undefined || options.featureValues.plan_mode === false), "Paseo Codex executor supports only an explicit false plan_mode feature selection");
    requireCondition(canonicalJson(options.options) === canonicalJson(CODEX_SELECTED_OPTIONS), "Paseo Codex executor requires the selected on-request workspace-write policy with network disabled and no extra writable roots");
  } else {
    requireCondition(Object.keys(options.options).length === 0, `Paseo provider ${providerName} native option validation is unsupported; configure an explicit discovered mode/features profile without opaque native options`);
  }
}

type PaseoSelectedConfig = { provider: string; modeId?: string; featureValues: Record<string, unknown>; options: Record<string, unknown>; toolPolicy?: PaseoAdapterOptions["toolPolicy"] };
type PaseoCreateRequest = { agentId: string; config: PaseoSelectedConfig; idempotencyKey: string; requestId: string; labels: Record<string, string> };

function paseoSelectedConfig(options: Pick<PaseoAdapterOptions, "provider" | "model" | "modeId" | "featureValues" | "options" | "toolPolicy">): PaseoSelectedConfig {
  const providerName = options.provider.split("/")[0]!;
  return { provider: `${providerName}/${options.model}`, ...(options.modeId === undefined ? {} : { modeId: options.modeId }), featureValues: options.featureValues, options: options.options, ...(options.toolPolicy ? { toolPolicy: options.toolPolicy } : {}) };
}

export class PaseoExecutorAdapter implements ExecutorAdapter {
  readonly options: PaseoAdapterOptions;
  readonly #receipts: AdapterReceiptStore;
  constructor(options: PaseoAdapterOptions) {
    validatePaseoSelectedSettings(options);
    this.#receipts = new AdapterReceiptStore(options.stateDir, options.role);
    this.options = { ...options, stateDir: resolve(options.stateDir), repositoryPath: resolve(options.repositoryPath), repositoryCommonDir: resolve(options.repositoryCommonDir) };
  }
  async dispatch(packet: Record<string, unknown>): Promise<Record<string, unknown>> {
    const taskId = packet.task_id;
    if (typeof taskId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(taskId)) throw new Error("Paseo dispatch requires a stable task_id from the durable engine intent");
    const context = this.#packetContext(packet);
    if (!SAFE_REF.test(this.options.baseRef) || !FULL_SHA.test(this.options.baseSha)) throw new Error("Paseo dispatch requires a safe base ref and full lowercase base SHA");
    const observed = this.#receipts.find("paseo", context);
    requireCondition(observed.length <= 1, "multiple protected Paseo receipts exist for one exact context");
    let prior = observed[0];
    if (prior?.state === "terminal" && prior.outcome) return prior.outcome as unknown as Record<string, unknown>;
    try { await this.#validateConfiguredSource(true); }
    catch (error) {
      if (prior && this.#possibleEffect(prior)) return this.#uncertain(prior, `Paseo configured source validation failed during exact reconciliation: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
    const providerName = this.options.provider.split("/")[0]!;
    const branchName = this.options.branchName(taskId, packet);
    if (!SAFE_REF.test(branchName)) throw new Error("Paseo branch name is unsafe");
    const now = new Date().toISOString(), workspaceTitle = `Delivery [${taskId}]`, deterministicAgentId = stableUuid(`agent:${context.repo}:${taskId}`);
    const selectedConfig = paseoSelectedConfig(this.options);
    const labels = { "codex-toolkit.delivery": context.delivery_id, "codex-toolkit.task-id": taskId, "codex-toolkit.repo": context.repo, "codex-toolkit.role": this.options.role };
    const createRequest: PaseoCreateRequest = { agentId: deterministicAgentId, config: selectedConfig, idempotencyKey: taskId, requestId: stableUuid(`agent-create:${context.repo}:${taskId}`), labels };
    const selectedConfigDigest = digest(selectedConfig), createRequestDigest = digest(createRequest);
    const profileFingerprint = digest({ host_id: this.options.hostId, role: this.options.role, source_path: realpathSync(this.options.repositoryPath), common_dir: realpathSync(this.options.repositoryCommonDir), provider: providerName, model: this.options.model, selected_config_digest: selectedConfigDigest });
    const reserved = this.#receipts.findOrCreate("paseo", context, (reference) => ({ schema_version: 1, adapter: "paseo", reference, role: this.options.role, ...context, execution_id: `paseo:v1:${reference}`, state: "intent", created_at: now, updated_at: now, private: { phase: "preflight", host_id: this.options.hostId, source_path: realpathSync(this.options.repositoryPath), common_dir: realpathSync(this.options.repositoryCommonDir), base_ref: this.options.baseRef, base_sha: this.options.baseSha, branch: branchName, provider: providerName, model: this.options.model, selected_config: selectedConfig, selected_config_digest: selectedConfigDigest, agent_create_request: createRequest, agent_create_request_digest: createRequestDigest, profile_fingerprint: profileFingerprint, sdk_contract: "@getpaseo/client@0.15.4", workspace_title: workspaceTitle, deterministic_agent_id: deterministicAgentId, workspace_request_id: stableUuid(`workspace:${context.repo}:${taskId}`), agent_request_id: createRequest.requestId, prompt_message_id: stableUuid(`agent-prompt:${context.repo}:${taskId}`) } }));
    const receipt = reserved.receipt, reference = receipt.reference, executionId = receipt.execution_id;
    prior = reserved.created ? undefined : receipt;
    if (receipt.state === "terminal" && receipt.outcome) return receipt.outcome as unknown as Record<string, unknown>;
    try {
      if (prior && (receipt.private?.host_id !== this.options.hostId || receipt.private?.source_path !== realpathSync(this.options.repositoryPath) || receipt.private?.common_dir !== realpathSync(this.options.repositoryCommonDir) || receipt.private?.base_ref !== this.options.baseRef || receipt.private?.base_sha !== this.options.baseSha || receipt.private?.branch !== branchName || receipt.private?.provider !== providerName || receipt.private?.model !== this.options.model || receipt.private?.deterministic_agent_id !== deterministicAgentId || receipt.private?.selected_config_digest !== selectedConfigDigest || receipt.private?.agent_create_request_digest !== createRequestDigest || receipt.private?.profile_fingerprint !== profileFingerprint || canonicalJson(receipt.private?.selected_config) !== canonicalJson(selectedConfig) || canonicalJson(receipt.private?.agent_create_request) !== canonicalJson(createRequest))) return this.#uncertain(receipt, "persisted Paseo creation intent differs from configured source, provider, or selected settings");
    } catch (error) { return this.#uncertain(receipt, `persisted Paseo intent validation failed: ${error instanceof Error ? error.message : String(error)}`); }
    const operation = this.#claimDispatchOperation(receipt);
    if ("outcome" in operation) return operation.outcome;
    if (operation.recovered) {
      receipt.private = { ...receipt.private, operation_recovery_required: true };
      receipt.updated_at = new Date().toISOString();
      try { this.#receipts.write(receipt); }
      catch (error) { releaseDirectoryLockSync(operation.path, operation.owner); return this.#uncertain(receipt, `Paseo recovered operation ownership but could not persist recovery state: ${error instanceof Error ? error.message : String(error)}`); }
    }
    try {
      return await this.#dispatchOwned(packet, receipt, prior, context, taskId, providerName, branchName, workspaceTitle, deterministicAgentId, selectedConfig, createRequest);
    } finally { releaseDirectoryLockSync(operation.path, operation.owner); }
  }
  async #dispatchOwned(packet: Record<string, unknown>, receipt: AdapterReceipt, prior: AdapterReceipt | undefined, context: Pick<AdapterReceipt, "repo" | "delivery_id" | "task_id" | "packet_digest">, taskId: string, providerName: string, branchName: string, workspaceTitle: string, deterministicAgentId: string, selectedConfig: PaseoSelectedConfig, createRequest: PaseoCreateRequest): Promise<Record<string, unknown>> {
    const reference = receipt.reference, executionId = receipt.execution_id;
    let available: Awaited<ReturnType<PaseoApiLike["providers"]["listAvailable"]>>;
    try { available = await this.options.paseo.providers.listAvailable({ requestId: randomUUID() }); }
    catch (error) { return this.#refusal(receipt, `Paseo provider discovery failed before creation: ${error instanceof Error ? error.message : String(error)}`); }
    if (available.error !== undefined && available.error !== null) return this.#refusal(receipt, `Paseo provider discovery failed: ${available.error}`);
    if (!Array.isArray(available.providers) || available.providers.some((entry) => !plainRecord(entry) || typeof entry.provider !== "string" || entry.provider.length === 0 || typeof entry.available !== "boolean" || (entry.error !== undefined && entry.error !== null && typeof entry.error !== "string")) || new Set(available.providers.map((entry) => entry.provider)).size !== available.providers.length) return this.#refusal(receipt, "Paseo provider discovery returned an invalid catalog");
    const provider = available.providers.find((entry) => entry.provider === providerName);
    if (!provider?.available) return this.#refusal(receipt, `Paseo provider ${providerName} unavailable${provider?.error ? `: ${provider.error}` : ""}`);
    let models: Awaited<ReturnType<PaseoApiLike["providers"]["listModels"]>>;
    try { models = await this.options.paseo.providers.listModels(providerName, { cwd: this.options.repositoryPath, requestId: randomUUID() }); }
    catch (error) { return this.#refusal(receipt, `Paseo model discovery failed before creation: ${error instanceof Error ? error.message : String(error)}`); }
    if (models.error !== undefined && models.error !== null) return this.#refusal(receipt, `Paseo model discovery failed: ${models.error}`);
    if (models.provider !== providerName || !Array.isArray(models.models) || models.models.some((model) => !plainRecord(model) || typeof model.id !== "string" || model.id.length === 0 || (model.isSelectable !== undefined && typeof model.isSelectable !== "boolean")) || new Set(models.models.map((model) => model.id)).size !== models.models.length) return this.#refusal(receipt, `Paseo model discovery did not return the expected ${providerName} catalog`);
    if (!models.models.some((model) => model.id === this.options.model && model.isSelectable !== false)) return this.#refusal(receipt, `Paseo model ${this.options.model} is not selectable for ${providerName}`);
    let modes: Awaited<ReturnType<PaseoApiLike["providers"]["listModes"]>>;
    try { modes = await this.options.paseo.providers.listModes(providerName, { cwd: this.options.repositoryPath, requestId: randomUUID() }); }
    catch (error) { return this.#refusal(receipt, `Paseo mode discovery failed before creation: ${error instanceof Error ? error.message : String(error)}`); }
    if (modes.error !== undefined && modes.error !== null) return this.#refusal(receipt, `Paseo mode discovery failed: ${modes.error}`);
    if (modes.provider !== providerName || !Array.isArray(modes.modes) || modes.modes.some((mode) => !plainRecord(mode) || typeof mode.id !== "string" || mode.id.length === 0) || new Set(modes.modes.map((mode) => mode.id)).size !== modes.modes.length) return this.#refusal(receipt, `Paseo mode discovery did not return the expected ${providerName} catalog`);
    if (modes.modes.length === 0 && selectedConfig.modeId !== undefined) return this.#refusal(receipt, `Paseo provider ${providerName} advertises no modes, so mode ${selectedConfig.modeId} cannot be selected`);
    if (modes.modes.length > 0 && (selectedConfig.modeId === undefined || !modes.modes.some((mode) => mode.id === selectedConfig.modeId))) return this.#refusal(receipt, selectedConfig.modeId === undefined ? `Paseo provider ${providerName} requires one advertised mode selection` : `Paseo mode ${selectedConfig.modeId} is not supported for ${providerName}`);
    let features: Awaited<ReturnType<PaseoApiLike["providers"]["listFeatures"]>>;
    try { features = await this.options.paseo.providers.listFeatures({ provider: selectedConfig.provider, cwd: realpathSync(this.options.repositoryPath), ...(selectedConfig.modeId === undefined ? {} : { modeId: selectedConfig.modeId }), featureValues: selectedConfig.featureValues }, { requestId: randomUUID() }); }
    catch (error) { return this.#refusal(receipt, `Paseo feature discovery failed before creation: ${error instanceof Error ? error.message : String(error)}`); }
    if (features.error !== undefined && features.error !== null) return this.#refusal(receipt, `Paseo feature discovery failed: ${features.error}`);
    if (features.provider !== providerName || !Array.isArray(features.features) || features.features.some((feature) => !validPaseoFeature(feature)) || new Set(features.features.map((feature) => feature.id)).size !== features.features.length) return this.#refusal(receipt, `Paseo feature discovery did not return the expected ${providerName} catalog`);
    const featureError = this.#validateSelectedFeatures(features.features, selectedConfig.featureValues);
    if (featureError) return this.#refusal(receipt, featureError);
    receipt.private = { ...receipt.private, settings_discovery: { provider: providerName, model_fetched_at: models.fetchedAt ?? null, mode_fetched_at: modes.fetchedAt ?? null, feature_fetched_at: features.fetchedAt ?? null }, settings_discovery_digest: digest({ provider: providerName, models, modes, features }) };
    receipt.updated_at = new Date().toISOString(); this.#receipts.write(receipt);
    let existingAgents: Awaited<ReturnType<PaseoApiLike["agents"]["list"]>>;
    try { existingAgents = await this.options.paseo.agents.list({ requestId: stableUuid(`list-agent:${taskId}`) }); }
    catch (error) { return this.#uncertain(receipt, `Paseo agent reconciliation failed: ${error instanceof Error ? error.message : String(error)}`); }
    const matching = existingAgents.entries.filter((entry) => entry.agent.labels?.["codex-toolkit.task-id"] === taskId || entry.agent.id === deterministicAgentId);
    if (matching.length > 1) return this.#uncertain(receipt, "multiple Paseo agents match the protected creation intent");
    const existing = matching[0];
    if (existing) {
      if (existing.agent.id !== deterministicAgentId || !existing.agent.workspaceId) return this.#uncertain(receipt, "Paseo agent label matched without exact deterministic identity");
      const phase = String(receipt.private?.phase);
      if (!prior || ["preflight", "workspace_create_possible", "workspace_created"].includes(phase)) return this.#uncertain(receipt, "Paseo agent exists without exact owned creation provenance for the selected settings");
      if (phase === "prompt_send_possible") return this.#uncertain(receipt, "Paseo prompt may already have been accepted; refusing duplicate prompt submission");
      const agent = this.options.paseo.agents.ref(existing.agent.id), workspace = this.options.paseo.workspaces.ref(existing.agent.workspaceId);
      let validation: string | undefined;
      try { validation = await this.#validateExisting(agent, workspace, receipt); }
      catch (error) { return this.#uncertain(receipt, `Paseo exact agent reconciliation failed: ${error instanceof Error ? error.message : String(error)}`); }
      if (validation) return this.#uncertain(receipt, validation);
      receipt.private = { ...receipt.private, workspace_id: workspace.id, agent_id: agent.id, adoption_context_digest: this.#adoptionContextDigest(receipt, workspace.id, agent.id) }; receipt.updated_at = new Date().toISOString(); this.#receipts.write(receipt);
      if (phase === "agent_create_possible") return this.#sendPrompt(agent, packet, receipt);
      if (phase !== "prompt_accepted" || receipt.state !== "accepted") return this.#uncertain(receipt, "Paseo agent provenance has no exact prompt acceptance state");
      return { execution_id: executionId, status: "running", effect: "accepted", terminal: "nonterminal", proof: { kind: "run_receipt", reference }, provider: "paseo", reconciled: true };
    }
    if (prior?.state === "accepted" || prior?.private?.phase === "agent_create_possible") return this.#uncertain(receipt, "prior Paseo agent creation may have been accepted but no exact agent is observable");
    let workspaces: Awaited<ReturnType<PaseoApiLike["workspaces"]["list"]>>;
    try { workspaces = await this.options.paseo.workspaces.list({ requestId: stableUuid(`list-workspace:${taskId}`) }); }
    catch (error) { return this.#uncertain(receipt, `Paseo workspace reconciliation failed: ${error instanceof Error ? error.message : String(error)}`); }
    const titleMatches = workspaces.entries.filter((entry) => entry.title === workspaceTitle);
    if (titleMatches.length > 1) return this.#uncertain(receipt, "multiple Paseo workspaces match the protected title hint");
    let workspace: PaseoWorkspaceLike;
    if (titleMatches.length === 1 && prior && ["workspace_create_possible", "workspace_created", "agent_create_possible"].includes(String(receipt.private?.phase))) {
      workspace = this.options.paseo.workspaces.ref(titleMatches[0]!.id);
      let validation: string | undefined;
      try { await workspace.refresh({ requestId: randomUUID() }); validation = await this.#validateWorkspace(workspace, receipt, false); }
      catch (error) { return this.#uncertain(receipt, `Paseo workspace reconciliation failed: ${error instanceof Error ? error.message : String(error)}`); }
      if (validation) return this.#uncertain(receipt, validation);
      receipt.private = { ...receipt.private, workspace_id: workspace.id, phase: "workspace_created" }; receipt.updated_at = new Date().toISOString(); this.#receipts.write(receipt);
    } else {
      if (titleMatches.length) return this.#uncertain(receipt, "Paseo workspace title exists without a matching protected create intent");
      if (receipt.private?.operation_recovery_required === true) return this.#uncertain(receipt, "Paseo operation owner was recovered but no exact workspace is observable; refusing a duplicate create until explicit reconciliation");
      if (prior && receipt.private?.phase !== "preflight") return this.#uncertain(receipt, "prior Paseo creation may have been accepted but no exact resource is observable");
      receipt.private = { ...receipt.private, phase: "workspace_create_possible" }; receipt.updated_at = new Date().toISOString(); this.#receipts.write(receipt);
      try { workspace = await this.options.paseo.workspaces.create({
        title: workspaceTitle,
        source: { kind: "worktree", cwd: this.options.repositoryPath, action: "branch-off", refName: this.options.baseRef, branchName },
        requestId: receipt.private!.workspace_request_id,
      }); }
      catch (error) { return this.#uncertain(receipt, `Paseo workspace creation disposition is unknown: ${error instanceof Error ? error.message : String(error)}`); }
      receipt.private = { ...receipt.private, workspace_id: workspace.id, phase: "workspace_created" }; receipt.updated_at = new Date().toISOString();
      try { this.#receipts.write(receipt); }
      catch (error) { return this.#uncertain(receipt, `Paseo workspace identity persistence failed after create: ${error instanceof Error ? error.message : String(error)}`); }
    }
    let workspaceError: string | undefined;
    try {
      await workspace.refresh({ requestId: stableUuid(`workspace-refresh:${context.repo}:${taskId}`) });
      if (!workspace.directory) return this.#uncertain(receipt, "Paseo workspace did not expose its checkout directory");
      const checkoutSha = (await execFileAsync("git", ["-C", workspace.directory, "rev-parse", "HEAD"], { timeout: 10_000, maxBuffer: 64 * 1024 })).stdout.trim();
      if (checkoutSha !== this.options.baseSha) return this.#uncertain(receipt, "Paseo workspace checkout does not match the pinned candidate SHA");
      workspaceError = await this.#validateWorkspace(workspace, receipt, false);
    } catch (error) { return this.#uncertain(receipt, `Paseo created workspace validation failed: ${error instanceof Error ? error.message : String(error)}`); }
    if (workspaceError) return this.#uncertain(receipt, workspaceError);
    receipt.private = { ...receipt.private, phase: "agent_create_possible" }; receipt.updated_at = new Date().toISOString(); this.#receipts.write(receipt);
    let agent: PaseoAgentLike;
    try { agent = await workspace.agents.create(createRequest); }
    catch (error) { return this.#uncertain(receipt, `Paseo agent creation disposition is unknown: ${error instanceof Error ? error.message : String(error)}`); }
    receipt.private = { ...receipt.private, agent_id: agent.id, adoption_context_digest: this.#adoptionContextDigest(receipt, workspace.id, agent.id) }; receipt.updated_at = new Date().toISOString();
    try { this.#receipts.write(receipt); }
    catch (error) { return this.#uncertain(receipt, `Paseo agent identity persistence failed after create: ${error instanceof Error ? error.message : String(error)}`); }
    if (agent.id !== deterministicAgentId) return this.#uncertain(receipt, "Paseo returned an unexpected agent identity");
    let createdValidation: string | undefined;
    try { createdValidation = await this.#validateExisting(agent, workspace, receipt); }
    catch (error) { return this.#uncertain(receipt, `Fresh Paseo agent validation failed after create: ${error instanceof Error ? error.message : String(error)}`); }
    if (createdValidation) return this.#uncertain(receipt, `Fresh Paseo agent validation failed: ${createdValidation}`);
    return this.#sendPrompt(agent, packet, receipt);
  }
  async #sendPrompt(agent: PaseoAgentLike, packet: Record<string, unknown>, receipt: AdapterReceipt): Promise<Record<string, unknown>> {
    receipt.private = { ...receipt.private, phase: "prompt_send_possible", prompt_digest: digest(this.options.prompt(packet)) }; receipt.updated_at = new Date().toISOString(); this.#receipts.write(receipt);
    try { await agent.send(this.options.prompt(packet), { messageId: String(receipt.private?.prompt_message_id) }); }
    catch (error) { return this.#uncertain(receipt, `Paseo prompt submission disposition is unknown: ${error instanceof Error ? error.message : String(error)}`); }
    receipt.state = "accepted"; receipt.private = { ...receipt.private, phase: "prompt_accepted" }; receipt.updated_at = new Date().toISOString();
    try { this.#receipts.write(receipt); }
    catch (error) { return this.#uncertain(receipt, `Paseo prompt acceptance persistence failed: ${error instanceof Error ? error.message : String(error)}`); }
    return { execution_id: receipt.execution_id, status: "running", effect: "accepted", terminal: "nonterminal", proof: { kind: "run_receipt", reference: receipt.reference }, provider: "paseo" };
  }
  #validateSelectedFeatures(features: PaseoFeature[], selected: Record<string, unknown>): string | undefined {
    for (const [id, value] of Object.entries(selected)) {
      const feature = features.find((candidate) => candidate.id === id);
      if (!feature) return `Paseo feature ${id} is not supported for the selected provider/model/mode`;
      if (feature.type === "toggle") {
        if (typeof value !== "boolean") return `Paseo feature ${id} requires a boolean value`;
        if (feature.value !== value) return `Paseo feature ${id} did not resolve to the selected value`;
      } else {
        if (typeof value !== "string" || !feature.options.some((option) => option.id === value)) return `Paseo feature ${id} does not support the selected option`;
        if (feature.value !== value) return `Paseo feature ${id} did not resolve to the selected value`;
      }
    }
    return undefined;
  }
  #adoptionContextDigest(receipt: AdapterReceipt, workspaceId: string, agentId: string): string {
    return digest({ host_id: receipt.private?.host_id, workspace_id: workspaceId, agent_id: agentId, profile_fingerprint: receipt.private?.profile_fingerprint, selected_config_digest: receipt.private?.selected_config_digest, agent_create_request_digest: receipt.private?.agent_create_request_digest });
  }
  #claimDispatchOperation(receipt: AdapterReceipt): { path: string; owner: DirectoryLockOwner; recovered: boolean } | { outcome: Record<string, unknown> } {
    const path = join(this.options.stateDir, `.operation-paseo-${receipt.reference}`);
    const context = { operation: "paseo_dispatch", receipt_reference: receipt.reference, receipt_role: receipt.role, repo_digest: digest(receipt.repo), packet_digest: receipt.packet_digest };
    const controllerIdentity = currentProcessIdentity(process.pid);
    if (!controllerIdentity) return { outcome: this.#uncertain(receipt, "Paseo dispatch controller identity is unavailable") };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try { return { path, owner: acquireDirectoryLockSync(path, { ...context, controller_identity: controllerIdentity }), recovered: attempt > 0 }; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") return { outcome: this.#uncertain(receipt, `Paseo dispatch ownership failed: ${error instanceof Error ? error.message : String(error)}`) }; }
      let owner: DirectoryLockOwner;
      try { owner = readDirectoryLockOwnerSync(path); }
      catch (error) { return { outcome: this.#uncertain(receipt, `Paseo dispatch owner is unreadable: ${error instanceof Error ? error.message : String(error)}`) }; }
      const ownerControllerIdentity = owner.context?.controller_identity;
      if (typeof ownerControllerIdentity !== "string" || canonicalJson(owner.context) !== canonicalJson({ ...context, controller_identity: ownerControllerIdentity })) return { outcome: this.#uncertain(receipt, "Paseo dispatch owner context differs from the exact protected operation") };
      const ownership = processOwnership(owner.pid, ownerControllerIdentity);
      if (ownership === "match") {
        const current = this.#receipts.read(receipt.reference);
        if (current.state === "terminal" && current.outcome) return { outcome: current.outcome as unknown as Record<string, unknown> };
        if (current.state === "accepted") return { outcome: { execution_id: current.execution_id, status: "running", effect: "accepted", terminal: "nonterminal", proof: { kind: "run_receipt", reference: current.reference }, provider: "paseo", reconciled: true } };
        return { outcome: this.#uncertain(current, "Paseo exact dispatch is owned by a live controller; no duplicate SDK operation was issued") };
      }
      if (ownership === "unknown") return { outcome: this.#uncertain(receipt, "Paseo exact dispatch owner liveness is unknown; refusing a duplicate SDK operation") };
      try { recoverDirectoryLockSync(path); }
      catch (error) { return { outcome: this.#uncertain(receipt, `Paseo exact dispatch owner recovery failed: ${error instanceof Error ? error.message : String(error)}`) }; }
    }
    return { outcome: this.#uncertain(receipt, "Paseo exact dispatch ownership could not converge") };
  }
  async inspect(executionId: string): Promise<Record<string, unknown>> {
    const receipt = this.#receipt(executionId); if (receipt.state === "terminal" && receipt.outcome) return receipt.outcome as unknown as Record<string, unknown>;
    const validated = await this.#validatedReconnect(receipt); if ("error" in validated) return this.#uncertain(receipt, validated.error);
    const { agent } = validated;
    if (agent.pendingPermissions?.length) return { execution_id: executionId, status: "permission", effect: "accepted", terminal: "nonterminal", proof: { kind: "run_receipt", reference: receipt.reference }, provider: "paseo", error: "Paseo agent requires permission" };
    if (agent.status === "error") return { execution_id: executionId, status: "uncertain", effect: "accepted", terminal: "nonterminal", proof: { kind: "run_receipt", reference: receipt.reference }, provider: "paseo", error: String(agent.lastError ?? "Paseo agent observation failed") };
    if (agent.status === "idle") return this.collect(executionId);
    return { execution_id: executionId, status: "running", effect: "accepted", terminal: "nonterminal", proof: { kind: "run_receipt", reference: receipt.reference }, provider: "paseo" };
  }
  async collect(executionId: string): Promise<Record<string, unknown>> {
    const receipt = this.#receipt(executionId); if (receipt.state === "terminal" && receipt.outcome) return receipt.outcome as unknown as Record<string, unknown>;
    const validated = await this.#validatedReconnect(receipt); if ("error" in validated) return this.#uncertain(receipt, validated.error);
    const settled = await validated.agent.waitForFinish(this.options.timeoutMs ?? 15 * 60_000);
    if (settled.status === "timeout") return { execution_id: executionId, status: "timeout", effect: "accepted", terminal: "nonterminal", proof: { kind: "run_receipt", reference: receipt.reference }, provider: "paseo", error: settled.error ?? "Paseo observation timed out" };
    if (settled.status === "permission") return { execution_id: executionId, status: "permission", effect: "accepted", terminal: "nonterminal", proof: { kind: "run_receipt", reference: receipt.reference }, provider: "paseo", error: settled.error ?? undefined };
    if (settled.status === "error") return { execution_id: executionId, status: "uncertain", effect: "accepted", terminal: "nonterminal", proof: { kind: "run_receipt", reference: receipt.reference }, provider: "paseo", error: settled.error ?? "Paseo observation failed" };
    const rawResult = settled.lastMessage ?? "";
    const framedResult = receipt.private?.provider === "codex" && rawResult.startsWith(PASEO_CODEX_ASSISTANT_BOUNDARY)
      ? rawResult.slice(PASEO_CODEX_ASSISTANT_BOUNDARY.length)
      : rawResult;
    let outcome: AdapterOutcome;
    try { outcome = { execution_id: executionId, status: "completed", effect: "accepted", terminal: "completed", proof: { kind: "run_receipt", reference: receipt.reference }, provider: "paseo", result: oneJsonObject(framedResult, "Paseo agent") }; }
    catch (error) { outcome = { execution_id: executionId, status: "failed", effect: "accepted", terminal: "failed", proof: { kind: "run_receipt", reference: receipt.reference }, provider: "paseo", error: (error as Error).message }; }
    outcome = this.#terminalReceipt(receipt, outcome, "run_receipt"); return outcome as unknown as Record<string, unknown>;
  }
  async cancel(executionId: string): Promise<Record<string, unknown>> {
    const receipt = this.#receipt(executionId); if (receipt.state === "terminal" && receipt.outcome) return receipt.outcome as unknown as Record<string, unknown>;
    const validated = await this.#validatedReconnect(receipt, true); if ("error" in validated) return this.#uncertain(receipt, validated.error);
    const { agent } = validated;
    try { await agent.archive(); }
    catch (error) { return { execution_id: executionId, status: "uncertain", effect: "accepted", terminal: "nonterminal", provider: "paseo", error: `Paseo archive acknowledgement was lost: ${error instanceof Error ? error.message : String(error)}` }; }
    if (String(receipt.private?.provider) !== "codex") return { execution_id: executionId, status: "uncertain", effect: "accepted", terminal: "nonterminal", provider: "paseo", error: "Paseo archive acknowledgement is not verified as terminal for this provider" };
    const outcome: AdapterOutcome = { execution_id: executionId, status: "cancelled", effect: "accepted", terminal: "cancelled", proof: { kind: "archive_ack", reference: receipt.reference }, provider: "paseo" };
    return this.#terminalReceipt(receipt, outcome, "archive_ack") as unknown as Record<string, unknown>;
  }
  async reconnect(executionId: string): Promise<Record<string, unknown>> { return this.inspect(executionId); }
  async resolveOutcomeProof(outcome: AdapterOutcome, expectedContext: AdapterOutcomeExpectedContext): Promise<AdapterOutcomeProofResolution> { return this.#receipts.resolve(outcome, expectedContext); }
  #packetContext(packet: Record<string, unknown>): Pick<AdapterReceipt, "repo" | "delivery_id" | "task_id" | "packet_digest"> {
    requireCondition(typeof packet.repo === "string" && packet.repo.replace(/^github\.com\//, "").toLowerCase() === this.options.repositoryRepo.toLowerCase(), "Paseo packet repository differs from configured source");
    requireCondition(typeof packet.delivery_id === "string" && packet.delivery_id.length > 0 && typeof packet.task_id === "string", "Paseo packet context is incomplete");
    return { repo: repoIdentity(packet.repo), delivery_id: packet.delivery_id, task_id: packet.task_id, packet_digest: digest(packet) };
  }
  async #validateConfiguredSource(requireExactBase: boolean): Promise<void> {
    const root = (await execFileAsync("git", ["-C", this.options.repositoryPath, "rev-parse", "--path-format=absolute", "--show-toplevel"], { timeout: 10_000 })).stdout.trim();
    const common = realpathSync((await execFileAsync("git", ["-C", root, "rev-parse", "--path-format=absolute", "--git-common-dir"], { timeout: 10_000 })).stdout.trim());
    requireCondition(common === realpathSync(this.options.repositoryCommonDir), "Paseo configured source common directory changed");
    const remote = (await execFileAsync("git", ["-C", root, "remote", "get-url", "origin"], { timeout: 10_000 })).stdout.trim();
    const match = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(remote); requireCondition(match && match[1]!.toLowerCase() === this.options.repositoryRepo.toLowerCase(), "Paseo configured source repository changed");
    if (requireExactBase) {
      const resolved = (await execFileAsync("git", ["-C", root, "rev-parse", "--verify", `${this.options.baseRef}^{commit}`], { timeout: 10_000 })).stdout.trim();
      requireCondition(resolved === this.options.baseSha, `Paseo base ref ${this.options.baseRef} no longer resolves to the pinned candidate SHA`);
    } else {
      const pinned = (await execFileAsync("git", ["-C", root, "rev-parse", "--verify", `${this.options.baseSha}^{commit}`], { timeout: 10_000 })).stdout.trim();
      requireCondition(pinned === this.options.baseSha, "Paseo pinned baseline is no longer available in the configured source");
    }
  }
  async #validateWorkspace(workspace: PaseoWorkspaceLike, receipt: AdapterReceipt, allowDescendant: boolean): Promise<string | undefined> {
    const descriptor = workspace.current?.(); const directory = typeof descriptor?.workspaceDirectory === "string" ? descriptor.workspaceDirectory : workspace.directory;
    if (!directory) return "Paseo workspace has no current directory";
    try {
      const common = realpathSync((await execFileAsync("git", ["-C", directory, "rev-parse", "--path-format=absolute", "--git-common-dir"], { timeout: 10_000 })).stdout.trim());
      if (common !== receipt.private?.common_dir) return "Paseo workspace common directory differs from protected source";
      const remote = (await execFileAsync("git", ["-C", directory, "remote", "get-url", "origin"], { timeout: 10_000 })).stdout.trim();
      const repository = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(remote)?.[1]?.toLowerCase();
      if (!repository || `github.com/${repository}` !== receipt.repo) return "Paseo workspace repository differs from protected intent";
      const branch = (await execFileAsync("git", ["-C", directory, "branch", "--show-current"], { timeout: 10_000 })).stdout.trim(); if (branch !== receipt.private?.branch) return "Paseo workspace branch differs from protected intent";
      const head = (await execFileAsync("git", ["-C", directory, "rev-parse", "HEAD"], { timeout: 10_000 })).stdout.trim();
      const baseSha = receipt.private?.base_sha;
      if (typeof baseSha !== "string" || !FULL_SHA.test(baseSha)) return "Paseo protected baseline is invalid";
      if (!allowDescendant && head !== baseSha) return "Paseo workspace is not at the pinned baseline";
      if (allowDescendant) await execFileAsync("git", ["-C", directory, "merge-base", "--is-ancestor", baseSha, head], { timeout: 10_000 });
      return undefined;
    } catch (error) { return `Paseo workspace Git validation failed: ${error instanceof Error ? error.message : String(error)}`; }
  }
  async #validateExisting(agent: PaseoAgentLike, workspace: PaseoWorkspaceLike, receipt: AdapterReceipt, requireSelectedSettings = true): Promise<string | undefined> {
    await agent.refresh(randomUUID()); await workspace.refresh({ requestId: randomUUID() });
    const snapshot = agent.current?.(); if (!snapshot) return "Paseo agent did not expose an official current snapshot";
    if (snapshot.workspaceId !== workspace.id || snapshot.provider !== receipt.private?.provider || snapshot.model !== receipt.private?.model) return "Paseo agent provider/model/workspace differs from protected intent";
    if (requireSelectedSettings) {
      const selectedConfig = receipt.private?.selected_config as PaseoSelectedConfig | undefined;
      if (!selectedConfig || receipt.private?.selected_config_digest !== digest(selectedConfig)) return "Paseo selected settings provenance is missing or corrupt";
      if (!Object.prototype.hasOwnProperty.call(snapshot, "currentModeId") || (selectedConfig.modeId === undefined ? snapshot.currentModeId !== null : snapshot.currentModeId !== selectedConfig.modeId)) return "Paseo agent mode differs from protected selected settings";
      if (!Array.isArray(snapshot.features)) return "Paseo agent did not expose observable feature settings";
      const featureError = this.#validateSelectedFeatures(snapshot.features as PaseoFeature[], selectedConfig.featureValues);
      if (featureError) return featureError;
    }
    const descriptor = workspace.current?.(), workspaceDirectory = typeof descriptor?.workspaceDirectory === "string" ? descriptor.workspaceDirectory : workspace.directory;
    if (typeof snapshot.cwd !== "string" || !workspaceDirectory || realpathSync(snapshot.cwd) !== realpathSync(workspaceDirectory)) return "Paseo agent cwd differs from the exact workspace";
    const labels = snapshot.labels as Record<string, string> | undefined;
    if (labels?.["codex-toolkit.task-id"] !== receipt.task_id || labels?.["codex-toolkit.repo"] !== receipt.repo || labels?.["codex-toolkit.delivery"] !== receipt.delivery_id || labels?.["codex-toolkit.role"] !== receipt.role) return "Paseo agent labels or role differ from protected intent";
    return this.#validateWorkspace(workspace, receipt, true);
  }
  async #validatedReconnect(receipt: AdapterReceipt, allowLegacyCancellation = false): Promise<{ agent: PaseoAgentLike; workspace: PaseoWorkspaceLike } | { error: string }> {
    try {
      const ids = this.#externalIds(receipt);
      if (!ids) return { error: "Paseo intent has no exact external identity" };
      const providerName = this.options.provider.split("/")[0]!;
      const selectedConfig = paseoSelectedConfig(this.options);
      const createRequest = receipt.private?.agent_create_request;
      const expectedProfileFingerprint = digest({ host_id: this.options.hostId, role: this.options.role, source_path: realpathSync(this.options.repositoryPath), common_dir: realpathSync(this.options.repositoryCommonDir), provider: providerName, model: this.options.model, selected_config_digest: digest(selectedConfig) });
      requireCondition(receipt.private?.host_id === this.options.hostId
        && receipt.private?.source_path === realpathSync(this.options.repositoryPath)
        && receipt.private?.common_dir === realpathSync(this.options.repositoryCommonDir)
        && receipt.private?.base_ref === this.options.baseRef
        && receipt.private?.base_sha === this.options.baseSha
        && receipt.private?.provider === providerName
        && receipt.private?.model === this.options.model
        && receipt.private?.deterministic_agent_id === stableUuid(`agent:${receipt.repo}:${receipt.task_id}`)
        && ids.agentId === receipt.private?.deterministic_agent_id, "Paseo reconnect configuration differs from protected intent");
      const hasSelectedSettings = receipt.private?.selected_config !== undefined || receipt.private?.selected_config_digest !== undefined || receipt.private?.agent_create_request !== undefined || receipt.private?.agent_create_request_digest !== undefined || receipt.private?.profile_fingerprint !== undefined || receipt.private?.adoption_context_digest !== undefined;
      if (hasSelectedSettings) requireCondition(canonicalJson(receipt.private?.selected_config) === canonicalJson(selectedConfig)
        && receipt.private?.selected_config_digest === digest(selectedConfig)
        && plainRecord(createRequest)
        && receipt.private?.agent_create_request_digest === digest(createRequest)
        && receipt.private?.profile_fingerprint === expectedProfileFingerprint
        && receipt.private?.adoption_context_digest === this.#adoptionContextDigest(receipt, ids.workspaceId, ids.agentId), "Paseo reconnect selected settings differ from protected intent");
      else requireCondition(allowLegacyCancellation, "legacy Paseo receipt lacks selected permission provenance; only exact explicit cancellation is allowed");
      await this.#validateConfiguredSource(false);
      const agent = this.options.paseo.agents.ref(ids.agentId), workspace = this.options.paseo.workspaces.ref(ids.workspaceId);
      requireCondition(agent.id === ids.agentId && workspace.id === ids.workspaceId, "Paseo SDK returned a different external identity");
      const validation = await this.#validateExisting(agent, workspace, receipt, hasSelectedSettings);
      if (validation) return { error: validation };
      return { agent, workspace };
    } catch (error) { return { error: `Paseo exact reconnect validation failed: ${error instanceof Error ? error.message : String(error)}` }; }
  }
  #receipt(executionId: string): AdapterReceipt { const match = /^paseo:v1:(ar_[0-9a-f]{32})$/.exec(executionId); requireCondition(match, "legacy Paseo identity lacks protected creation intent"); const receipt = this.#receipts.read(match[1]!); requireCondition(receipt.execution_id === executionId && receipt.adapter === "paseo", "Paseo receipt identity mismatch"); return receipt; }
  #externalIds(receipt: AdapterReceipt): { workspaceId: string; agentId: string } | undefined { return typeof receipt.private?.workspace_id === "string" && typeof receipt.private?.agent_id === "string" ? { workspaceId: receipt.private.workspace_id, agentId: receipt.private.agent_id } : undefined; }
  #terminalReceipt(receipt: AdapterReceipt, outcome: AdapterOutcome, kind: AdapterReceipt["proof_kind"]): AdapterOutcome {
    const candidate: AdapterReceipt = { ...receipt, state: "terminal", proof_kind: kind, outcome, updated_at: new Date().toISOString() };
    try {
      const persisted = this.#receipts.write(candidate);
      requireCondition(persisted.state === "terminal" && persisted.outcome !== undefined, "Paseo terminal receipt write did not publish terminal proof");
      return persisted.outcome;
    } catch (error) {
      const persisted = this.#receipts.read(receipt.reference);
      if (persisted.state === "terminal" && persisted.outcome) return persisted.outcome;
      throw error;
    }
  }
  #refusal(receipt: AdapterReceipt, message: string): Record<string, unknown> {
    if (this.#possibleEffect(receipt)) return this.#uncertain(receipt, `Prior Paseo creation may have external effects and requires exact reconciliation: ${message}`);
    const outcome: AdapterOutcome = { execution_id: receipt.execution_id, status: "failed", effect: "none", terminal: "failed", proof: { kind: "preflight_refusal", reference: receipt.reference }, provider: "paseo", error: message };
    return this.#terminalReceipt(receipt, outcome, "preflight_refusal") as unknown as Record<string, unknown>;
  }
  #possibleEffect(receipt: AdapterReceipt): boolean {
    return receipt.state === "accepted" || ["workspace_create_possible", "workspace_created", "agent_create_possible", "prompt_send_possible", "prompt_accepted"].includes(String(receipt.private?.phase))
      || typeof receipt.private?.workspace_id === "string" || typeof receipt.private?.agent_id === "string";
  }
  #uncertain(receipt: AdapterReceipt, message: string): Record<string, unknown> { return { execution_id: receipt.execution_id, status: "uncertain", effect: receipt.state === "accepted" ? "accepted" : "unknown", terminal: "nonterminal", provider: "paseo", error: message }; }
}

interface PiSettlement { aborted: boolean; failure?: string; lastText?: string }
type PiExitEvidence = { kind: "observed_exit"; code: number | null; signal: NodeJS.Signals | null } | { kind: "proven_lost" };
interface PiSession {
  process: ChildProcessWithoutNullStreams;
  records: Record<string, unknown>[];
  waiters: Array<() => void>;
  stderr: string;
  receipt: AdapterReceipt;
  ownerPath?: string;
  owner?: DirectoryLockOwner;
  accepted?: string;
  lastText?: string;
  error?: string;
  attemptFailure?: string;
  terminalFailure?: string;
  settlement?: PiSettlement;
  terminal?: AdapterOutcome;
  exit?: { code: number | null; signal: NodeJS.Signals | null };
  child?: { pid: number; process_identity: string };
  abortRequest?: Promise<{ accepted: boolean; error?: string }>;
  settlementFinalization?: Promise<AdapterOutcome | undefined>;
  spawnFailed?: boolean;
  shutdownRequested?: boolean;
}
interface PiSessionFileEvidence { path: string; identity?: DirectoryIdentity }
export interface PiRpcAdapterOptions { executable: string; cwd: string; stateDir: string; sessionOwnersDir: string; role: AdapterRole; provider?: string; model?: string; timeoutMs?: number; maxOutputBytes?: number; sessionDir?: string; environment?: Readonly<Record<string, string>> }

export class PiRpcExecutorAdapter implements ExecutorAdapter {
  readonly #sessions = new Map<string, PiSession>();
  readonly #receipts: AdapterReceiptStore;
  readonly #ownerRootIdentity: DirectoryIdentity;
  readonly #sessionRootIdentity: DirectoryIdentity;
  #version?: string;
  readonly options: PiRpcAdapterOptions;
  constructor(options: PiRpcAdapterOptions) {
    requireCondition(resolve(options.stateDir) !== resolve(options.sessionOwnersDir), "Pi receipt and global session-owner roots must be distinct");
    this.#ownerRootIdentity = ensurePrivateDirectorySync(options.sessionOwnersDir);
    this.#receipts = new AdapterReceiptStore(options.stateDir, options.role);
    const stateDir = resolve(options.stateDir), sessionDir = resolve(options.sessionDir ?? join(stateDir, "pi-sessions"));
    this.#sessionRootIdentity = ensurePrivateDirectorySync(sessionDir);
    this.options = { ...options, stateDir, sessionOwnersDir: resolve(options.sessionOwnersDir), sessionDir };
  }
  async dispatch(packet: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.#dispatch(packet);
  }
  async #dispatch(packet: Record<string, unknown>, resumeFile?: string): Promise<Record<string, unknown>> {
    const context = this.#packetContext(packet);
    let resumeProvenance: AdapterReceipt | undefined;
    let resumeEvidence: PiSessionFileEvidence | undefined;
    if (resumeFile) {
      const candidates = this.#receipts.findPiSession(resumeFile);
      const referenced = new Set(candidates.map((candidate) => candidate.private?.resumed_from_reference).filter((value): value is string => typeof value === "string"));
      const leaves = candidates.filter((candidate) => candidate.state === "terminal" && !referenced.has(candidate.reference));
      if (leaves.length === 1) resumeProvenance = leaves[0];
    }
    const now = new Date().toISOString();
    const receiptRootDigest = digest(realpathSync(this.options.stateDir));
    const reserved = this.#receipts.findOrCreate("pi", context, (reference) => ({ schema_version: 1, adapter: "pi", reference, role: this.options.role, ...context, execution_id: `pi:v1:${reference}`, state: "intent", created_at: now, updated_at: now, private: { prompt_digest: digest(JSON.stringify(packet)), receipt_root_digest: receiptRootDigest, owner_root_digest: digest(realpathSync(this.options.sessionOwnersDir)), session_root_digest: digest(realpathSync(this.options.sessionDir!)), provider: this.options.provider ?? null, model: this.options.model ?? null } }));
    const receipt = reserved.receipt, reference = receipt.reference, executionId = receipt.execution_id;
    if (!reserved.created) {
      if (receipt.private?.provider !== (this.options.provider ?? null) || receipt.private?.model !== (this.options.model ?? null) || receipt.private?.receipt_root_digest !== receiptRootDigest || receipt.private?.owner_root_digest !== digest(realpathSync(this.options.sessionOwnersDir)) || receipt.private?.session_root_digest !== digest(realpathSync(this.options.sessionDir!))) return { execution_id: receipt.execution_id, status: "uncertain", effect: "unknown", terminal: "nonterminal", provider: "pi", error: "persisted Pi intent differs from configured provider, receipt root, installation owner root, or session root" };
      if (receipt.state === "terminal" && receipt.outcome) return receipt.outcome as unknown as Record<string, unknown>;
      return this.#detachedOutcome(receipt) as unknown as Record<string, unknown>;
    }
    if (resumeFile) {
      const valid = resumeProvenance?.state === "terminal" && resumeProvenance.outcome?.terminal !== "nonterminal"
        && resumeProvenance.role === this.options.role
        && resumeProvenance.private?.session_file === resumeFile
        && resumeProvenance.private?.receipt_root_digest === receiptRootDigest
        && resumeProvenance.private?.owner_root_digest === receipt.private?.owner_root_digest
        && resumeProvenance.private?.session_root_digest === receipt.private?.session_root_digest
        && resumeProvenance.private?.provider === receipt.private?.provider
        && resumeProvenance.private?.model === receipt.private?.model
        && typeof resumeProvenance.private?.session_scope === "string"
        && typeof resumeProvenance.private?.session_scope_digest === "string";
      if (!valid) {
        const outcome: AdapterOutcome = { execution_id: executionId, status: "failed", effect: "none", terminal: "failed", proof: { kind: "preflight_refusal", reference }, provider: "pi", error: "Pi explicit resume requires one exact protected receipt for a terminal run of this session, installation, role, and provider" };
        this.#terminalReceipt(receipt, outcome, "preflight_refusal"); return outcome as unknown as Record<string, unknown>;
      }
      try {
        resumeEvidence = this.#sessionFileEvidence(resumeFile, this.options.sessionDir!, "repair", true);
        resumeFile = resumeEvidence.path;
      }
      catch (error) {
        const outcome: AdapterOutcome = { execution_id: executionId, status: "failed", effect: "none", terminal: "failed", proof: { kind: "preflight_refusal", reference }, provider: "pi", error: `Pi proven session file could not be secured for resume: ${error instanceof Error ? error.message : String(error)}` };
        this.#terminalReceipt(receipt, outcome, "preflight_refusal"); return outcome as unknown as Record<string, unknown>;
      }
      receipt.private = { ...receipt.private, session_scope: resumeProvenance!.private!.session_scope, session_scope_digest: resumeProvenance!.private!.session_scope_digest, resumed_from_reference: resumeProvenance!.reference };
      receipt.updated_at = new Date().toISOString(); this.#receipts.write(receipt);
    }
    const sessionScope = resumeFile ? String(receipt.private!.session_scope) : join(this.options.sessionDir!, reference);
    let sessionScopeIdentity: DirectoryIdentity;
    try {
      if (!resumeFile) mkdirSync(sessionScope, { mode: 0o700 });
      sessionScopeIdentity = ensurePrivateDirectorySync(sessionScope);
    }
    catch (error) {
      const outcome: AdapterOutcome = { execution_id: executionId, status: "failed", effect: "none", terminal: "failed", proof: { kind: "preflight_refusal", reference }, provider: "pi", error: `Pi protected session reservation failed: ${error instanceof Error ? error.message : String(error)}` };
      this.#terminalReceipt(receipt, outcome, "preflight_refusal"); return outcome as unknown as Record<string, unknown>;
    }
    if (!resumeFile) {
      receipt.private = { ...receipt.private, session_scope: sessionScope, session_scope_digest: digest(realpathSync(sessionScope)) };
      receipt.updated_at = new Date().toISOString(); this.#receipts.write(receipt);
    }
    const args = ["--mode", "rpc", ...(resumeFile ? ["--session", resumeFile] : ["--session-dir", sessionScope])];
    if (this.options.provider) args.push("--provider", this.options.provider);
    if (this.options.model) args.push("--model", this.options.model);
    let reservedOwner: { path: string; owner: DirectoryLockOwner } | undefined;
    if (resumeFile) {
      const path = join(this.options.sessionOwnersDir, digest(resumeFile));
      try { reservedOwner = { path, owner: acquireDirectoryLockSync(path, this.#ownerContext(receipt, resumeFile, args)) }; }
      catch (error) {
        const outcome: AdapterOutcome = { execution_id: executionId, status: "failed", effect: "none", terminal: "failed", proof: { kind: "preflight_refusal", reference }, provider: "pi", error: `Pi protected session owner is unavailable: ${error instanceof Error ? error.message : String(error)}` };
        this.#terminalReceipt(receipt, outcome, "preflight_refusal"); return outcome as unknown as Record<string, unknown>;
      }
    }
    let version: string;
    try { version = await this.#installedVersion(); }
    catch (error) {
      if (reservedOwner) releaseDirectoryLockSync(reservedOwner.path, reservedOwner.owner);
      const outcome: AdapterOutcome = { execution_id: executionId, status: "failed", effect: "none", terminal: "failed", proof: { kind: "preflight_refusal", reference }, provider: "pi", error: error instanceof Error ? error.message : String(error) };
      this.#terminalReceipt(receipt, outcome, "preflight_refusal"); return outcome as unknown as Record<string, unknown>;
    }
    if (resumeEvidence) {
      try { resumeEvidence = this.#sessionFileEvidence(resumeEvidence.path, this.options.sessionDir!, "strict", true, resumeEvidence.identity); }
      catch (error) {
        if (reservedOwner) releaseDirectoryLockSync(reservedOwner.path, reservedOwner.owner);
        const outcome: AdapterOutcome = { execution_id: executionId, status: "failed", effect: "none", terminal: "failed", proof: { kind: "preflight_refusal", reference }, provider: "pi", error: `Pi proven session file changed during resume preflight: ${error instanceof Error ? error.message : String(error)}` };
        this.#terminalReceipt(receipt, outcome, "preflight_refusal"); return outcome as unknown as Record<string, unknown>;
      }
    }
    const session = this.#start(args, receipt, reservedOwner); let promptSent = false;
    try {
      const childPid = session.process.pid, childIdentity = childPid === undefined ? undefined : currentProcessIdentity(childPid);
      requireCondition(childPid !== undefined && childIdentity !== undefined, "Pi child process identity could not be protected before execution");
      session.child = { pid: childPid, process_identity: childIdentity };
      session.receipt.private = { ...session.receipt.private, pi_child: session.child };
      session.receipt.updated_at = new Date().toISOString(); this.#receipts.write(session.receipt);
      const stateId = randomUUID(); this.#write(session, { id: stateId, type: "get_state" });
      const state = await this.#response(session, stateId);
      const data = state.data as Record<string, unknown> | undefined;
      if (typeof data?.sessionFile !== "string") throw new Error("Pi did not expose a persistent session file");
      const observed = this.#sessionFileEvidence(data.sessionFile, sessionScope, "strict", Boolean(resumeEvidence), resumeEvidence?.identity, sessionScopeIdentity);
      const sessionFile = observed.path;
      if (resumeFile) requireCondition(sessionFile === resumeFile, "Pi resumed a different session file than the protected request");
      ensurePrivateDirectorySync(this.options.sessionOwnersDir, this.#ownerRootIdentity);
      const ownerPath = join(this.options.sessionOwnersDir, digest(sessionFile));
      if (!session.owner) { session.owner = acquireDirectoryLockSync(ownerPath, this.#ownerContext(receipt, sessionFile, args)); session.ownerPath = ownerPath; }
      session.receipt.private = { ...session.receipt.private, session_file: sessionFile, owner_token_digest: digest(session.owner.token), owner_process_identity: session.owner.process_identity, owner_context_digest: digest(session.owner.context), owner_command_digest: session.owner.context?.command_digest, owner_controller_identity: session.owner.context?.controller_identity };
      session.receipt.updated_at = new Date().toISOString(); this.#receipts.write(session.receipt);
      const modelsId = randomUUID(); this.#write(session, { id: modelsId, type: "get_available_models" }); const modelsResponse = await this.#response(session, modelsId);
      if (modelsResponse.success !== true) return await this.#preflightRefusal(session, "Pi model discovery failed");
      if (this.options.model) {
        const models = (modelsResponse.data as { models?: Array<{ provider?: string; id?: string }> } | undefined)?.models ?? [];
        if (!models.some((model) => model.id === this.options.model && (!this.options.provider || model.provider === this.options.provider))) return await this.#preflightRefusal(session, `Pi model ${this.options.provider ? `${this.options.provider}/` : ""}${this.options.model} is not available`);
      }
      this.#sessions.set(executionId, session);
      const promptId = randomUUID(); this.#write(session, { id: promptId, type: "prompt", message: JSON.stringify(packet) }); promptSent = true;
      let response: Record<string, unknown>;
      try { response = await this.#response(session, promptId); }
      catch (error) { return this.#postPromptUncertain(session, error instanceof Error ? error.message : String(error)); }
      if (response.success !== true) return await this.#postPromptNoRun(session, `Pi rejected prompt: ${String(response.error ?? "unknown error")}`);
      session.accepted = String((response.data as Record<string, unknown>)?.disposition ?? "unknown");
      if (session.accepted === "handled") {
        const outcome: AdapterOutcome = { execution_id: executionId, status: "failed", effect: "unknown", terminal: "failed", proof: { kind: "no_ordinary_run", reference }, provider: "pi", error: "Pi input was handled by an extension; no ordinary run started and extension effects are unknown" };
        this.#terminal(session, outcome, "no_ordinary_run"); await this.#shutdown(session); return outcome as unknown as Record<string, unknown>;
      }
      if (session.accepted !== "started" && session.accepted !== "queued") return this.#postPromptUncertain(session, `Pi returned unsupported prompt disposition ${session.accepted}`);
      session.receipt.state = "accepted"; session.receipt.updated_at = new Date().toISOString(); this.#receipts.write(session.receipt);
      this.#commitSettlement(session);
      if (session.settlement) {
        const terminal = await this.#finishOwnedSettlement(session);
        if (terminal) return terminal as unknown as Record<string, unknown>;
      }
      return { execution_id: executionId, status: "running", effect: "accepted", terminal: "nonterminal", proof: { kind: "run_receipt", reference }, accepted: session.accepted, persistent: true, provider: "pi", version };
    } catch (error) {
      if (session.receipt.state === "terminal") { await this.#shutdown(session); return session.terminal as unknown as Record<string, unknown>; }
      return promptSent ? this.#postPromptUncertain(session, error instanceof Error ? error.message : String(error)) : this.#preflightRefusal(session, error instanceof Error ? error.message : String(error));
    }
  }
  async inspect(executionId: string): Promise<Record<string, unknown>> {
    const session = this.#sessions.get(executionId);
    if (session?.terminal) return session.terminal as unknown as Record<string, unknown>;
    if (session?.settlement) {
      const terminal = await this.#finishOwnedSettlement(session);
      if (terminal) return terminal as unknown as Record<string, unknown>;
      return { execution_id: executionId, status: "uncertain", effect: "accepted", terminal: "nonterminal", provider: "pi", error: session.error ?? "Pi terminal settlement lacks exact child-exit proof" };
    }
    let receipt: AdapterReceipt;
    try { receipt = this.#receipt(executionId); }
    catch (error) { return { execution_id: executionId, status: "uncertain", effect: "unknown", terminal: "nonterminal", provider: "pi", error: `Pi protected receipt unavailable: ${error instanceof Error ? error.message : String(error)}` }; }
    if (receipt.state === "terminal" && receipt.outcome) return receipt.outcome as unknown as Record<string, unknown>;
    if (session?.error) return { execution_id: executionId, status: "uncertain", effect: receipt.state === "accepted" ? "accepted" : "unknown", terminal: "nonterminal", provider: "pi", error: session.error };
    if (session && receipt.state === "accepted") return { execution_id: executionId, status: "running", effect: "accepted", terminal: "nonterminal", proof: { kind: "run_receipt", reference: receipt.reference }, provider: "pi" };
    if (session) return { execution_id: executionId, status: "uncertain", effect: "unknown", terminal: "nonterminal", provider: "pi", error: "Pi prompt acceptance is not proven" };
    return this.#detachedOutcome(receipt) as unknown as Record<string, unknown>;
  }
  async collect(executionId: string): Promise<Record<string, unknown>> {
    const existing = this.#sessions.get(executionId);
    if (!existing) return this.inspect(executionId);
    await this.#until(existing, () => Boolean(existing.terminal || existing.settlement || existing.error), this.options.timeoutMs ?? 15 * 60_000);
    if (existing.settlement) {
      const terminal = await this.#finishOwnedSettlement(existing);
      if (terminal) return terminal as unknown as Record<string, unknown>;
      return { execution_id: executionId, status: "uncertain", effect: "accepted", terminal: "nonterminal", provider: "pi", error: existing.error ?? "Pi settled but exact child exit is unconfirmed" };
    }
    if (!existing.terminal) this.#terminal(existing, { execution_id: executionId, status: "failed", effect: "unknown", terminal: "failed", proof: { kind: "process_exit", reference: existing.receipt.reference }, provider: "pi", error: existing.error ?? "Pi stream ended without exact settlement" }, "process_exit");
    await this.#shutdown(existing);
    return existing.terminal as unknown as Record<string, unknown>;
  }
  async cancel(executionId: string): Promise<Record<string, unknown>> {
    const session = this.#sessions.get(executionId);
    if (!session) {
      let receipt: AdapterReceipt;
      try { receipt = this.#receipt(executionId); }
      catch (error) { return { execution_id: executionId, status: "uncertain", effect: "unknown", terminal: "nonterminal", provider: "pi", error: `Pi protected receipt unavailable: ${error instanceof Error ? error.message : String(error)}` }; }
      if (receipt.state === "terminal" && receipt.outcome) return receipt.outcome as unknown as Record<string, unknown>;
      const settled = this.#finishDetachedSettlement(receipt);
      if (settled) return settled as unknown as Record<string, unknown>;
      return { execution_id: executionId, status: "uncertain", effect: "unknown", terminal: "nonterminal", provider: "pi", error: "live Pi stream is not owned by this process; refusing to create a second RPC runtime" };
    }
    if (session.terminal) {
      const terminal = session.terminal;
      await this.#shutdown(session);
      if (session.exit || session.spawnFailed) return terminal as unknown as Record<string, unknown>;
      return { execution_id: executionId, status: "uncertain", effect: "accepted", terminal: "nonterminal", provider: "pi", error: session.error ?? "Pi terminal run was observed but owned child exit is unconfirmed" };
    }
    if (session.settlement) {
      const terminal = await this.#finishOwnedSettlement(session);
      return terminal ? terminal as unknown as Record<string, unknown> : { execution_id: executionId, status: "uncertain", effect: "accepted", terminal: "nonterminal", provider: "pi", error: session.error ?? "Pi terminal settlement lacks exact child-exit proof" };
    }
    if (!session.abortRequest) {
      session.abortRequest = (async () => {
        const id = randomUUID(); this.#write(session, { id, type: "abort" });
        try {
          const response = await this.#response(session, id);
          return response.success === true ? { accepted: true } : { accepted: false, error: "Pi rejected abort" };
        } catch (error) { return { accepted: false, error: error instanceof Error ? error.message : String(error) }; }
      })();
    }
    const abort = await session.abortRequest;
    if (!abort.accepted) return { execution_id: executionId, status: "uncertain", effect: "accepted", terminal: "nonterminal", provider: "pi", error: abort.error ?? "Pi abort acknowledgement is unavailable" };
    try { await this.#until(session, () => Boolean(session.settlement || session.error), this.options.timeoutMs ?? 30_000); }
    catch (error) { return { execution_id: executionId, status: "uncertain", effect: "accepted", terminal: "nonterminal", provider: "pi", error: error instanceof Error ? error.message : String(error) }; }
    if (!session.settlement) return { execution_id: executionId, status: "uncertain", effect: "accepted", terminal: "nonterminal", provider: "pi", error: session.error ?? "Pi abort was acknowledged without exact settlement" };
    const terminal = await this.#finishOwnedSettlement(session);
    return terminal ? terminal as unknown as Record<string, unknown> : { execution_id: executionId, status: "uncertain", effect: "accepted", terminal: "nonterminal", provider: "pi", error: session.error ?? "Pi terminal settlement lacks exact child-exit proof" };
  }
  async compact(executionId: string, instructions?: string): Promise<Record<string, unknown>> {
    const session = this.#sessions.get(executionId); if (!session) throw new Error("Pi compaction requires the original owned live runtime"); const id = randomUUID();
    this.#write(session, { id, type: "compact", ...(instructions ? { customInstructions: instructions } : {}) });
    return this.#response(session, id);
  }
  async resume(sessionFile: string, packet: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!isAbsolute(sessionFile) || resolve(sessionFile) !== sessionFile) throw new Error("Pi resume requires an absolute canonical persisted session file");
    return this.#dispatch(packet, sessionFile);
  }
  async resolveOutcomeProof(outcome: AdapterOutcome, expectedContext: AdapterOutcomeExpectedContext): Promise<AdapterOutcomeProofResolution> { return this.#receipts.resolve(outcome, expectedContext); }
  #start(args: string[], receipt: AdapterReceipt, reservedOwner?: { path: string; owner: DirectoryLockOwner }): PiSession {
    const previousUmask = process.umask(0o077);
    let child: ChildProcessWithoutNullStreams;
    try { child = spawn(this.options.executable, args, { cwd: this.options.cwd, env: cleanEnvironment(["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"], this.options.environment ?? {}), detached: true, stdio: ["pipe", "pipe", "pipe"] }); }
    finally { process.umask(previousUmask); }
    const session: PiSession = { process: child, records: [], waiters: [], stderr: "", receipt, ...(reservedOwner ? { ownerPath: reservedOwner.path, owner: reservedOwner.owner } : {}) };
    this.#consume(session);
    child.stderr.on("data", (chunk: Buffer) => { try { session.stderr = boundedAppend(session.stderr, chunk, this.options.maxOutputBytes ?? DEFAULT_LIMIT, "Pi stderr"); } catch (error) { session.error = (error as Error).message; child.kill("SIGTERM"); this.#wake(session); } });
    child.once("error", (error) => { session.spawnFailed = child.pid === undefined; session.error = error.message; if (session.shutdownRequested && session.spawnFailed) this.#retireExitedSession(session); this.#wake(session); });
    child.once("exit", (code, signal) => { session.exit = { code, signal }; if (!session.terminal && code !== 0) session.error = `Pi exited ${code ?? signal}`; if (session.shutdownRequested) this.#retireExitedSession(session); this.#wake(session); });
    return session;
  }
  async #installedVersion(): Promise<string> {
    if (this.#version) return this.#version;
    const output = (await execFileAsync(this.options.executable, ["--version"], { timeout: 5_000, maxBuffer: 64 * 1024, env: cleanEnvironment(["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"], this.options.environment ?? {}) })).stdout.trim();
    const match = /(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:\s|$)/.exec(output);
    if (!match) throw new Error("Pi executable did not report a semantic version");
    const major = Number(match[1]); const minor = Number(match[2]);
    if (major < 1 || (major === 1 && minor < 5)) throw new Error(`Pi ${match[0].trim()} does not support the required settled RPC lifecycle`);
    this.#version = `${match[1]}.${match[2]}.${match[3]}`; return this.#version;
  }
  #consume(session: PiSession): void {
    let buffer = Buffer.alloc(0);
    session.process.stdout.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > (this.options.maxOutputBytes ?? DEFAULT_LIMIT)) { session.error = "Pi stdout exceeded limit without a complete record"; session.process.kill("SIGTERM"); return; }
      for (;;) {
        const lf = buffer.indexOf(10); if (lf < 0) break;
        const raw = buffer.subarray(0, lf); buffer = buffer.subarray(lf + 1);
        try {
          const record = oneJsonObject(raw.toString("utf8").replace(/\r$/, ""), "Pi RPC");
          session.records.push(record);
          if (record.type === "message_end") {
            const message = record.message as Record<string, unknown> | undefined;
            if (message?.role === "assistant") {
              const content = Array.isArray(message.content) ? message.content as Array<Record<string, unknown>> : [];
              const text = content.filter((item) => item.type === "text" && typeof item.text === "string").map((item) => String(item.text)).join("");
              if (text) session.lastText = text.slice(0, this.options.maxOutputBytes ?? DEFAULT_LIMIT);
              if (["error", "aborted", "length"].includes(String(message.stopReason))) session.attemptFailure = typeof message.errorMessage === "string" ? message.errorMessage.slice(0, 500) : `Pi assistant attempt stopped with ${String(message.stopReason)}`;
              else if (message.stopReason === "stop") session.attemptFailure = undefined;
            }
          } else if (record.type === "auto_retry_end") {
            if (record.success === true) { session.attemptFailure = undefined; session.terminalFailure = undefined; }
            else if (record.success === false) session.terminalFailure = typeof record.finalError === "string" ? record.finalError.slice(0, 500) : session.attemptFailure ?? "Pi automatic retry failed";
          } else if (record.type === "auto_compaction_end" && record.success === false) {
            session.terminalFailure = typeof record.error === "string" ? record.error.slice(0, 500) : "Pi compaction failed";
          } else if (record.type === "agent_settled") {
            session.settlement = { aborted: record.aborted === true, ...(session.terminalFailure ?? session.attemptFailure ? { failure: session.terminalFailure ?? session.attemptFailure } : {}), ...(session.lastText ? { lastText: session.lastText } : {}) };
            this.#commitSettlement(session);
          }
          this.#wake(session);
        } catch (error) { session.error = (error as Error).message; session.process.kill("SIGTERM"); this.#wake(session); }
      }
    });
  }
  #write(session: PiSession, record: Record<string, unknown>): void { session.process.stdin.write(`${JSON.stringify(record)}\n`); }
  async #response(session: PiSession, id: string): Promise<Record<string, unknown>> {
    await this.#until(session, () => session.records.some((record) => record.type === "response" && record.id === id) || Boolean(session.error), this.options.timeoutMs ?? 30_000);
    if (session.error) throw new Error(session.error);
    return session.records.find((record) => record.type === "response" && record.id === id)!;
  }
  async #until(session: PiSession, predicate: () => boolean, timeoutMs: number): Promise<void> {
    if (predicate()) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { const index = session.waiters.indexOf(done); if (index >= 0) session.waiters.splice(index, 1); reject(new Error(`Pi RPC timed out after ${timeoutMs}ms`)); }, timeoutMs);
      const done = () => { if (!predicate()) return; clearTimeout(timer); const index = session.waiters.indexOf(done); if (index >= 0) session.waiters.splice(index, 1); resolve(); };
      session.waiters.push(done);
    });
  }
  #wake(session: PiSession): void { for (const waiter of [...session.waiters]) waiter(); }
  #packetContext(packet: Record<string, unknown>): Pick<AdapterReceipt, "repo" | "delivery_id" | "task_id" | "packet_digest"> {
    requireCondition(typeof packet.repo === "string" && packet.repo.length > 0, "Pi packet requires repo");
    requireCondition(typeof packet.delivery_id === "string" && packet.delivery_id.length > 0, "Pi packet requires delivery_id");
    requireCondition(typeof packet.task_id === "string" && packet.task_id.length > 0, "Pi packet requires task_id");
    return { repo: repoIdentity(packet.repo), delivery_id: packet.delivery_id, task_id: packet.task_id, packet_digest: digest(packet) };
  }
  #canonicalSessionFile(value: string, protectedRoot = this.options.sessionDir!, policy: "strict" | "candidate" | "repair" = "strict"): string {
    return this.#sessionFileEvidence(value, protectedRoot, policy).path;
  }
  #sessionFileEvidence(value: string, protectedRoot = this.options.sessionDir!, policy: "strict" | "candidate" | "repair" = "strict", required = false, expected?: DirectoryIdentity, expectedRoot?: DirectoryIdentity): PiSessionFileEvidence {
    requireCondition(isAbsolute(value) && resolve(value) === value, "Pi session file must be absolute and canonical");
    if (expectedRoot) ensurePrivateDirectorySync(resolve(protectedRoot), expectedRoot);
    const originalRoot = resolve(protectedRoot), root = realpathSync(protectedRoot), originalParent = dirname(value);
    let originalAncestor: string | undefined, originalChild: string | undefined;
    for (const candidateRoot of new Set([originalRoot, root])) {
      const candidateChild = relative(candidateRoot, originalParent);
      if (candidateChild === "" || (candidateChild !== ".." && !candidateChild.startsWith(`..${sep}`) && !isAbsolute(candidateChild))) {
        originalAncestor = candidateRoot; originalChild = candidateChild; break;
      }
    }
    requireCondition(originalAncestor !== undefined && originalChild !== undefined, "Pi session file is outside the configured protected session root");
    for (const component of originalChild.split(sep).filter(Boolean)) {
      originalAncestor = join(originalAncestor, component);
      const info = lstatSync(originalAncestor);
      requireCondition(info.isDirectory() && !info.isSymbolicLink(), "Pi session path must not traverse symlinks");
    }
    if (resolve(protectedRoot) === resolve(this.options.sessionDir!)) ensurePrivateDirectorySync(root, this.#sessionRootIdentity);
    else {
      ensurePrivateDirectorySync(this.options.sessionDir!, this.#sessionRootIdentity);
      const scope = relative(realpathSync(this.options.sessionDir!), root);
      requireCondition(scope.length > 0 && scope !== ".." && !scope.startsWith(`..${sep}`) && !isAbsolute(scope), "Pi session reservation is outside the configured protected session root");
      ensurePrivateDirectorySync(root);
    }
    const parent = realpathSync(dirname(value));
    ensurePrivateDirectorySync(parent);
    const candidate = join(parent, basename(value));
    const child = relative(root, candidate);
    requireCondition(child.length > 0 && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child), "Pi session file is outside the configured protected session root");
    if (existsSync(candidate)) {
      const info = lstatSync(candidate), euid = process.geteuid?.();
      requireCondition(info.isFile() && !info.isSymbolicLink() && (euid === undefined || info.uid === euid), "Pi session file is unsafe");
      const fd = openSync(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        let opened = fstatSync(fd);
        requireCondition(opened.isFile() && (euid === undefined || opened.uid === euid) && opened.dev === info.dev && opened.ino === info.ino, "Pi session file changed during validation");
        if (policy === "repair" && (opened.mode & 0o077) !== 0) { fchmodSync(fd, 0o600); opened = fstatSync(fd); }
        if (policy !== "candidate") requireCondition((opened.mode & 0o077) === 0, "Pi session file is unsafe");
        const canonical = realpathSync(candidate), linked = lstatSync(canonical);
        requireCondition(linked.isFile() && !linked.isSymbolicLink() && linked.dev === opened.dev && linked.ino === opened.ino, "Pi session file changed during canonicalization");
        const identity = { dev: opened.dev, ino: opened.ino };
        if (expected) requireCondition(identity.dev === expected.dev && identity.ino === expected.ino, "Pi session file changed during validation");
        return { path: canonical, identity };
      } finally { closeSync(fd); }
    }
    requireCondition(!required, "Pi session file does not exist");
    return { path: candidate };
  }
  #ownerContext(receipt: AdapterReceipt, sessionFile: string, args: readonly string[]): Readonly<Record<string, string>> {
    const controllerIdentity = currentProcessIdentity(process.pid);
    requireCondition(controllerIdentity !== undefined, "cannot establish the Pi controller process identity");
    return {
      installation: digest({ executable: realpathSync(this.options.executable), owner_root: realpathSync(this.options.sessionOwnersDir) }),
      receipt_root: digest(realpathSync(this.options.stateDir)),
      role: this.options.role,
      execution_id: receipt.execution_id,
      reference: receipt.reference,
      packet_digest: receipt.packet_digest,
      command_digest: digest({ executable: realpathSync(this.options.executable), args }),
      session_file: sessionFile,
      session_root: String(receipt.private?.session_scope_digest ?? digest(realpathSync(this.options.sessionDir!))),
      controller_identity: controllerIdentity,
    };
  }
  #receipt(executionId: string): AdapterReceipt {
    const match = /^pi:v1:(ar_[0-9a-f]{32})$/.exec(executionId); requireCondition(match, "invalid or legacy Pi execution identity");
    const receipt = this.#receipts.read(match[1]!); requireCondition(receipt.execution_id === executionId && receipt.adapter === "pi", "Pi receipt identity mismatch"); return receipt;
  }
  #detachedOutcome(receipt: AdapterReceipt): AdapterOutcome {
    const settled = this.#finishDetachedSettlement(receipt);
    if (settled) return settled;
    const sessionFile = receipt.private?.session_file;
    if (typeof sessionFile !== "string") return { execution_id: receipt.execution_id, status: "uncertain", effect: "unknown", terminal: "nonterminal", provider: "pi", error: "Pi intent has no canonical session evidence" };
    try { ensurePrivateDirectorySync(this.options.sessionOwnersDir, this.#ownerRootIdentity); requireCondition(receipt.private?.owner_root_digest === digest(realpathSync(this.options.sessionOwnersDir)), "Pi receipt belongs to a different installation owner root"); }
    catch (error) { return { execution_id: receipt.execution_id, status: "uncertain", effect: "unknown", terminal: "nonterminal", provider: "pi", error: error instanceof Error ? error.message : String(error) }; }
    const ownerPath = join(this.options.sessionOwnersDir, digest(sessionFile));
    try {
      const owner = readDirectoryLockOwnerSync(ownerPath), context = owner.context, controllerIdentity = context?.controller_identity;
      requireCondition(context !== undefined && typeof controllerIdentity === "string"
        && context.installation === digest({ executable: realpathSync(this.options.executable), owner_root: realpathSync(this.options.sessionOwnersDir) })
        && context.receipt_root === digest(realpathSync(this.options.stateDir))
        && context.role === receipt.role
        && context.execution_id === receipt.execution_id
        && context.reference === receipt.reference
        && context.packet_digest === receipt.packet_digest
        && context.command_digest === receipt.private?.owner_command_digest
        && context.session_file === sessionFile
        && context.session_root === receipt.private?.session_scope_digest
        && context.controller_identity === receipt.private?.owner_controller_identity
        && digest(context) === receipt.private?.owner_context_digest
        && digest(owner.token) === receipt.private?.owner_token_digest, "Pi live owner context differs from the protected run receipt");
      const ownership = processOwnership(owner.pid, controllerIdentity!);
      if (ownership === "match") return { execution_id: receipt.execution_id, status: "running", effect: receipt.state === "accepted" ? "accepted" : "unknown", terminal: "nonterminal", provider: "pi", error: "Pi runtime is live in another controller; no second RPC runtime was opened" };
      return { execution_id: receipt.execution_id, status: "uncertain", effect: receipt.state === "accepted" ? "accepted" : "unknown", terminal: "nonterminal", provider: "pi", error: ownership === "lost" ? "Pi controller was lost before terminal receipt" : "Pi controller ownership cannot be proven" };
    } catch (error) { return { execution_id: receipt.execution_id, status: "uncertain", effect: receipt.state === "accepted" ? "accepted" : "unknown", terminal: "nonterminal", provider: "pi", error: error instanceof Error ? error.message : "Pi terminal receipt and live owner proof are unavailable" }; }
  }
  #terminal(session: PiSession, outcome: AdapterOutcome, proofKind: AdapterReceipt["proof_kind"]): void {
    const persisted = this.#terminalReceipt(session.receipt, outcome, proofKind);
    session.receipt = persisted; session.terminal = persisted.outcome!; session.settlement = undefined; this.#wake(session);
  }
  #commitSettlement(session: PiSession): void {
    if (session.terminal || !session.settlement || session.receipt.state !== "accepted" || !["started", "queued"].includes(session.accepted ?? "")) return;
    const settlementDigest = digest(session.settlement);
    if (session.receipt.private?.pi_settlement_digest === settlementDigest) return;
    requireCondition(session.receipt.private?.pi_settlement_digest === undefined, "Pi protected settlement changed");
    session.receipt.private = { ...session.receipt.private, pi_settlement: session.settlement, pi_settlement_digest: settlementDigest };
    session.receipt.updated_at = new Date().toISOString(); session.receipt = this.#receipts.write(session.receipt);
  }
  #settlementOutcome(receipt: AdapterReceipt, settlement: PiSettlement): AdapterOutcome {
    if (settlement.aborted) return { execution_id: receipt.execution_id, status: "cancelled", effect: "accepted", terminal: "cancelled", proof: { kind: "run_receipt", reference: receipt.reference }, provider: "pi" };
    if (settlement.failure) return { execution_id: receipt.execution_id, status: "failed", effect: "accepted", terminal: "failed", proof: { kind: "run_receipt", reference: receipt.reference }, provider: "pi", error: settlement.failure };
    try { return { execution_id: receipt.execution_id, status: "completed", effect: "accepted", terminal: "completed", proof: { kind: "run_receipt", reference: receipt.reference }, provider: "pi", result: oneJsonObject(settlement.lastText ?? "", "Pi agent") }; }
    catch (error) { return { execution_id: receipt.execution_id, status: "failed", effect: "accepted", terminal: "failed", proof: { kind: "run_receipt", reference: receipt.reference }, provider: "pi", error: error instanceof Error ? error.message : String(error) }; }
  }
  #terminalSettlement(receipt: AdapterReceipt, settlement: PiSettlement, exit: PiExitEvidence): AdapterOutcome {
    const child = receipt.private?.pi_child as { pid?: unknown; process_identity?: unknown } | undefined, settlementDigest = digest(settlement);
    requireCondition(Number.isInteger(child?.pid) && typeof child?.process_identity === "string" && receipt.private?.pi_settlement_digest === settlementDigest, "Pi terminal settlement lacks protected child or settlement identity");
    receipt.private = { ...receipt.private, pi_quiescence: { schema_version: 1, child_pid: child!.pid, child_process_identity: child!.process_identity, settlement_digest: settlementDigest, exit } };
    receipt.updated_at = new Date().toISOString();
    return this.#terminalReceipt(receipt, this.#settlementOutcome(receipt, settlement), "run_receipt").outcome!;
  }
  async #finishOwnedSettlement(session: PiSession): Promise<AdapterOutcome | undefined> {
    if (session.terminal) return session.terminal;
    if (!session.settlementFinalization) session.settlementFinalization = (async () => {
      this.#commitSettlement(session);
      if (!session.settlement) return undefined;
      await this.#shutdown(session);
      if (!session.exit) return undefined;
      const outcome = this.#terminalSettlement(session.receipt, session.settlement, { kind: "observed_exit", code: session.exit.code, signal: session.exit.signal });
      session.receipt = this.#receipts.read(session.receipt.reference); session.terminal = outcome; return outcome;
    })();
    return session.settlementFinalization;
  }
  #finishDetachedSettlement(receipt: AdapterReceipt): AdapterOutcome | undefined {
    if (receipt.state !== "accepted") return undefined;
    const settlement = receipt.private?.pi_settlement as PiSettlement | undefined, child = receipt.private?.pi_child as { pid?: unknown; process_identity?: unknown } | undefined;
    if (!settlement || receipt.private?.pi_settlement_digest !== digest(settlement) || !Number.isInteger(child?.pid) || typeof child?.process_identity !== "string") return undefined;
    if (processOwnership(child.pid as number, child.process_identity) !== "lost") return undefined;
    return this.#terminalSettlement(receipt, settlement, { kind: "proven_lost" });
  }
  #terminalReceipt(receipt: AdapterReceipt, outcome: AdapterOutcome, proofKind: AdapterReceipt["proof_kind"]): AdapterReceipt {
    const candidate: AdapterReceipt = { ...receipt, state: "terminal", proof_kind: proofKind, outcome, updated_at: new Date().toISOString() };
    try { return this.#receipts.write(candidate); }
    catch (error) {
      const persisted = this.#receipts.read(receipt.reference);
      if (persisted.state === "terminal" && persisted.outcome) return persisted;
      throw error;
    }
  }
  async #preflightRefusal(session: PiSession, message: string): Promise<Record<string, unknown>> {
    const outcome: AdapterOutcome = { execution_id: session.receipt.execution_id, status: "failed", effect: "none", terminal: "failed", proof: { kind: "preflight_refusal", reference: session.receipt.reference }, provider: "pi", error: message };
    this.#terminal(session, outcome, "preflight_refusal"); await this.#shutdown(session); return outcome as unknown as Record<string, unknown>;
  }
  async #postPromptNoRun(session: PiSession, message: string): Promise<Record<string, unknown>> {
    const outcome: AdapterOutcome = { execution_id: session.receipt.execution_id, status: "failed", effect: "unknown", terminal: "failed", proof: { kind: "no_ordinary_run", reference: session.receipt.reference }, provider: "pi", error: message };
    this.#terminal(session, outcome, "no_ordinary_run"); await this.#shutdown(session); return outcome as unknown as Record<string, unknown>;
  }
  #postPromptUncertain(session: PiSession, message: string): Record<string, unknown> {
    return { execution_id: session.receipt.execution_id, status: "uncertain", effect: "unknown", terminal: "nonterminal", provider: "pi", error: `${message}; prompt acceptance and external effects are unknown` };
  }
  async #shutdown(session: PiSession): Promise<void> {
    session.shutdownRequested = true;
    if (!session.exit) session.process.stdin.end();
    if (!session.exit) {
      try { await this.#until(session, () => Boolean(session.exit), Math.min(this.options.timeoutMs ?? 30_000, 2_000)); }
      catch { if (!session.exit) session.process.kill("SIGTERM"); try { await this.#until(session, () => Boolean(session.exit), 1_000); } catch { if (!session.exit) session.process.kill("SIGKILL"); try { await this.#until(session, () => Boolean(session.exit), 1_000); } catch { /* exact child was signalled; missing exit remains visible in receipt diagnostics */ } } }
    }
    if (session.exit || session.spawnFailed) this.#retireExitedSession(session);
    else {
      session.error ??= "Pi child shutdown was requested but exact process exit was not observed";
      this.#wake(session);
    }
  }
  #retireExitedSession(session: PiSession): void {
    if (!session.exit && !session.spawnFailed) return;
    if (session.owner && session.ownerPath) { try { releaseDirectoryLockSync(session.ownerPath, session.owner); } catch { /* retain evidence on uncertain release */ } session.owner = undefined; }
    this.#sessions.delete(session.receipt.execution_id);
  }
}

export const executorInternals = { oneJsonObject, encodePaseoIdentity, decodePaseoIdentity, stableUuid };
