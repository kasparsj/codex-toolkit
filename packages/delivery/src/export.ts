import { closeSync, constants, fsyncSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { canonicalJson, digest, requireCondition, utcNow } from "./core.ts";
import type { DeliveryState, JsonObject } from "./types.ts";

export interface RunExportDecisions { receipts: JsonObject; history: JsonObject[] }
export interface RunExport { schema_version: 1; kind: "codex-toolkit-delivery-export"; created_at: string; objective: JsonObject; identity: JsonObject; workflow: JsonObject; graph: JsonObject; executions: JsonObject[]; decisions: RunExportDecisions; unresolved_effects: string[]; digest: string }

function withoutDigest(value: Omit<RunExport, "digest">): RunExport { return { ...value, digest: digest(value) }; }
function object(value: unknown): JsonObject | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined; }
function stringField(target: JsonObject, source: JsonObject, key: string): void { if (typeof source[key] === "string") target[key] = source[key]; }
function numberField(target: JsonObject, source: JsonObject, key: string): void { if (typeof source[key] === "number" && Number.isFinite(source[key])) target[key] = source[key]; }
function booleanField(target: JsonObject, source: JsonObject, key: string): void { if (typeof source[key] === "boolean") target[key] = source[key]; }
function digestMap(source: Record<string, string>): JsonObject { return Object.fromEntries(Object.entries(source).filter(([key, value]) => /^[A-Za-z0-9_.-]+$/.test(key) && /^[0-9a-f]{64}$/.test(value))); }

function projectReviewReceipt(value: unknown): JsonObject | undefined {
  const source = object(value); if (!source) return undefined;
  const result: JsonObject = {};
  booleanField(result, source, "approved"); numberField(result, source, "minimum"); numberField(result, source, "generation");
  for (const key of ["context_digest", "commit_id", "checked_at"]) stringField(result, source, key);
  for (const key of ["approvers", "rejectors"]) if (Array.isArray(source[key]) && source[key].every((item) => Number.isInteger(item))) result[key] = [...source[key]] as number[];
  const reviewIds = object(source.review_ids); if (reviewIds && Object.values(reviewIds).every((item) => Number.isInteger(item))) result.review_ids = { ...reviewIds };
  return result;
}

function projectCheckReceipt(value: unknown): JsonObject | undefined {
  const source = object(value); if (!source) return undefined;
  const result: JsonObject = {};
  if (["success", "failed", "error", "rejected"].includes(String(source.status))) result.status = source.status as string;
  for (const key of ["candidate_sha", "manifest_digest", "checked_at"]) stringField(result, source, key);
  return result;
}

function projectEngineeringReceipt(value: unknown): JsonObject | undefined {
  const source = object(value); if (!source) return undefined;
  const result: JsonObject = {};
  for (const key of ["candidate_sha", "producer_execution_id", "criteria_digest", "checked_at"]) stringField(result, source, key);
  if (typeof source.producer_identity === "string") result.producer_identity_digest = digest(source.producer_identity);
  const checker = projectCheckReceipt(source.checker); if (checker) result.checker = checker;
  const reviewSource = object(source.review);
  if (reviewSource) {
    const review: JsonObject = {};
    if (["approved", "rejected", "failed"].includes(String(reviewSource.status))) review.status = reviewSource.status as string;
    for (const key of ["delivery_id", "task_id", "criteria_digest", "candidate_sha"]) stringField(review, reviewSource, key);
    if (typeof reviewSource.reviewer_identity === "string") review.reviewer_identity_digest = digest(reviewSource.reviewer_identity);
    result.review = review;
  }
  return result;
}

const HISTORY_FIELDS = new Set(["event", "revision", "at", "generation", "digest", "operation_id", "approved", "candidate_sha", "producer_execution_id", "task_id", "effect", "terminal", "code", "issue_count", "open_pr_count", "number", "request_id", "epoch", "fence_digest", "outstanding", "status"]);
function projectHistory(value: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(value).filter(([key, child]) => HISTORY_FIELDS.has(key) && (typeof child === "string" || typeof child === "number" || typeof child === "boolean"))) as JsonObject;
}

function projectReceipts(state: DeliveryState): JsonObject {
  const receipts: JsonObject = {};
  const plan = projectReviewReceipt(state.receipts.plan); if (plan) receipts.plan = plan;
  const implementation = projectReviewReceipt(state.receipts.implementation); if (implementation) receipts.implementation = implementation;
  const checks = projectCheckReceipt(state.receipts.checks); if (checks) receipts.checks = checks;
  const engineering = projectEngineeringReceipt(state.receipts.engineering); if (engineering) receipts.engineering = engineering;
  return receipts;
}

export function createRunExport(state: DeliveryState): RunExport {
  const manifests = Object.fromEntries(Object.entries(state.manifests).map(([kind, record]) => [kind, record ? { digest: record.digest, material_digest: record.material_digest, generation: record.generation, accepted_at: record.accepted_at } : null]));
  const base: Omit<RunExport, "digest"> = {
    schema_version: 1, kind: "codex-toolkit-delivery-export", created_at: utcNow(),
    objective: { repo: state.repo, issue: state.issue, delivery_id: state.delivery_id },
    identity: { repo_identity: state.repo_identity, policy: state.policy, pins: { skills: digestMap(state.pins.skills), engine: digestMap(state.pins.engine), artifacts: digestMap(state.pins.artifacts), location_digests: digestMap(Object.fromEntries(Object.entries(state.pins.locations).map(([key, path]) => [key, digest(path)]))) } } as unknown as JsonObject,
    workflow: { status: state.status, revision: state.revision, claim_status: state.claim_status, budget: state.budget },
    graph: { manifests, operations: state.operations.map((op) => ({ id: op.id, action: op.action, stage: op.stage ?? null, status: op.status, request_digest: op.request_digest, recorded_at: op.recorded_at, completed_at: op.completed_at ?? null })) },
    executions: state.executions.map((item) => ({ id: item.id, kind: item.kind, stage: item.stage, status: item.status, provider_digest: item.provider ? digest(item.provider) : null, external_id_digest: item.external_id ? digest(item.external_id) : null, started_at: item.started_at, finished_at: item.finished_at ?? null, result_digest: item.result_digest ?? null })),
    decisions: { receipts: projectReceipts(state), history: state.history.map(projectHistory) }, unresolved_effects: [...state.unresolved_effects],
  };
  return withoutDigest(base);
}

export function writeRunExport(path: string, value: RunExport): void { const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); try { writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); } }

function exactKeys(value: unknown, allowed: readonly string[], label: string): JsonObject {
  const item = object(value); requireCondition(item, `invalid delivery export ${label}`);
  requireCondition(Object.keys(item).every((key) => allowed.includes(key)), `delivery export contains protected fields in ${label}`);
  return item;
}

function validatePortableShape(value: RunExport): void {
  const top = exactKeys(value, ["schema_version", "kind", "created_at", "objective", "identity", "workflow", "graph", "executions", "decisions", "unresolved_effects", "digest"], "root");
  exactKeys(top.objective, ["repo", "issue", "delivery_id"], "objective");
  const identity = exactKeys(top.identity, ["repo_identity", "policy", "pins"], "identity");
  exactKeys(identity.policy, ["ref", "sha", "digest", "fetched_at"], "policy identity");
  const pins = exactKeys(identity.pins, ["skills", "engine", "artifacts", "location_digests"], "pins");
  for (const key of ["skills", "engine", "artifacts", "location_digests"]) {
    const values = exactKeys(pins[key], Object.keys(object(pins[key]) ?? {}), `pins.${key}`);
    requireCondition(Object.entries(values).every(([name, value]) => /^[A-Za-z0-9_.-]+$/.test(name) && typeof value === "string" && /^[0-9a-f]{64}$/.test(value)), `invalid delivery export pins.${key}`);
  }
  const workflow = exactKeys(top.workflow, ["status", "revision", "claim_status", "budget"], "workflow");
  exactKeys(workflow.budget, ["max_attempts", "max_elapsed_seconds", "max_concurrency", "attempts_used", "token_cost", "token_cost_status"], "budget");
  const graph = exactKeys(top.graph, ["manifests", "operations"], "graph");
  const manifests = exactKeys(graph.manifests, Object.keys(object(graph.manifests) ?? {}), "manifests");
  for (const [kind, manifest] of Object.entries(manifests)) if (manifest !== null) exactKeys(manifest, ["digest", "material_digest", "generation", "accepted_at"], `manifest.${kind}`);
  requireCondition(Array.isArray(graph.operations), "invalid delivery export operations");
  for (const operation of graph.operations) exactKeys(operation, ["id", "action", "stage", "status", "request_digest", "recorded_at", "completed_at"], "operation");
  requireCondition(Array.isArray(top.executions), "invalid delivery export executions");
  for (const execution of top.executions) exactKeys(execution, ["id", "kind", "stage", "status", "provider_digest", "external_id_digest", "started_at", "finished_at", "result_digest"], "execution");
  const decisions = exactKeys(top.decisions, ["receipts", "history"], "decisions"), receipts = exactKeys(decisions.receipts, ["plan", "implementation", "checks", "engineering"], "receipts");
  for (const stage of ["plan", "implementation"]) if (receipts[stage]) exactKeys(receipts[stage], ["approved", "minimum", "generation", "context_digest", "commit_id", "checked_at", "approvers", "rejectors", "review_ids"], `${stage} receipt`);
  if (receipts.checks) exactKeys(receipts.checks, ["status", "candidate_sha", "manifest_digest", "checked_at"], "checks receipt");
  if (receipts.engineering) {
    const engineering = exactKeys(receipts.engineering, ["candidate_sha", "producer_execution_id", "producer_identity_digest", "criteria_digest", "checked_at", "checker", "review"], "engineering receipt");
    if (engineering.checker) exactKeys(engineering.checker, ["status", "candidate_sha", "manifest_digest", "checked_at"], "engineering checker receipt");
    if (engineering.review) exactKeys(engineering.review, ["status", "delivery_id", "task_id", "criteria_digest", "candidate_sha", "reviewer_identity_digest"], "engineering review receipt");
  }
  requireCondition(Array.isArray(decisions.history), "invalid delivery export history");
  for (const item of decisions.history) exactKeys(item, [...HISTORY_FIELDS], "history");
}

export function inspectRunExport(path: string): RunExport {
  const value = JSON.parse(readFileSync(path, "utf8")) as RunExport;
  requireCondition(value.schema_version === 1 && value.kind === "codex-toolkit-delivery-export" && typeof value.digest === "string", "invalid delivery export");
  const { digest: recorded, ...body } = value;
  requireCondition(digest(body) === recorded, "delivery export digest mismatch");
  validatePortableShape(value);
  const forbidden = /(^|_)(?:token|private[_-]?key|credential|password|claim[_-]?token|authorized[_-]?digest|proof|session|raw|diagnostics?|error|path)(?:_|$)/i;
  const inspect = (item: unknown): void => {
    if (Array.isArray(item)) { item.forEach(inspect); return; }
    if (typeof item === "string") { requireCondition(!item.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(item) && !/^(?:file|pi):[\\/]/i.test(item), "delivery export contains protected path"); return; }
    if (item && typeof item === "object") for (const [key, child] of Object.entries(item)) { requireCondition(["token_cost", "token_cost_status"].includes(key) || !forbidden.test(key), "delivery export contains protected fields"); inspect(child); }
  };
  inspect(value);
  requireCondition(canonicalJson(value).length <= 10_000_000, "delivery export is too large");
  return value;
}
