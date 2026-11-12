import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeliveryEngine } from "../src/engine.ts";
import { PaseoExecutorAdapter, PiRpcExecutorAdapter } from "../src/executors.ts";
import { digest } from "../src/core.ts";
import { AdapterRefusal, type AdapterOutcome, type AdapterOutcomeExpectedContext, type ExecutorPort, type RepositoryCancellationFence } from "../src/ports.ts";
import { FileStateStore } from "../src/store.ts";
import type { DeliveryState, JsonObject } from "../src/types.ts";
import { policy } from "./helpers.ts";

function seeded(engine: DeliveryEngine, repo: string, id: string) {
  const state = engine.start({ repo, issue: 1, deliveryId: id, policy: policy() });
  return engine.store.mutate(repo, id, state.revision, (next) => {
    next.rank_snapshot = { coverage: { issues_complete: true, open_prs_complete: true, unresolved_count: 0 }, issues: [{ number: 1, state: "open", pull_request: false, labels: [] }], open_prs: [], dependencies: [{ issue: 1, blocked_by: [], unresolved: [] }] };
    return next;
  });
}

function trustedAdapter(overrides: Partial<ExecutorPort> = {}): ExecutorPort {
  const running: AdapterOutcome = { status: "running", effect: "accepted", terminal: "nonterminal", execution_id: "external-1", provider: "fixture", proof: { kind: "run_receipt", reference: "run_1" } };
  return {
    async dispatch() { return running as unknown as Record<string, unknown>; },
    async inspect() { return running as unknown as Record<string, unknown>; },
    async collect() { return running as unknown as Record<string, unknown>; },
    async cancel() { return { status: "cancelled", effect: "accepted", terminal: "cancelled", execution_id: "external-1", provider: "fixture", proof: { kind: "run_receipt", reference: "cancel_1" } } as unknown as Record<string, unknown>; },
    async resolveOutcomeProof(_outcome: AdapterOutcome, context: AdapterOutcomeExpectedContext) { return { trusted: true, proof_digest: digest(context) }; },
    ...overrides,
  };
}

function implementationCandidate(engine: DeliveryEngine, id: string, candidate = "a".repeat(40)): DeliveryState {
  let state = engine.start({ repo: "owner/repo", issue: 1, deliveryId: id, policy: policy() });
  state = engine.store.mutate(state.repo, state.delivery_id, state.revision, (next) => { next.status = "implementation_required"; return next; });
  state = engine.acceptManifest(state.repo, state.delivery_id, { schema_version: 1, kind: "implement", repo: state.repo, delivery_id: state.delivery_id,
    result: { issue: 1, candidate_sha: candidate, base: { repo: state.repo, ref: "main", sha: "b".repeat(40) }, artifact_paths: ["src/change.ts"], verification: ["fixture"] } }, state.revision);
  return engine.store.mutate(state.repo, state.delivery_id, state.revision, (next) => {
    next.executions.push({ id: "producer", kind: "agent", stage: "implement", status: "completed", provider: "fixture", external_id: "producer",
      implementer_identity: "fixture:producer", started_at: new Date().toISOString(), finished_at: new Date().toISOString() });
    next.manifests.implement!.producer_execution_id = "producer"; next.manifests.implement!.producer_identity = "fixture:producer"; return next;
  });
}

test("Paseo permission remains attached to one accepted agent and completes without duplicate effects", async () => {
  const repositoryPath = realpathSync(process.cwd());
  const repositoryCommonDir = realpathSync(execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim());
  const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const deliveryId = "paseo-permission-resume", workspaceId = "workspace-permission-resume";
  const plan = { schema_version: 1, kind: "plan", repo: "kasparsj/codex-toolkit", delivery_id: deliveryId, result: { issue: 1, plan_revision: baseSha, baseline: { repo: "kasparsj/codex-toolkit", ref: "main", sha: baseSha }, artifact_paths: ["plan.md"], artifact_hashes: { "plan.md": "a".repeat(64) } } };
  let pending = true, workspaceCreates = 0, agentCreates = 0, prompts = 0, waits = 0, assignedAgentId = "", assignedLabels: Record<string, string> = {};
  const agent = {
    get id() { return assignedAgentId; }, get status() { return pending ? "running" : "idle"; }, get pendingPermissions() { return pending ? [{ id: "permission-1" }] : null; }, lastError: null,
    async refresh() {},
    current() { return { workspaceId, provider: "codex", model: "gpt-5.6", cwd: repositoryPath, labels: assignedLabels, currentModeId: "auto", features: [{ type: "toggle" as const, id: "plan_mode", value: false }] }; },
    async send() { prompts += 1; },
    async waitForFinish() { waits += 1; return pending ? { status: "permission" as const, error: "approval required", lastMessage: null } : { status: "idle" as const, error: null, lastMessage: JSON.stringify(plan) }; },
    async reload() {}, async archive() {},
  };
  const workspace = { id: workspaceId, directory: repositoryPath, async refresh() {}, current() { return { workspaceDirectory: repositoryPath }; }, async archive() {}, agents: { async create(input: Record<string, unknown>) { agentCreates += 1; assignedAgentId = String(input.agentId); assignedLabels = input.labels as Record<string, string>; return agent; } } };
  const paseo = {
    providers: {
      async listAvailable() { return { providers: [{ provider: "codex", available: true }] }; },
      async listModels() { return { provider: "codex", models: [{ id: "gpt-5.6", isSelectable: true }] }; },
      async listModes() { return { provider: "codex", modes: [{ id: "auto" }] }; },
      async listFeatures() { return { provider: "codex", features: [{ type: "toggle" as const, id: "plan_mode", value: false }] }; },
    },
    workspaces: { async list() { return { entries: [] }; }, async create() { workspaceCreates += 1; return workspace; }, ref() { return workspace; } },
    agents: { async list() { return { entries: [] }; }, ref() { return agent; } },
  };
  const adapter = new PaseoExecutorAdapter({ paseo, hostId: "host-permission", stateDir: mkdtempSync(join(tmpdir(), "delivery-paseo-permission-")), role: "agent", repositoryRepo: "kasparsj/codex-toolkit", repositoryPath, repositoryCommonDir, baseRef: "main", baseSha, provider: "codex", model: "gpt-5.6", modeId: "auto", featureValues: { plan_mode: false }, options: { approval_policy: "on-request", sandbox_mode: "workspace-write", sandbox_workspace_write: { network_access: false, writable_roots: [], exclude_slash_tmp: true, exclude_tmpdir_env_var: true } }, branchName: () => "main", prompt: JSON.stringify });
  const engine = new DeliveryEngine({ store: new FileStateStore(mkdtempSync(join(tmpdir(), "delivery-engine-permission-"))), executor: adapter });
  let state = seeded(engine, "kasparsj/codex-toolkit", deliveryId);
  state = await engine.dispatch(state.repo, state.delivery_id, state.revision);
  const execution = state.executions.at(-1)!;
  assert.match(String(execution.external_id), /^paseo:v1:ar_[0-9a-f]{32}$/, JSON.stringify(execution));
  const permission = await adapter.inspect(execution.external_id!);
  const expected = { repo: state.repo_identity, delivery_id: deliveryId, role: "agent" as const, task_id: execution.id, packet_digest: execution.packet_digest!, execution_id: execution.external_id };
  assert.equal((await adapter.resolveOutcomeProof(permission as never, expected)).trusted, true);
  assert.equal((await adapter.resolveOutcomeProof(permission as never, { ...expected, repo: "github.com/other/repo" })).trusted, false);
  assert.equal((await adapter.resolveOutcomeProof({ ...permission, terminal: "completed" } as never, expected)).trusted, false);
  state = await engine.collect(state.repo, state.delivery_id, state.revision);
  assert.equal(state.executions.at(-1)?.status, "running"); assert.deepEqual(state.unresolved_effects, []); assert.equal(waits, 0);
  assert.deepEqual([workspaceCreates, agentCreates, prompts], [1, 1, 1]);
  pending = false;
  state = await engine.collect(state.repo, state.delivery_id, state.revision);
  assert.equal(state.status, "plan_review"); assert.equal(state.executions.at(-1)?.status, "completed");
  assert.deepEqual([workspaceCreates, agentCreates, prompts, waits], [1, 1, 1, 1]);
});

test("protected post-collect timeout and permission keep one accepted execution until completion", async () => {
  const plan = { schema_version: 1, kind: "plan", repo: "owner/repo", delivery_id: "observation-hold", result: { issue: 1, plan_revision: "1".repeat(40), baseline: { repo: "owner/repo", ref: "main", sha: "2".repeat(40) }, artifact_paths: ["plan.md"], artifact_hashes: { "plan.md": "a".repeat(64) } } };
  let dispatches = 0, inspections = 0, collections = 0;
  const observations: AdapterOutcome[] = [
    { status: "timeout", effect: "accepted", terminal: "nonterminal", execution_id: "paseo-observation", provider: "paseo", proof: { kind: "run_receipt", reference: "observation_run" }, error: "observation timed out" },
    { status: "permission", effect: "accepted", terminal: "nonterminal", execution_id: "paseo-observation", provider: "paseo", proof: { kind: "run_receipt", reference: "observation_run" }, error: "permission required" },
    { status: "completed", effect: "accepted", terminal: "completed", execution_id: "paseo-observation", provider: "paseo", proof: { kind: "run_receipt", reference: "observation_run" }, result: plan },
  ];
  const adapter = trustedAdapter({
    async dispatch() { dispatches += 1; return { status: "running", effect: "accepted", terminal: "nonterminal", execution_id: "paseo-observation", provider: "paseo", proof: { kind: "run_receipt", reference: "observation_run" } }; },
    async inspect() { inspections += 1; return { status: "uncertain", effect: "unknown", terminal: "nonterminal", execution_id: "paseo-observation", provider: "paseo", error: "poll requires wait" }; },
    async collect() { return observations[collections++] as unknown as Record<string, unknown>; },
  });
  const engine = new DeliveryEngine({ store: new FileStateStore(mkdtempSync(join(tmpdir(), "delivery-observation-hold-"))), executor: adapter });
  let state = seeded(engine, "owner/repo", "observation-hold"); state = await engine.dispatch(state.repo, state.delivery_id, state.revision);
  const taskId = state.executions.at(-1)!.id, externalId = state.executions.at(-1)!.external_id;
  state = await engine.collect(state.repo, state.delivery_id, state.revision); assert.equal(state.executions.at(-1)?.status, "running"); assert.deepEqual(state.unresolved_effects, []);
  state = await engine.collect(state.repo, state.delivery_id, state.revision); assert.equal(state.executions.at(-1)?.status, "running"); assert.deepEqual(state.unresolved_effects, []);
  state = await engine.collect(state.repo, state.delivery_id, state.revision); assert.equal(state.status, "plan_review"); assert.equal(state.executions.at(-1)?.status, "completed");
  assert.deepEqual([dispatches, inspections, collections], [1, 3, 3]); assert.equal(state.executions.at(-1)?.id, taskId); assert.equal(state.executions.at(-1)?.external_id, externalId);
});

test("untrusted or malformed observational timeout remains blocked", async () => {
  for (const malformed of [false, true]) {
    const timeout: AdapterOutcome = { status: "timeout", effect: "accepted", terminal: malformed ? "completed" : "nonterminal", execution_id: `timeout-${malformed}`, provider: "paseo", proof: { kind: "run_receipt", reference: `timeout_${malformed}` } };
    const adapter = trustedAdapter({ async dispatch() { return { status: "running", effect: "accepted", terminal: "nonterminal", execution_id: `timeout-${malformed}`, proof: { kind: "run_receipt", reference: `running_${malformed}` } }; }, async inspect() { return { status: "uncertain", effect: "unknown", terminal: "nonterminal", execution_id: `timeout-${malformed}` }; }, async collect() { return timeout as unknown as Record<string, unknown>; }, async resolveOutcomeProof(outcome, context) { if (outcome.status === "timeout") return { trusted: false, error: "protected observation proof rejected" }; return { trusted: true, proof_digest: digest(context) }; } });
    const engine = new DeliveryEngine({ store: new FileStateStore(mkdtempSync(join(tmpdir(), `delivery-observation-reject-${malformed}-`))), executor: adapter });
    let state = seeded(engine, "owner/repo", `observation-reject-${malformed}`); state = await engine.dispatch(state.repo, state.delivery_id, state.revision); state = await engine.collect(state.repo, state.delivery_id, state.revision);
    assert.equal(state.status, "blocked"); assert.equal(state.executions.at(-1)?.status, "uncertain"); assert.equal(state.executions.at(-1)?.effect, "unknown");
  }
});

class CancellationInterleavingStore extends FileStateStore {
  private armed = false;
  armCancellation(): void { this.armed = true; }
  override mutate(repo: string, deliveryId: string, expectedRevision: number | undefined, transform: (state: DeliveryState) => DeliveryState): DeliveryState {
    if (this.armed) {
      this.armed = false;
      const current = super.read(repo, deliveryId);
      super.mutate(repo, deliveryId, current.revision, (next) => {
        next.controls.cancellation = { epoch: "interleaved-cancel", request_id: "cancel_interleave_01", request_digest: digest("cancel-interleave"), expected_revision: current.revision, repository_generation: current.claim_generation, phase: "requested", requested_at: new Date().toISOString(), outstanding_operation_ids: [], terminal_operation_ids: [] };
        return next;
      });
    }
    return super.mutate(repo, deliveryId, expectedRevision, transform);
  }
}

test("agent task identities include canonical repository and persist exact packet", async () => {
  const packets: Record<string, unknown>[] = [];
  const adapter = trustedAdapter({ async dispatch(packet) { packets.push(packet); return { status: "running", effect: "accepted", terminal: "nonterminal", execution_id: `external-${packets.length}`, provider: "fixture", proof: { kind: "run_receipt", reference: `run_${packets.length}` } }; } });
  const engine = new DeliveryEngine({ store: new FileStateStore(mkdtempSync(join(tmpdir(), "delivery-task-scope-"))), executor: adapter });
  const a = seeded(engine, "owner/a", "same-delivery"), b = seeded(engine, "owner/b", "same-delivery");
  const afterA = await engine.dispatch(a.repo, a.delivery_id, a.revision), afterB = await engine.dispatch(b.repo, b.delivery_id, b.revision);
  assert.notEqual(afterA.runner.execution_id, afterB.runner.execution_id);
  for (const state of [afterA, afterB]) { const execution = state.executions.at(-1)!; assert.equal(execution.packet_digest, digest(execution.packet)); assert.equal(execution.packet?.task_id, execution.id); }
});

test("independent reviewer task identities include canonical repository", async () => {
  const tasks: string[] = [], candidate = "a".repeat(40), baseline = "b".repeat(40);
  const reviewer = trustedAdapter({ async dispatch(packet) { const task = String(packet.task_id); tasks.push(task); return { status: "completed", effect: "accepted", terminal: "completed", execution_id: `review-${tasks.length}`, provider: "fixture-reviewer", proof: { kind: "run_receipt", reference: `review_${tasks.length}` }, result: { status: "approved", delivery_id: packet.delivery_id, task_id: task, criteria_digest: (packet.criteria as Record<string, unknown>).criteria_digest, candidate_sha: candidate } }; } });
  const engine = new DeliveryEngine({ store: new FileStateStore(mkdtempSync(join(tmpdir(), "delivery-review-scope-"))), checker: { async verify(packet) { return { status: "success", candidate_sha: String(packet.candidate_sha) }; } }, reviewer });
  for (const repo of ["owner/a", "owner/b"]) {
    let state = engine.start({ repo, issue: 1, deliveryId: "same-delivery", policy: policy() });
    state = engine.store.mutate(repo, state.delivery_id, state.revision, (next) => { next.status = "implementation_required"; return next; });
    state = engine.acceptManifest(repo, state.delivery_id, { schema_version: 1, kind: "implement", repo, delivery_id: state.delivery_id, result: { issue: 1, candidate_sha: candidate, base: { repo, ref: "main", sha: baseline }, artifact_paths: ["src/change.ts"], verification: ["fixture"] } }, state.revision);
    state = engine.store.mutate(repo, state.delivery_id, state.revision, (next) => { next.manifests.implement!.producer_execution_id = "producer"; next.manifests.implement!.producer_identity = "fixture:producer"; return next; });
    state = await engine.verifyCandidate(repo, state.delivery_id, state.revision); assert.equal(state.receipts.engineering?.candidate_sha, candidate);
  }
  assert.equal(tasks.length, 2); assert.notEqual(tasks[0], tasks[1]);
});

test("protected reviewer observation timeout holds exact candidate review until later approval", async () => {
  const candidate = "a".repeat(40), baseline = "b".repeat(40); let dispatches = 0, collections = 0, packet: Record<string, unknown> = {};
  const reviewer = trustedAdapter({
    async dispatch(value) { dispatches += 1; packet = value; return { status: "running", effect: "accepted", terminal: "nonterminal", execution_id: "review-observation", provider: "paseo", proof: { kind: "run_receipt", reference: "review_observation" } }; },
    async inspect() { return { status: "uncertain", effect: "unknown", terminal: "nonterminal", execution_id: "review-observation", provider: "paseo", error: "poll requires wait" }; },
    async collect() {
      collections += 1;
      if (collections === 1) return { status: "timeout", effect: "accepted", terminal: "nonterminal", execution_id: "review-observation", provider: "paseo", proof: { kind: "run_receipt", reference: "review_observation" }, error: "observation timed out" };
      return { status: "completed", effect: "accepted", terminal: "completed", execution_id: "review-observation", provider: "paseo", proof: { kind: "run_receipt", reference: "review_observation" }, result: { status: "approved", delivery_id: "review-observation-hold", task_id: packet.task_id, criteria_digest: (packet.criteria as Record<string, unknown>).criteria_digest, candidate_sha: candidate } };
    },
  });
  const engine = new DeliveryEngine({ store: new FileStateStore(mkdtempSync(join(tmpdir(), "delivery-review-observation-"))), checker: { async verify() { return { status: "success", candidate_sha: candidate }; } }, reviewer });
  let state = engine.start({ repo: "owner/repo", issue: 1, deliveryId: "review-observation-hold", policy: policy() });
  state = engine.store.mutate(state.repo, state.delivery_id, state.revision, (next) => { next.status = "implementation_required"; return next; });
  state = engine.acceptManifest(state.repo, state.delivery_id, { schema_version: 1, kind: "implement", repo: state.repo, delivery_id: state.delivery_id, result: { issue: 1, candidate_sha: candidate, base: { repo: state.repo, ref: "main", sha: baseline }, artifact_paths: ["src/change.ts"], verification: ["fixture"] } }, state.revision);
  state = engine.store.mutate(state.repo, state.delivery_id, state.revision, (next) => { next.manifests.implement!.producer_execution_id = "producer"; next.manifests.implement!.producer_identity = "fixture:producer"; return next; });
  state = await engine.verifyCandidate(state.repo, state.delivery_id, state.revision); const taskId = state.executions.at(-1)!.id;
  assert.equal(state.executions.at(-1)?.status, "running"); assert.equal(state.status, "implementation_review"); assert.deepEqual(state.unresolved_effects, []);
  state = await engine.verifyCandidate(state.repo, state.delivery_id, state.revision);
  assert.equal(state.receipts.engineering?.candidate_sha, candidate); assert.equal(state.executions.at(-1)?.id, taskId); assert.equal(state.executions.at(-1)?.external_id, "review-observation"); assert.deepEqual([dispatches, collections], [1, 2]);
});

test("explicit accepted-reviewer drain collects despite running inspection", async () => {
  const candidate = "a".repeat(40), baseline = "b".repeat(40); let dispatches = 0, collections = 0, reviewPacket: Record<string, unknown> = {};
  const reviewer = trustedAdapter({
    async dispatch(packet) { dispatches += 1; reviewPacket = packet; return { status: "running", effect: "accepted", terminal: "nonterminal", execution_id: "review-drain-running", provider: "pi", proof: { kind: "run_receipt", reference: "review_drain_running" } }; },
    async inspect() { return { status: "running", effect: "accepted", terminal: "nonterminal", execution_id: "review-drain-running", provider: "pi", proof: { kind: "run_receipt", reference: "review_drain_running" } }; },
    async collect() { collections += 1; return { status: "completed", effect: "accepted", terminal: "completed", execution_id: "review-drain-running", provider: "pi", proof: { kind: "run_receipt", reference: "review_drain_terminal" }, result: { status: "approved", delivery_id: "review-explicit-drain", task_id: reviewPacket.task_id, criteria_digest: (reviewPacket.criteria as Record<string, unknown>).criteria_digest, candidate_sha: candidate } }; },
  });
  const engine = new DeliveryEngine({ store: new FileStateStore(mkdtempSync(join(tmpdir(), "delivery-review-explicit-drain-"))), checker: { async verify() { return { status: "success", candidate_sha: candidate }; } }, reviewer });
  let state = engine.start({ repo: "owner/repo", issue: 1, deliveryId: "review-explicit-drain", policy: policy() });
  state = engine.store.mutate(state.repo, state.delivery_id, state.revision, (next) => { next.status = "implementation_required"; return next; });
  state = engine.acceptManifest(state.repo, state.delivery_id, { schema_version: 1, kind: "implement", repo: state.repo, delivery_id: state.delivery_id, result: { issue: 1, candidate_sha: candidate, base: { repo: state.repo, ref: "main", sha: baseline }, artifact_paths: ["src/change.ts"], verification: ["fixture"] } }, state.revision);
  state = engine.store.mutate(state.repo, state.delivery_id, state.revision, (next) => { next.manifests.implement!.producer_execution_id = "producer"; next.manifests.implement!.producer_identity = "fixture:producer"; return next; });
  state = await engine.verifyCandidate(state.repo, state.delivery_id, state.revision); assert.equal(state.executions.at(-1)?.status, "running"); assert.equal(collections, 0);
  state = await engine.drainAcceptedExecution(state.repo, state.delivery_id, state.revision);
  assert.equal(state.executions.at(-1)?.status, "completed"); assert.deepEqual([dispatches, collections], [1, 1]);
});

test("terminal agent inspection still collects to retire owned runtime resources", async () => {
  let collectCalls = 0;
  const result = {
    manifest: {
      schema_version: 1,
      kind: "plan",
      repo: "owner/repo",
      delivery_id: "terminal-agent-cleanup",
      result: {
        issue: 1,
        plan_revision: "3".repeat(40),
        baseline: { repo: "owner/repo", ref: "main", sha: "4".repeat(40) },
        artifact_paths: ["plan.md"],
        artifact_hashes: { "plan.md": "a".repeat(64) },
      },
    },
  };
  const terminal = { status: "completed", effect: "accepted", terminal: "completed", execution_id: "terminal-agent-external", provider: "fixture", proof: { kind: "run_receipt", reference: "terminal_agent" }, result };
  const adapter = trustedAdapter({
    async dispatch() { return { status: "running", effect: "accepted", terminal: "nonterminal", execution_id: "terminal-agent-external", provider: "fixture", proof: { kind: "run_receipt", reference: "running_agent" } }; },
    async inspect() { return terminal; },
    async collect() { collectCalls += 1; return terminal; },
  });
  const engine = new DeliveryEngine({ store: new FileStateStore(mkdtempSync(join(tmpdir(), "delivery-terminal-agent-cleanup-"))), executor: adapter });
  let state = seeded(engine, "owner/repo", "terminal-agent-cleanup");
  state = await engine.dispatch(state.repo, state.delivery_id, state.revision);
  state = await engine.collect(state.repo, state.delivery_id, state.revision);
  assert.equal(collectCalls, 1, "terminal evidence does not replace owned-runtime cleanup");
  assert.equal(state.status, "plan_review");
  assert.equal(state.runner.status, "idle");
});

test("terminal reviewer inspection still collects to retire owned runtime resources", async () => {
  const candidate = "a".repeat(40), baseline = "b".repeat(40);
  let collectCalls = 0, reviewPacket: JsonObject = {};
  const reviewer = trustedAdapter({
    async dispatch(packet) { reviewPacket = packet as JsonObject; return { status: "running", effect: "accepted", terminal: "nonterminal", execution_id: "terminal-review-external", provider: "fixture-reviewer", proof: { kind: "run_receipt", reference: "running_review" } }; },
    async inspect() { return { status: "completed", effect: "accepted", terminal: "completed", execution_id: "terminal-review-external", provider: "fixture-reviewer", proof: { kind: "run_receipt", reference: "terminal_review" }, result: { status: "approved", delivery_id: "terminal-review-cleanup", task_id: reviewPacket.task_id, criteria_digest: (reviewPacket.criteria as JsonObject).criteria_digest, candidate_sha: candidate } }; },
    async collect() { collectCalls += 1; return { status: "completed", effect: "accepted", terminal: "completed", execution_id: "terminal-review-external", provider: "fixture-reviewer", proof: { kind: "run_receipt", reference: "terminal_review" }, result: { status: "approved", delivery_id: "terminal-review-cleanup", task_id: reviewPacket.task_id, criteria_digest: (reviewPacket.criteria as JsonObject).criteria_digest, candidate_sha: candidate } }; },
  });
  const engine = new DeliveryEngine({ store: new FileStateStore(mkdtempSync(join(tmpdir(), "delivery-terminal-review-cleanup-"))), checker: { async verify(packet) { return { status: "success", candidate_sha: String(packet.candidate_sha) }; } }, reviewer });
  let state = engine.start({ repo: "owner/repo", issue: 1, deliveryId: "terminal-review-cleanup", policy: policy() });
  state = engine.store.mutate(state.repo, state.delivery_id, state.revision, (next) => { next.status = "implementation_required"; return next; });
  state = engine.acceptManifest(state.repo, state.delivery_id, { schema_version: 1, kind: "implement", repo: state.repo, delivery_id: state.delivery_id, result: { issue: 1, candidate_sha: candidate, base: { repo: state.repo, ref: "main", sha: baseline }, artifact_paths: ["src/change.ts"], verification: ["fixture"] } }, state.revision);
  state = engine.store.mutate(state.repo, state.delivery_id, state.revision, (next) => { next.manifests.implement!.producer_execution_id = "producer"; next.manifests.implement!.producer_identity = "fixture:producer"; return next; });
  state = await engine.verifyCandidate(state.repo, state.delivery_id, state.revision);
  assert.equal(collectCalls, 1, "terminal reviewer evidence does not replace owned-runtime cleanup");
  assert.equal(state.receipts.engineering?.candidate_sha, candidate);
});

test("candidate verification resumes a matching pre-repository reviewer intent", async () => {
  const candidate = "a".repeat(40), baseline = "b".repeat(40), dispatchedTasks: string[] = [];
  const reviewer = trustedAdapter({
    async dispatch(packet) {
      const task = String(packet.task_id); dispatchedTasks.push(task);
      return { status: "completed", effect: "accepted", terminal: "completed", execution_id: "legacy-review-external", provider: "fixture-reviewer", proof: { kind: "run_receipt", reference: "legacy_review" }, result: { status: "approved", delivery_id: packet.delivery_id, task_id: task, criteria_digest: (packet.criteria as Record<string, unknown>).criteria_digest, candidate_sha: candidate } };
    },
  });
  const engine = new DeliveryEngine({ store: new FileStateStore(mkdtempSync(join(tmpdir(), "delivery-review-legacy-"))), checker: { async verify(packet) { return { status: "success", candidate_sha: String(packet.candidate_sha) }; } }, reviewer });
  let state = engine.start({ repo: "owner/repo", issue: 1, deliveryId: "legacy-review", policy: policy() });
  state = engine.store.mutate(state.repo, state.delivery_id, state.revision, (next) => { next.status = "implementation_required"; return next; });
  state = engine.acceptManifest(state.repo, state.delivery_id, { schema_version: 1, kind: "implement", repo: state.repo, delivery_id: state.delivery_id, result: { issue: 1, candidate_sha: candidate, base: { repo: state.repo, ref: "main", sha: baseline }, artifact_paths: ["src/change.ts"], verification: ["fixture"] } }, state.revision);
  state = engine.store.mutate(state.repo, state.delivery_id, state.revision, (next) => {
    const manifest = next.manifests.implement!; manifest.producer_execution_id = "producer"; manifest.producer_identity = "fixture:producer";
    const criteriaDigest = digest({ delivery_id: next.delivery_id, issue: next.issue, candidate_sha: candidate, manifest_digest: manifest.digest, plan_digest: null, producer_execution_id: "producer", producer_identity: "fixture:producer" });
    const legacyTaskId = digest({ delivery: next.delivery_id, kind: "engineering_review", candidate, manifest: manifest.digest, criteria_digest: criteriaDigest }).slice(0, 24);
    const packet = { schema_version: 1, kind: "review", repo: next.repo, delivery_id: next.delivery_id, candidate_sha: candidate, criteria: { issue: next.issue, manifest_digest: manifest.digest, criteria_digest: criteriaDigest }, producer_execution_id: "producer", producer_identity: "fixture:producer", task_id: legacyTaskId };
    next.executions.push({ id: legacyTaskId, kind: "reviewer", stage: "engineering_review", status: "dispatching", packet_digest: digest(packet), packet, started_at: new Date().toISOString() });
    return next;
  });
  const legacyTaskId = state.executions[0]!.id;
  state = await engine.verifyCandidate(state.repo, state.delivery_id, state.revision);
  assert.deepEqual(dispatchedTasks, [legacyTaskId]);
  assert.equal(state.executions.length, 1);
  assert.equal(state.receipts.engineering?.candidate_sha, candidate);
});

test("checker result cannot advance after cancellation wins the reconciliation race", async () => {
  const candidate = "a".repeat(40), baseline = "b".repeat(40);
  const store = new CancellationInterleavingStore(mkdtempSync(join(tmpdir(), "delivery-check-cancel-race-")));
  const engine = new DeliveryEngine({ store, checker: { async verify(packet) { store.armCancellation(); return { status: "success", candidate_sha: String(packet.candidate_sha) }; } }, reviewer: trustedAdapter() });
  let state = engine.start({ repo: "owner/repo", issue: 1, deliveryId: "check-cancel-race", policy: policy() });
  state = store.mutate(state.repo, state.delivery_id, state.revision, (next) => { next.status = "implementation_required"; return next; });
  state = engine.acceptManifest(state.repo, state.delivery_id, { schema_version: 1, kind: "implement", repo: state.repo, delivery_id: state.delivery_id, result: { issue: 1, candidate_sha: candidate, base: { repo: state.repo, ref: "main", sha: baseline }, artifact_paths: ["src/change.ts"], verification: ["fixture"] } }, state.revision);
  state = store.mutate(state.repo, state.delivery_id, state.revision, (next) => { next.manifests.implement!.producer_execution_id = "producer"; next.manifests.implement!.producer_identity = "fixture:producer"; return next; });
  await assert.rejects(() => engine.verifyCandidate(state.repo, state.delivery_id, state.revision));
  const after = store.read(state.repo, state.delivery_id);
  assert.equal(after.receipts.checks, undefined);
  assert.equal(after.receipts.engineering, undefined);
  assert.equal(after.controls.cancellation?.epoch, "interleaved-cancel");
});

test("completed reviewer result cannot advance after cancellation wins the gate race", async () => {
  const candidate = "a".repeat(40), baseline = "b".repeat(40);
  const store = new CancellationInterleavingStore(mkdtempSync(join(tmpdir(), "delivery-review-cancel-race-")));
  const engine = new DeliveryEngine({ store, checker: { async verify() { throw new Error("checker should not run"); } }, reviewer: trustedAdapter() });
  let state = engine.start({ repo: "owner/repo", issue: 1, deliveryId: "review-cancel-race", policy: policy() });
  state = store.mutate(state.repo, state.delivery_id, state.revision, (next) => { next.status = "implementation_required"; return next; });
  state = engine.acceptManifest(state.repo, state.delivery_id, { schema_version: 1, kind: "implement", repo: state.repo, delivery_id: state.delivery_id, result: { issue: 1, candidate_sha: candidate, base: { repo: state.repo, ref: "main", sha: baseline }, artifact_paths: ["src/change.ts"], verification: ["fixture"] } }, state.revision);
  state = store.mutate(state.repo, state.delivery_id, state.revision, (next) => {
    const manifest = next.manifests.implement!; manifest.producer_execution_id = "producer"; manifest.producer_identity = "fixture:producer";
    const criteriaDigest = digest({ delivery_id: next.delivery_id, issue: next.issue, candidate_sha: candidate, manifest_digest: manifest.digest, plan_digest: null, producer_execution_id: "producer", producer_identity: "fixture:producer" });
    const taskId = digest({ repo: next.repo_identity, delivery: next.delivery_id, kind: "engineering_review", candidate, manifest: manifest.digest, criteria_digest: criteriaDigest }).slice(0, 24);
    const packet = { schema_version: 1, kind: "review", repo: next.repo, delivery_id: next.delivery_id, manifest_generation: manifest.generation, candidate_sha: candidate, criteria: { issue: next.issue, manifest_digest: manifest.digest, criteria_digest: criteriaDigest }, producer_execution_id: "producer", producer_identity: "fixture:producer", task_id: taskId };
    next.receipts.checks = { status: "success", candidate_sha: candidate, manifest_digest: manifest.digest };
    next.executions.push({ id: taskId, kind: "reviewer", stage: "engineering_review", status: "completed", external_id: "review-external", provider: "fixture-reviewer", packet_digest: digest(packet), packet, started_at: new Date().toISOString(), finished_at: new Date().toISOString(), result: { status: "approved", delivery_id: next.delivery_id, task_id: taskId, criteria_digest: criteriaDigest, candidate_sha: candidate } });
    return next;
  });
  store.armCancellation();
  await assert.rejects(() => engine.verifyCandidate(state.repo, state.delivery_id, state.revision));
  const after = store.read(state.repo, state.delivery_id);
  assert.equal(after.receipts.engineering, undefined);
  assert.equal(after.controls.cancellation?.epoch, "interleaved-cancel");
});

test("accepted agent identity survives a cancellation CAS after adapter return", async () => {
  const store = new CancellationInterleavingStore(mkdtempSync(join(tmpdir(), "delivery-agent-return-cancel-")));
  const adapter = trustedAdapter({
    async dispatch() { return { status: "running", effect: "accepted", terminal: "nonterminal", execution_id: "agent-external-returned", provider: "fixture", proof: { kind: "run_receipt", reference: "agent_returned" } }; },
    async resolveOutcomeProof(_outcome, context) { store.armCancellation(); return { trusted: true, proof_digest: digest(context) }; },
  });
  const engine = new DeliveryEngine({ store, executor: adapter }); let state = seeded(engine, "owner/repo", "agent-return-cancel");
  state = await engine.dispatch(state.repo, state.delivery_id, state.revision);
  assert.equal(state.controls.cancellation?.epoch, "interleaved-cancel");
  assert.equal(state.executions.at(-1)?.external_id, "agent-external-returned");
  assert.equal(state.executions.at(-1)?.proof?.reference, "agent_returned");
  assert.equal(state.executions.at(-1)?.status, "uncertain");
  assert.equal(state.runner.status, "dispatching");
  assert.equal(state.status, "plan_required");
});

test("accepted reviewer identity survives a cancellation CAS after adapter return", async () => {
  const candidate = "a".repeat(40), baseline = "b".repeat(40), store = new CancellationInterleavingStore(mkdtempSync(join(tmpdir(), "delivery-reviewer-return-cancel-")));
  const reviewer = trustedAdapter({
    async dispatch(packet) { return { status: "running", effect: "accepted", terminal: "nonterminal", execution_id: "reviewer-external-returned", provider: "fixture-reviewer", proof: { kind: "run_receipt", reference: "reviewer_returned" }, result: { status: "approved", delivery_id: packet.delivery_id, task_id: packet.task_id, criteria_digest: (packet.criteria as JsonObject).criteria_digest, candidate_sha: candidate } }; },
    async resolveOutcomeProof(_outcome, context) { store.armCancellation(); return { trusted: true, proof_digest: digest(context) }; },
  });
  const engine = new DeliveryEngine({ store, checker: { async verify(packet) { return { status: "success", candidate_sha: String(packet.candidate_sha) }; } }, reviewer });
  let state = engine.start({ repo: "owner/repo", issue: 1, deliveryId: "reviewer-return-cancel", policy: policy() });
  state = store.mutate(state.repo, state.delivery_id, state.revision, (next) => { next.status = "implementation_required"; return next; });
  state = engine.acceptManifest(state.repo, state.delivery_id, { schema_version: 1, kind: "implement", repo: state.repo, delivery_id: state.delivery_id, result: { issue: 1, candidate_sha: candidate, base: { repo: state.repo, ref: "main", sha: baseline }, artifact_paths: ["src/change.ts"], verification: ["fixture"] } }, state.revision);
  state = store.mutate(state.repo, state.delivery_id, state.revision, (next) => { next.manifests.implement!.producer_execution_id = "producer"; next.manifests.implement!.producer_identity = "fixture:producer"; return next; });
  state = await engine.verifyCandidate(state.repo, state.delivery_id, state.revision);
  assert.equal(state.controls.cancellation?.epoch, "interleaved-cancel");
  assert.equal(state.executions.at(-1)?.external_id, "reviewer-external-returned");
  assert.equal(state.executions.at(-1)?.proof?.reference, "reviewer_returned");
  assert.equal(state.executions.at(-1)?.status, "uncertain");
  assert.equal(state.status, "implementation_review");
});

test("trusted terminal failure clears only its execution while legacy output remains uncertain", async () => {
  const failed: AdapterOutcome = { status: "failed", effect: "accepted", terminal: "failed", execution_id: "external-1", provider: "fixture", proof: { kind: "process_exit", reference: "exit_1" }, error: "fixture failed" };
  const adapter = trustedAdapter({ async inspect() { return failed as unknown as Record<string, unknown>; }, async collect() { return failed as unknown as Record<string, unknown>; } });
  const engine = new DeliveryEngine({ store: new FileStateStore(mkdtempSync(join(tmpdir(), "delivery-terminal-proof-"))), executor: adapter });
  let state = seeded(engine, "owner/repo", "terminal-proof"); state = await engine.dispatch(state.repo, state.delivery_id, state.revision); state = await engine.collect(state.repo, state.delivery_id, state.revision);
  assert.equal(state.executions.at(-1)?.status, "failed"); assert.deepEqual(state.unresolved_effects, []);

  const legacy = trustedAdapter({ async dispatch() { return { status: "running", execution_id: "legacy" }; } });
  const legacyEngine = new DeliveryEngine({ store: new FileStateStore(mkdtempSync(join(tmpdir(), "delivery-legacy-outcome-"))), executor: legacy });
  let legacyState = seeded(legacyEngine, "owner/repo", "legacy-outcome"); legacyState = await legacyEngine.dispatch(legacyState.repo, legacyState.delivery_id, legacyState.revision);
  assert.equal(legacyState.executions.at(-1)?.status, "uncertain"); assert.deepEqual(legacyState.unresolved_effects, [legacyState.executions.at(-1)!.id]);

  const staleProofAdapter = trustedAdapter({ async inspect() { return { status: "failed", execution_id: "external-1" }; }, async collect() { return { status: "failed", execution_id: "external-1" }; } });
  const staleProofEngine = new DeliveryEngine({ store: new FileStateStore(mkdtempSync(join(tmpdir(), "delivery-stale-proof-"))), executor: staleProofAdapter });
  let staleProofState = seeded(staleProofEngine, "owner/repo", "stale-proof"); staleProofState = await staleProofEngine.dispatch(staleProofState.repo, staleProofState.delivery_id, staleProofState.revision);
  assert.equal(staleProofState.executions.at(-1)?.proof?.kind, "run_receipt"); staleProofState = await staleProofEngine.collect(staleProofState.repo, staleProofState.delivery_id, staleProofState.revision);
  assert.equal(staleProofState.executions.at(-1)?.status, "uncertain"); assert.equal(staleProofState.executions.at(-1)?.proof, undefined); assert.equal(staleProofState.executions.at(-1)?.proof_digest, undefined);
});

test("cancel during dispatch retains late external identity and releases only through exact repository fence", async () => {
  let release!: (value: Record<string, unknown>) => void;
  const dispatchResult = new Promise<Record<string, unknown>>((resolve) => { release = resolve; });
  const adapter = trustedAdapter({ async dispatch() { return dispatchResult; } });
  const engine = new DeliveryEngine({ store: new FileStateStore(mkdtempSync(join(tmpdir(), "delivery-cancel-fence-"))), executor: adapter, controlGrant: { token: "grant", repositories: ["owner/repo"], actions: ["cancel"] } });
  let state = seeded(engine, "owner/repo", "cancel-fence"), dispatching = engine.dispatch(state.repo, state.delivery_id, state.revision);
  await new Promise((resolve) => setImmediate(resolve)); state = engine.store.read(state.repo, state.delivery_id);
  const inputDigest = digest({ action: "cancel", delivery: state.delivery_id, expected_revision: state.revision });
  const context = { repo: state.repo, delivery_id: state.delivery_id, expected_revision: state.revision, request_id: "cancel_request_01", input_digest: inputDigest, repository_generation: 7, grant: "grant" };
  const begun = engine.beginCancellation(context); release({ status: "running", effect: "accepted", terminal: "nonterminal", execution_id: "external-late", provider: "fixture", proof: { kind: "run_receipt", reference: "late_accept" } });
  state = await dispatching; assert.equal(state.executions.at(-1)?.external_id, "external-late"); assert.equal(state.controls.cancellation?.epoch, begun.epoch); assert.notEqual(state.claim_status, "released");
  const reconciled = await engine.reconcileCancellation(context, { executor: adapter }); assert.equal(reconciled.status, "draining");
  const fence: RepositoryCancellationFence = { repo: state.repo, delivery_id: state.delivery_id, request_id: context.request_id, input_digest: inputDigest, epoch: begun.epoch, reservation_token: "reservation", generation: 7, claim_generation: 1, owner_token_digest: digest("owner"), stopped_drained_ack_digest: digest("drained") };
  assert.throws(() => engine.finalizeCancellation(context, { ...fence, generation: 6 }), /fence differs/);
  assert.throws(() => engine.finalizeCancellation(context, { ...fence, claim_generation: 2 }), /fence differs/);
  assert.equal(engine.finalizeCancellation(context, fence).released, true); const released = engine.store.read(state.repo, state.delivery_id); assert.equal(released.claim_status, "released"); assert.equal(released.status, "cancelled");
});

test("cancellation execution readback revalidates protected terminal proof without external effects", async () => {
  let dispatches = 0, inspections = 0, cancels = 0, collections = 0;
  const terminal: AdapterOutcome = { status: "cancelled", effect: "accepted", terminal: "cancelled", execution_id: "readback-external", provider: "pi", proof: { kind: "run_receipt", reference: "readback_terminal" } };
  const adapter = trustedAdapter({
    async dispatch() { dispatches += 1; return { status: "running", effect: "accepted", terminal: "nonterminal", execution_id: "readback-external", provider: "pi", proof: { kind: "run_receipt", reference: "readback_running" } }; },
    async inspect() { inspections += 1; return terminal as unknown as Record<string, unknown>; },
    async collect() { collections += 1; throw new Error("readback must not collect"); },
    async cancel() { cancels += 1; throw new Error("readback must not cancel"); },
  });
  const engine = new DeliveryEngine({ store: new FileStateStore(mkdtempSync(join(tmpdir(), "delivery-cancel-readback-"))), executor: adapter, controlGrant: { token: "grant", repositories: ["owner/repo"], actions: ["cancel"] } });
  let state = seeded(engine, "owner/repo", "cancel-readback"); state = await engine.dispatch(state.repo, state.delivery_id, state.revision);
  const executionId = state.executions.at(-1)!.id, inputDigest = digest({ action: "cancel-readback" });
  const context = { repo: state.repo, delivery_id: state.delivery_id, expected_revision: state.revision, request_id: "cancel_readback_01", input_digest: inputDigest, repository_generation: 3, grant: "grant" };
  engine.beginCancellation(context);
  state = engine.store.mutate(state.repo, state.delivery_id, undefined, (next) => { const found = next.executions.find((item) => item.id === executionId)!; found.status = "cancelled"; found.terminal = "cancelled"; found.cancellation = { epoch: next.controls.cancellation!.epoch, status: "completed", requested_at: next.controls.cancellation!.requested_at, completed_at: next.controls.cancellation!.requested_at }; return next; });
  const result = await engine.reconcileCancellationExecutionReadback(context, executionId, { executor: adapter });
  assert.equal(result.status, "draining"); assert.deepEqual(result.outstanding_operation_ids, []); assert.deepEqual(result.terminal_operation_ids, [executionId]);
  const refreshed = engine.store.read(state.repo, state.delivery_id), execution = refreshed.executions.find((item) => item.id === executionId)!;
  assert.equal(execution.proof?.reference, "readback_terminal"); assert.match(String(execution.proof_digest), /^[0-9a-f]{64}$/); assert.equal(execution.cancellation?.status, "completed");
  const fence: RepositoryCancellationFence = { repo: state.repo, delivery_id: state.delivery_id, request_id: context.request_id, input_digest: inputDigest, epoch: engine.store.read(state.repo, state.delivery_id).controls.cancellation!.epoch, reservation_token: "readback-reservation", generation: 3, claim_generation: 1, owner_token_digest: digest("readback-owner"), stopped_drained_ack_digest: digest("readback-drained") };
  engine.finalizeCancellation(context, fence);
  const replay = await engine.reconcileCancellationExecutionReadback(context, executionId, { executor: adapter }); assert.equal(replay.status, "complete");
  assert.equal(engine.store.read(state.repo, state.delivery_id).claim_status, "released"); assert.deepEqual([dispatches, inspections, cancels, collections], [1, 2, 0, 0]);
});

test("cancellation execution readback does not trust stale terminal engine state without protected proof", async () => {
  const terminal: AdapterOutcome = { status: "cancelled", effect: "accepted", terminal: "cancelled", execution_id: "untrusted-readback", provider: "pi", proof: { kind: "run_receipt", reference: "untrusted_terminal" } };
  const adapter = trustedAdapter({ async dispatch() { return { status: "running", effect: "accepted", terminal: "nonterminal", execution_id: "untrusted-readback", provider: "pi", proof: { kind: "run_receipt", reference: "untrusted_running" } }; }, async inspect() { return terminal as unknown as Record<string, unknown>; }, async resolveOutcomeProof() { return { trusted: false, error: "exact child exit is unproven" }; } });
  const engine = new DeliveryEngine({ store: new FileStateStore(mkdtempSync(join(tmpdir(), "delivery-cancel-readback-untrusted-"))), executor: adapter, controlGrant: { token: "grant", repositories: ["owner/repo"], actions: ["cancel"] } });
  let state = seeded(engine, "owner/repo", "cancel-readback-untrusted"); state = await engine.dispatch(state.repo, state.delivery_id, state.revision);
  const executionId = state.executions.at(-1)!.id, inputDigest = digest({ action: "cancel-readback-untrusted" });
  const context = { repo: state.repo, delivery_id: state.delivery_id, expected_revision: state.revision, request_id: "cancel_readback_untrusted_01", input_digest: inputDigest, repository_generation: 3, grant: "grant" };
  engine.beginCancellation(context);
  engine.store.mutate(state.repo, state.delivery_id, undefined, (next) => { const found = next.executions.find((item) => item.id === executionId)!; found.status = "cancelled"; found.terminal = "cancelled"; return next; });
  const result = await engine.reconcileCancellationExecutionReadback(context, executionId, { executor: adapter });
  assert.equal(result.status, "uncertain"); assert.deepEqual(result.outstanding_operation_ids, [executionId]);
  const execution = engine.store.read(state.repo, state.delivery_id).executions.find((item) => item.id === executionId)!;
  assert.equal(execution.status, "uncertain"); assert.equal(execution.effect, "unknown"); assert.equal(execution.terminal, "nonterminal"); assert.equal(execution.proof, undefined); assert.equal(execution.cancellation?.status, "uncertain");
});

test("completed cancellation readback preserves release but refuses untrusted quiescence", async () => {
  let trusted = true;
  const terminal: AdapterOutcome = { status: "cancelled", effect: "accepted", terminal: "cancelled", execution_id: "complete-readback", provider: "pi", proof: { kind: "run_receipt", reference: "complete_readback" } };
  const adapter = trustedAdapter({ async dispatch() { return { status: "running", effect: "accepted", terminal: "nonterminal", execution_id: "complete-readback", provider: "pi", proof: { kind: "run_receipt", reference: "complete_running" } }; }, async inspect() { return terminal as unknown as Record<string, unknown>; }, async resolveOutcomeProof(_outcome, context) { return trusted ? { trusted: true, proof_digest: digest(context) } : { trusted: false, error: "child exit proof was tampered" }; } });
  const engine = new DeliveryEngine({ store: new FileStateStore(mkdtempSync(join(tmpdir(), "delivery-complete-readback-"))), executor: adapter, controlGrant: { token: "grant", repositories: ["owner/repo"], actions: ["cancel"] } });
  let state = seeded(engine, "owner/repo", "complete-readback"); state = await engine.dispatch(state.repo, state.delivery_id, state.revision); const executionId = state.executions.at(-1)!.id;
  const inputDigest = digest({ action: "complete-readback" }), context = { repo: state.repo, delivery_id: state.delivery_id, expected_revision: state.revision, request_id: "complete_readback_01", input_digest: inputDigest, repository_generation: 4, grant: "grant" };
  const begun = engine.beginCancellation(context); assert.equal((await engine.reconcileCancellationExecutionReadback(context, executionId, { executor: adapter })).status, "draining");
  engine.finalizeCancellation(context, { repo: state.repo, delivery_id: state.delivery_id, request_id: context.request_id, input_digest: inputDigest, epoch: begun.epoch, reservation_token: "complete-reservation", generation: 4, claim_generation: 1, owner_token_digest: digest("complete-owner"), stopped_drained_ack_digest: digest("complete-drained") });
  trusted = false; const replay = await engine.reconcileCancellationExecutionReadback(context, executionId, { executor: adapter });
  assert.equal(replay.status, "uncertain"); assert.deepEqual(replay.outstanding_operation_ids, [executionId]);
  const released = engine.store.read(state.repo, state.delivery_id); assert.equal(released.claim_status, "released"); assert.equal(released.controls.cancellation?.phase, "complete"); assert.equal(released.executions.find((item) => item.id === executionId)?.status, "uncertain");
});

test("pending cancellation blocks a new execution intent", async () => {
  let calls = 0; const adapter = trustedAdapter({ async dispatch() { calls += 1; return { status: "running", effect: "accepted", terminal: "nonterminal", execution_id: "unexpected", proof: { kind: "run_receipt", reference: "unexpected" } }; } });
  const engine = new DeliveryEngine({ store: new FileStateStore(mkdtempSync(join(tmpdir(), "delivery-cancel-block-"))), executor: adapter, controlGrant: { token: "grant", repositories: ["owner/repo"], actions: ["cancel"] } });
  const state = seeded(engine, "owner/repo", "cancel-block"), inputDigest = digest({ action: "cancel-block" });
  engine.beginCancellation({ repo: state.repo, delivery_id: state.delivery_id, expected_revision: state.revision, request_id: "cancel_block_01", input_digest: inputDigest, grant: "grant" });
  const current = engine.store.read(state.repo, state.delivery_id); await assert.rejects(() => engine.dispatch(current.repo, current.delivery_id, current.revision), /cancellation is pending/); assert.equal(calls, 0);
});

test("trusted returned and thrown reviewer preflight refusals stop before observation and explain the block", async () => {
  for (const thrown of [false, true]) {
    let dispatches = 0, inspections = 0, collections = 0;
    const refusal: AdapterOutcome = { status: "failed", effect: "none", terminal: "failed", execution_id: `preflight-${thrown}`, provider: "pi",
      proof: { kind: "preflight_refusal", reference: `preflight_${thrown}` }, error: "reviewer unavailable" };
    const reviewer = trustedAdapter({
      async dispatch() { dispatches += 1; if (thrown) throw new AdapterRefusal("reviewer unavailable", "REVIEWER_UNAVAILABLE", refusal); return refusal as unknown as Record<string, unknown>; },
      async inspect() { inspections += 1; throw new Error("preflight refusal must not be inspected"); },
      async collect() { collections += 1; throw new Error("preflight refusal must not be collected"); },
    });
    const engine = new DeliveryEngine({ store: new FileStateStore(mkdtempSync(join(tmpdir(), `delivery-review-preflight-${thrown}-`))),
      checker: { async verify(packet) { return { status: "success", candidate_sha: String(packet.candidate_sha) }; } }, reviewer });
    let state = implementationCandidate(engine, `review-preflight-${thrown}`);
    state = await engine.verifyCandidate(state.repo, state.delivery_id, state.revision);
    assert.equal(state.status, "blocked"); assert.equal(state.executions.at(-1)?.status, "failed"); assert.equal(state.executions.at(-1)?.finished_at !== undefined, true);
    assert.equal(state.executions.at(-1)?.proof?.kind, "preflight_refusal"); assert.deepEqual(state.unresolved_effects, []);
    assert.deepEqual([dispatches, inspections, collections], [1, 0, 0]);
    const run = (await import("../src/projection.ts")).dashboardProjection(state).runs as Array<Record<string, unknown>>;
    assert.deepEqual(run[0]?.blockers, [{ code: "REVIEW_PREFLIGHT_REFUSED", message: "Reviewer could not start. No review work began." }]);
    const unchanged = await engine.verifyCandidate(state.repo, state.delivery_id, state.revision);
    assert.equal(unchanged.revision, state.revision); assert.deepEqual([dispatches, inspections, collections], [1, 0, 0]);
  }
});

test("untrusted reviewer preflight evidence stays uncertain and cannot offer retry authority", async () => {
  let inspections = 0, collections = 0;
  const reviewer = trustedAdapter({
    async dispatch() { return { status: "failed", effect: "none", terminal: "failed", execution_id: "untrusted-preflight", provider: "pi", proof: { kind: "preflight_refusal", reference: "untrusted_preflight" } }; },
    async inspect() { inspections += 1; return {}; }, async collect() { collections += 1; return {}; },
    async resolveOutcomeProof() { return { trusted: false, error: "receipt context mismatch" }; },
  });
  const engine = new DeliveryEngine({ store: new FileStateStore(mkdtempSync(join(tmpdir(), "delivery-review-preflight-untrusted-"))),
    checker: { async verify(packet) { return { status: "success", candidate_sha: String(packet.candidate_sha) }; } }, reviewer,
    controlGrant: { token: "grant", repositories: ["owner/repo"], actions: ["retry_review"] } });
  let state = implementationCandidate(engine, "review-preflight-untrusted"); state = await engine.verifyCandidate(state.repo, state.delivery_id, state.revision);
  assert.equal(state.executions.at(-1)?.status, "uncertain"); assert.deepEqual(state.unresolved_effects, [state.executions.at(-1)!.id]);
  assert.deepEqual([inspections, collections], [0, 0]);
  const before = state.revision;
  await assert.rejects(() => engine.control({ repo: state.repo, deliveryId: state.delivery_id, expectedRevision: state.revision, action: "retry_review", requestId: "retry_untrusted_001", grant: "grant" }), /clean preflight block/);
  assert.equal(engine.store.read(state.repo, state.delivery_id).revision, before);
});

test("explicit review retry authorizes one distinct intent without dispatch and readback is inert", async () => {
  const candidate = "a".repeat(40); let dispatches = 0, inspections = 0, collections = 0, lastPacket: Record<string, unknown> = {};
  const reviewer = trustedAdapter({
    async dispatch(packet) {
      dispatches += 1; lastPacket = packet;
      if (dispatches === 1) return { status: "failed", effect: "none", terminal: "failed", execution_id: "retry-preflight", provider: "pi", proof: { kind: "preflight_refusal", reference: "retry_preflight" }, error: "reviewer preflight unavailable" };
      return { status: "completed", effect: "accepted", terminal: "completed", execution_id: "retry-complete", provider: "pi", proof: { kind: "run_receipt", reference: "retry_complete" },
        result: { status: "approved", delivery_id: packet.delivery_id, task_id: packet.task_id, criteria_digest: (packet.criteria as JsonObject).criteria_digest, candidate_sha: candidate } };
    },
    async inspect() { inspections += 1; throw new Error("completed retry must not inspect"); },
    async collect() { collections += 1; throw new Error("completed retry must not collect"); },
  });
  const store = new FileStateStore(mkdtempSync(join(tmpdir(), "delivery-review-retry-")));
  const engine = new DeliveryEngine({ store, checker: { async verify() { return { status: "success", candidate_sha: candidate }; } }, reviewer,
    controlGrant: { token: "grant", repositories: ["owner/repo"], actions: ["retry_review"] } });
  let state = implementationCandidate(engine, "review-retry", candidate);
  state = await engine.verifyCandidate(state.repo, state.delivery_id, state.revision); const predecessor = state.executions.at(-1)!;
  const input = { repo: state.repo, deliveryId: state.delivery_id, expectedRevision: state.revision, action: "retry_review" as const, requestId: "retry_review_001", grant: "grant" };
  const authorized = await engine.control(input); state = store.read(state.repo, state.delivery_id);
  assert.equal(authorized.status, "implementation_review"); assert.equal(state.executions.filter((item) => item.kind === "reviewer").length, 2); assert.deepEqual([dispatches, inspections, collections], [1, 0, 0]);
  const retry = state.executions.at(-1)!; assert.equal(retry.status, "dispatching"); assert.equal(retry.review_attempt, 1); assert.equal(retry.predecessor_task_id, predecessor.id);
  assert.notEqual(retry.id, predecessor.id); assert.equal(retry.packet_digest, digest(retry.packet)); assert.equal(state.controls.requests[input.requestId]?.status, "completed");
  const replay = await engine.control(input); assert.equal(replay.revision, state.revision); assert.deepEqual([dispatches, inspections, collections], [1, 0, 0]);
  const readback = await engine.reconcileControlRequest({ ...input, repositoryInputDigest: digest({ repo: input.repo, delivery_id: input.deliveryId, expected_revision: input.expectedRevision, request_id: input.requestId, action: input.action, digest: null }), mode: "readback" });
  assert.equal(readback.status, "completed"); assert.deepEqual([dispatches, inspections, collections], [1, 0, 0]);
  state = await engine.verifyCandidate(state.repo, state.delivery_id, state.revision);
  assert.equal(dispatches, 2); assert.equal(lastPacket.task_id, retry.id); assert.equal(state.receipts.engineering?.candidate_sha, candidate);
});

test("real Pi receipt revalidates the complete returned and thrown preflight lifecycle for retry", async () => {
  for (const thrown of [false, true]) {
    const root = mkdtempSync(join(tmpdir(), `delivery-real-pi-preflight-${thrown}-`)), executable = join(root, "pi-version-refusal");
    writeFileSync(executable, "#!/bin/sh\necho 'version unavailable' >&2\nexit 2\n", { mode: 0o700 }); chmodSync(executable, 0o700);
    const pi = new PiRpcExecutorAdapter({ executable, cwd: process.cwd(), stateDir: join(root, "receipts"), sessionOwnersDir: join(root, "owners"),
      sessionDir: join(root, "sessions"), role: "reviewer" });
    const reviewer: ExecutorPort = thrown ? {
      async dispatch(packet) { const outcome = await pi.dispatch(packet) as unknown as AdapterOutcome; throw new AdapterRefusal(String(outcome.error), "PI_PREFLIGHT_REFUSED", outcome); },
      async inspect(id) { return pi.inspect(id); }, async collect(id) { return pi.collect(id); }, async cancel(id) { return pi.cancel(id); },
      async resolveOutcomeProof(outcome, context) { return pi.resolveOutcomeProof(outcome, context); },
    } : pi;
    const store = new FileStateStore(join(root, "engine"));
    const engine = new DeliveryEngine({ store, checker: { async verify(packet) { return { status: "success", candidate_sha: String(packet.candidate_sha) }; } }, reviewer,
      controlGrant: { token: "grant", repositories: ["owner/repo"], actions: ["retry_review"] } });
    let state = implementationCandidate(engine, `real-pi-preflight-${thrown}`); state = await engine.verifyCandidate(state.repo, state.delivery_id, state.revision);
    const failed = state.executions.at(-1)!;
    assert.equal(failed.proof?.kind, "preflight_refusal"); assert.match(failed.outcome_error ?? "", /Command failed|version unavailable/);
    const before = state.executions.length;
    state = store.read(state.repo, state.delivery_id);
    await engine.control({ repo: state.repo, deliveryId: state.delivery_id, expectedRevision: state.revision, action: "retry_review", requestId: `real_pi_retry_${thrown}`, grant: "grant" });
    const authorized = store.read(state.repo, state.delivery_id);
    assert.equal(authorized.executions.length, before + 1); assert.equal(authorized.executions.at(-1)?.status, "dispatching");
    assert.equal(authorized.executions.at(-1)?.predecessor_task_id, failed.id);
  }
});
