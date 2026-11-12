import assert from "node:assert/strict";
import { mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DeliveryEngine, enginePreEffectTransientReadOutcome, repositoryCommandInputDigest } from "../src/engine.ts";
import { FileStateStore } from "../src/store.ts";
import type { DeliveryState, JsonObject } from "../src/types.ts";
import { policy } from "./helpers.ts";
import { DeliveryError, digest } from "../src/core.ts";
import { Publisher, publicationAuthorizationDigest } from "../src/publisher.ts";
import { PublisherReadOnlyRefusal, PublisherRefusal } from "../src/ports.ts";
import { GitHubUnavailable } from "../src/github.ts";

const baselineSha = "4".repeat(40);
const planSha = "3".repeat(40);
const candidateSha = "5".repeat(40);

function plan(id: string) {
  return { schema_version: 1, kind: "plan", delivery_id: id, repo: "owner/repo", result: { issue: 1, plan_revision: planSha, baseline: { repo: "owner/repo", ref: "main", sha: baselineSha }, artifact_paths: ["plan.md"], artifact_hashes: { "plan.md": "a".repeat(64) } } };
}

function handoff() {
  return { expected: { head: "delivery/one", base: "main", head_sha: planSha, base_sha: baselineSha, previous_sha: null }, payload: { title: "Plan", body: "Body", bundle: "/tmp/candidate.bundle", allowed_paths: ["plan.md"] } };
}

function implementationHandoff() {
  return { expected: { head: "delivery/implementation", base: "main", head_sha: candidateSha, base_sha: baselineSha, previous_sha: null }, payload: { title: "Implementation", body: "Body", bundle: "/tmp/implementation.bundle", allowed_paths: ["src/change.ts"] } };
}

function rankSnapshot(): JsonObject {
  return { issues: [{ number: 1, state: "open", pull_request: false, labels: [] }], open_prs: [], dependencies: [{ issue: 1, blocked_by: [], unresolved: [] }], coverage: { issues_complete: true, open_prs_complete: true, unresolved_count: 0 } };
}

function readinessState(store: FileStateStore, engine: DeliveryEngine, id: string, status: "publication_pending" | "pre_ready_ci_waiting" | "manual_ready_pending" | "tracking_pending" = "pre_ready_ci_waiting"): DeliveryState {
  let state = engine.start({ repo: "owner/repo", issue: 1, deliveryId: id, policy: policy(), safeguards: { publication: { pr: "automatic" }, allowedPaths: { implementation: ["src/change.ts"] } } });
  const manifest = { schema_version: 1 as const, kind: "implement" as const, delivery_id: id, repo: "owner/repo",
    result: { issue: 1, candidate_sha: candidateSha, base: { repo: "owner/repo", ref: "main", sha: baselineSha }, artifact_paths: ["src/change.ts"], verification: { tests: ["focused"] } } };
  state = store.mutate(state.repo, state.delivery_id, state.revision, (next) => {
    const expected = { head: "delivery/implementation", head_sha: candidateSha, base: "main", base_sha: baselineSha, previous_sha: null };
    const payload = { title: "Implementation", body: "Exact body", bundle: "/tmp/implementation.bundle", allowed_paths: ["src/change.ts"] };
    const checks = { status: "success", candidate_sha: candidateSha, manifest_digest: digest(manifest) };
    next.status = status; next.manifests.implement = { digest: digest(manifest), material_digest: "b".repeat(64), generation: 1, value: manifest, accepted_at: new Date().toISOString() };
    next.handoffs.implementation = { digest: digest({ expected, payload, generation: 1 }), generation: 1, expected, payload, staged_at: new Date().toISOString() };
    next.publication.implementation = { status: "published", pr: { number: 21, head_sha: candidateSha, base_sha: baselineSha } };
    next.publication.final = { status }; next.receipts.checks = checks; next.receipts.engineering = { candidate_sha: candidateSha, producer_execution_id: "producer-task",
      producer_identity: "fixture:producer", checker: checks, review: { status: "approved", candidate_sha: candidateSha, reviewer_identity: "fixture:reviewer" } };
    return next;
  });
  return state;
}

class ControlCompletionLossStore extends FileStateStore {
  private requestId?: string;
  arm(requestId: string): void { this.requestId = requestId; }
  override mutate(repo: string, deliveryId: string, expectedRevision: number | undefined, transform: (state: DeliveryState) => DeliveryState): DeliveryState {
    const current = this.read(repo, deliveryId);
    if (this.requestId && current.controls.requests[this.requestId]?.status === "intent" && current.operations.some((operation) => operation.status === "completed")) {
      this.requestId = undefined;
      throw new Error("simulated command owner loss after external effect reconciliation");
    }
    return super.mutate(repo, deliveryId, expectedRevision, transform);
  }
}

class ConcurrentControlCompletionStore extends FileStateStore {
  armed = false;
  override mutate(repo: string, deliveryId: string, expectedRevision: number | undefined, transform: (state: DeliveryState) => DeliveryState): DeliveryState {
    const current = this.read(repo, deliveryId);
    if (this.armed && current.operations.some((operation) => operation.status === "completed") && Object.values(current.controls.requests).some((request) => request.status === "intent")) {
      this.armed = false;
      super.mutate(repo, deliveryId, current.revision, (next) => { next.history.push({ event: "concurrent_completion_revision" }); return next; });
    }
    return super.mutate(repo, deliveryId, expectedRevision, transform);
  }
}

class CorrectBeforeControlCompletionStore extends FileStateStore {
  armed = false;
  override mutate(repo: string, deliveryId: string, expectedRevision: number | undefined, transform: (state: DeliveryState) => DeliveryState): DeliveryState {
    const current = this.read(repo, deliveryId);
    if (this.armed && current.operations.some((operation) => operation.status === "completed") && Object.values(current.controls.requests).some((request) => request.status === "intent")) {
      this.armed = false;
      super.mutate(repo, deliveryId, current.revision, (next) => {
        next.status = "plan_required"; delete next.handoffs.plan; delete next.publication.plan; delete next.receipts.plan;
        next.controls.requests.concurrent_correct_001 = { action: "correct", request_digest: "a".repeat(64), status: "completed", at: new Date().toISOString(), completed_at: new Date().toISOString() };
        return next;
      });
    }
    return super.mutate(repo, deliveryId, expectedRevision, transform);
  }
}

test("protected publication mode and path policy cannot be supplied by the task", async () => {
  const store = new FileStateStore(mkdtempSync(join(tmpdir(), "engine-policy-")));
  const calls: Record<string, unknown>[] = [];
  const publisher = { async execute(packet: Record<string, unknown>) { calls.push(packet); const expected = packet.expected as JsonObject; return { schema_version: 1, action: packet.action, delivery_id: packet.delivery_id, operation_id: packet.operation_id, status: "published", pr: { number: 1, head_sha: expected.head_sha, base_sha: expected.base_sha } }; } };
  const engine = new DeliveryEngine({ store, publisher, controlGrant: { token: "grant", repositories: ["owner/repo"], actions: ["publish_plan"] } });
  let state = engine.start({ repo: "owner/repo", issue: 1, deliveryId: "policy-one", policy: policy(), safeguards: { publication: { pr: "explicit" }, allowedPaths: { plan: ["plan.md"] } } });
  state = engine.acceptManifest(state.repo, state.delivery_id, plan(state.delivery_id), state.revision);
  await assert.rejects(async () => engine.publishStage(state.repo, state.delivery_id, "plan", state.revision), /automatic pull request publication is disabled/);
  assert.throws(() => engine.stageHandoff(state.repo, state.delivery_id, "plan", { ...handoff(), payload: { ...handoff().payload, allowed_paths: ["src/owned-by-agent.ts"] } }, state.revision), /differs from protected policy/);
  state = engine.stageHandoff(state.repo, state.delivery_id, "plan", handoff(), state.revision);
  const request = { repo: state.repo, deliveryId: state.delivery_id, expectedRevision: state.revision, action: "publish_plan" as const, requestId: "publish_request_1", grant: "grant", draftDigest: state.handoffs.plan!.digest };
  const first = await engine.control(request);
  assert.equal(first.status, "implementation_required");
  assert.equal(calls.length, 1);
  const duplicate = await engine.control(request);
  assert.equal(duplicate.revision, first.revision);
  await assert.rejects(async () => engine.control({ ...request, draftDigest: "different" }), /already used for different control input/);
  const persisted = store.read(state.repo, state.delivery_id);
  assert.equal(persisted.controls.requests[request.requestId]?.status, "completed");
  assert.match(String(persisted.controls.requests[request.requestId]?.request_digest), /^[0-9a-f]{64}$/);
});

test("pre-effect validation is terminal while untyped publisher refusal remains conservative", async () => {
  const prepare = (store: FileStateStore, engine: DeliveryEngine, id: string) => { let state = engine.start({ repo: "owner/repo", issue: 1, deliveryId: id, policy: policy(), safeguards: { publication: { pr: "explicit" }, allowedPaths: { plan: ["plan.md"] } } }); state = engine.acceptManifest(state.repo, state.delivery_id, plan(state.delivery_id), state.revision); return engine.stageHandoff(state.repo, state.delivery_id, "plan", handoff(), state.revision); };
  const store = new FileStateStore(mkdtempSync(join(tmpdir(), "engine-terminal-publication-"))); let calls = 0;
  const publisher = { async execute(packet: Record<string, unknown>) { calls += 1; const expected = packet.expected as JsonObject; return { schema_version: 1, action: packet.action, delivery_id: packet.delivery_id, operation_id: packet.operation_id, status: "published", pr: { number: 1, head_sha: expected.head_sha, base_sha: expected.base_sha } }; } };
  const engine = new DeliveryEngine({ store, publisher, controlGrant: { token: "grant", repositories: ["owner/repo"], actions: ["publish_plan", "cancel"] } }); let state = prepare(store, engine, "terminal-pre-effect");
  const wrong = await engine.control({ repo: state.repo, deliveryId: state.delivery_id, expectedRevision: state.revision, action: "publish_plan", requestId: "wrong_digest_001", grant: "grant", draftDigest: "0".repeat(64) }); assert.equal(wrong.status, "plan_review");
  state = store.read(state.repo, state.delivery_id); assert.equal(state.controls.requests.wrong_digest_001?.status, "failed"); assert.equal(state.operations.length, 0); assert.deepEqual(state.unresolved_effects, []); assert.equal(calls, 0);
  const valid = await engine.control({ repo: state.repo, deliveryId: state.delivery_id, expectedRevision: state.revision, action: "publish_plan", requestId: "valid_digest_001", grant: "grant", draftDigest: state.handoffs.plan!.digest }); assert.equal(valid.status, "implementation_required"); assert.equal(calls, 1);

  const refusedStore = new FileStateStore(mkdtempSync(join(tmpdir(), "engine-refused-publication-"))), refusedEngine = new DeliveryEngine({ store: refusedStore, publisher: { async execute() { throw new DeliveryError("GitHub refused the request (422)", "GITHUB_REFUSED"); } }, controlGrant: { token: "grant", repositories: ["owner/repo"], actions: ["publish_plan", "cancel"] } }); let refused = prepare(refusedStore, refusedEngine, "terminal-refused");
  const denied = await refusedEngine.control({ repo: refused.repo, deliveryId: refused.delivery_id, expectedRevision: refused.revision, action: "publish_plan", requestId: "refused_publish_001", grant: "grant", draftDigest: refused.handoffs.plan!.digest }); assert.equal(denied.status, "blocked");
  refused = refusedStore.read(refused.repo, refused.delivery_id); assert.equal(refused.operations.at(-1)?.status, "uncertain"); assert.equal(refused.controls.requests.refused_publish_001?.status, "uncertain"); assert.equal(refused.unresolved_effects.length > 0, true);
});

test("PR publication keeps generic and unissued phase failures uncertain", async () => {
  const prepare = (store: FileStateStore, engine: DeliveryEngine, id: string) => { let state = engine.start({ repo: "owner/repo", issue: 1, deliveryId: id, policy: policy(), safeguards: { publication: { pr: "automatic" }, allowedPaths: { plan: ["plan.md"] } } }); state = engine.acceptManifest(state.repo, state.delivery_id, plan(state.delivery_id), state.revision); return engine.stageHandoff(state.repo, state.delivery_id, "plan", handoff(), state.revision); };
  for (const [id, publisher] of [
    ["generic-post-effect", { async execute() { throw new DeliveryError("readback failed"); } }],
    ["unissued-phase-proof", { async execute(packet: Record<string, unknown>) { throw new PublisherRefusal("unissued", "AUTH_MISMATCH", { phase: "pre_effect", operation_id: String(packet.operation_id), request_digest: publicationAuthorizationDigest(packet), pushed_ref_receipts: [], proof: "f".repeat(64) }); } }],
  ] as const) {
    const store = new FileStateStore(mkdtempSync(join(tmpdir(), `engine-${id}-`))), engine = new DeliveryEngine({ store, publisher });
    let state = prepare(store, engine, id); state = await engine.publishStage(state.repo, state.delivery_id, "plan", state.revision, state.handoffs.plan!.digest);
    assert.equal(state.status, "blocked"); assert.equal(state.operations.at(-1)?.status, "uncertain"); assert.deepEqual(state.unresolved_effects, [state.operations.at(-1)!.id]);
  }
});

test("same publish request reconciles a completed effect after command owner loss without replay", async () => {
  const store = new ControlCompletionLossStore(mkdtempSync(join(tmpdir(), "engine-control-reconcile-"))); let calls = 0;
  const publisher = { async execute(packet: Record<string, unknown>) { calls += 1; const expected = packet.expected as JsonObject; return { schema_version: 1, action: packet.action, delivery_id: packet.delivery_id, operation_id: packet.operation_id, status: "published", pr: { number: 11, head_sha: expected.head_sha, base_sha: expected.base_sha } }; } };
  const engine = new DeliveryEngine({ store, publisher, controlGrant: { token: "grant", repositories: ["owner/repo"], actions: ["publish_plan"] } });
  let state = engine.start({ repo: "owner/repo", issue: 1, deliveryId: "control-reconcile", policy: policy(), safeguards: { publication: { pr: "explicit" }, allowedPaths: { plan: ["plan.md"] } } });
  state = engine.acceptManifest(state.repo, state.delivery_id, plan(state.delivery_id), state.revision); state = engine.stageHandoff(state.repo, state.delivery_id, "plan", handoff(), state.revision);
  const input = { repo: state.repo, deliveryId: state.delivery_id, expectedRevision: state.revision, action: "publish_plan" as const, requestId: "lost_publish_001", grant: "grant", draftDigest: state.handoffs.plan!.digest };
  store.arm(input.requestId); const stranded = await engine.control(input); assert.equal(stranded.status, "implementation_required");
  state = store.read(state.repo, state.delivery_id); assert.equal(state.controls.requests[input.requestId]?.status, "completed"); assert.equal(state.operations.at(-1)?.status, "completed"); assert.equal(calls, 1);
  await assert.rejects(() => engine.reconcileControlRequest({ ...input, grant: "wrong", repositoryInputDigest: digest("repository-command") }), (error: unknown) => (error as { code?: string }).code === "UNAUTHORIZED");
  await assert.rejects(() => engine.reconcileControlRequest({ ...input, draftDigest: "0".repeat(64), repositoryInputDigest: digest("repository-command") }), (error: unknown) => (error as { code?: string }).code === "REQUEST_CONFLICT");
  const reconciled = await engine.reconcileControlRequest({ ...input, repositoryInputDigest: repositoryCommandInputDigest(input) });
  assert.equal(reconciled.status, "completed"); assert.equal(calls, 1); assert.equal(store.read(state.repo, state.delivery_id).controls.requests[input.requestId]?.status, "completed");
});

test("ordinary replay reconciles a publisher-completed PR result lost before engine persistence", async () => {
  const store = new FileStateStore(mkdtempSync(join(tmpdir(), "engine-publisher-result-loss-"))); let executes = 0, inspections = 0;
  class ResultLossPublisher extends Publisher {
    constructor() { super({ repo: "owner/repo", repositoryId: 1, actorId: 1, login: "fixture", stateRoot: mkdtempSync(join(tmpdir(), "engine-publisher-port-")), remoteUrl: "https://github.com/owner/repo.git" }); }
    override async execute(packet: Record<string, unknown>): Promise<Record<string, unknown>> {
      executes += 1;
      throw new Error(`simulated lost publisher result for ${String(packet.operation_id)}`);
    }
    override async inspectPublication(request: JsonObject) {
      inspections += 1;
      const expected = request.expected as JsonObject;
      return { status: "completed" as const, operation_id: String(request.operation_id), request_digest: publicationAuthorizationDigest(request),
        receipt: { schema_version: 1, action: String(request.action), delivery_id: String(request.delivery_id), operation_id: String(request.operation_id), status: "published", pr: { number: 17, head_sha: expected.head_sha!, base_sha: expected.base_sha! } } };
    }
  }
  const publisher = new ResultLossPublisher();
  const engine = new DeliveryEngine({ store, publisher, controlGrant: { token: "grant", repositories: ["owner/repo"], actions: ["publish_plan"] } });
  let state = engine.start({ repo: "owner/repo", issue: 1, deliveryId: "publisher-result-loss", policy: policy(), safeguards: { publication: { pr: "explicit" }, allowedPaths: { plan: ["plan.md"] } } });
  state = engine.acceptManifest(state.repo, state.delivery_id, plan(state.delivery_id), state.revision); state = engine.stageHandoff(state.repo, state.delivery_id, "plan", handoff(), state.revision);
  const input = { repo: state.repo, deliveryId: state.delivery_id, expectedRevision: state.revision, action: "publish_plan" as const, requestId: "publisher_result_loss_001", grant: "grant", draftDigest: state.handoffs.plan!.digest };
  const uncertain = await engine.control(input); assert.equal(uncertain.status, "blocked"); assert.equal(executes, 1); assert.equal(inspections, 0);
  const recovered = await engine.control(input); assert.equal(recovered.status, "implementation_required"); assert.equal(executes, 1); assert.equal(inspections, 1);
  const final = store.read(state.repo, state.delivery_id); assert.equal(final.operations.at(-1)?.status, "completed"); assert.equal(final.controls.requests[input.requestId]?.status, "completed");
});

test("manual controls persist exact requests, reconcile local results, and permit corrected binding retry", async () => {
  let exportExecutes = 0, bindExecutes = 0, inspections = 0;
  class ManualRecoveryPublisher extends Publisher {
    constructor() { super({ repo: "owner/repo", repositoryId: 1, actorId: 1, login: "fixture", stateRoot: mkdtempSync(join(tmpdir(), "engine-manual-port-")), remoteUrl: "https://github.com/owner/repo.git" }); }
    override async execute(packet: Record<string, unknown>): Promise<Record<string, unknown>> {
      if (packet.action === "export_handoff") { exportExecutes += 1; throw new Error("simulated export result loss after durable save"); }
      bindExecutes += 1; const number = Number((packet.payload as JsonObject).number);
      if (number === 11) throw new Error("simulated read-only binding transport failure");
      return { schema_version: 1, action: String(packet.action), delivery_id: String(packet.delivery_id), operation_id: String(packet.operation_id), status: "bound",
        pr: { number, head_sha: planSha, base_sha: baselineSha } };
    }
    override async inspectPublication(request: JsonObject) {
      inspections += 1;
      if (request.action === "export_handoff") return { status: "completed" as const, operation_id: String(request.operation_id), request_digest: publicationAuthorizationDigest(request),
        receipt: { schema_version: 1, action: "export_handoff", delivery_id: String(request.delivery_id), operation_id: String(request.operation_id), status: "manual_handoff", handoff: { request_digest: publicationAuthorizationDigest(request) } } };
      return { status: "failed" as const, operation_id: String(request.operation_id), request_digest: publicationAuthorizationDigest(request), error: "read-only binding could not validate PR 11", error_code: "DELIVERY_BLOCKED" };
    }
  }
  const store = new FileStateStore(mkdtempSync(join(tmpdir(), "engine-manual-recovery-"))), publisher = new ManualRecoveryPublisher();
  const engine = new DeliveryEngine({ store, publisher, controlGrant: { token: "grant", repositories: ["owner/repo"], actions: ["export_handoff", "bind_manual_pr"] } });
  let state = engine.start({ repo: "owner/repo", issue: 1, deliveryId: "manual-control-recovery", policy: policy(), safeguards: { publication: { pr: "off" }, allowedPaths: { plan: ["plan.md"] } } });
  state = engine.acceptManifest(state.repo, state.delivery_id, plan(state.delivery_id), state.revision); state = engine.stageHandoff(state.repo, state.delivery_id, "plan", handoff(), state.revision);
  const exportInput = { repo: state.repo, deliveryId: state.delivery_id, expectedRevision: state.revision, action: "export_handoff" as const, stage: "plan" as const, requestId: "manual_export_loss_001", grant: "grant" };
  assert.equal((await engine.control(exportInput)).status, "blocked"); assert.equal(exportExecutes, 1);
  assert.equal((await engine.control(exportInput)).status, "plan_review"); assert.equal(exportExecutes, 1); assert.equal(inspections, 1);
  state = store.read(state.repo, state.delivery_id); assert.equal(state.controls.requests[exportInput.requestId]?.status, "completed"); assert.equal(state.operations.at(-1)?.status, "completed"); assert.ok(state.publication.plan_manual_handoff);

  const badBind = { repo: state.repo, deliveryId: state.delivery_id, expectedRevision: state.revision, action: "bind_manual_pr" as const, stage: "plan" as const, number: 11, requestId: "manual_bind_failure_001", grant: "grant" };
  assert.equal((await engine.control(badBind)).status, "blocked"); assert.equal(bindExecutes, 1);
  assert.equal((await engine.control(badBind)).status, "plan_review"); assert.equal(bindExecutes, 1); assert.equal(inspections, 2);
  state = store.read(state.repo, state.delivery_id); assert.equal(state.controls.requests[badBind.requestId]?.status, "failed"); assert.equal(state.operations.at(-1)?.status, "failed"); assert.deepEqual(state.unresolved_effects, []);
  await assert.rejects(() => engine.control({ ...badBind, number: 12 }), (error: unknown) => (error as { code?: string }).code === "REQUEST_CONFLICT");

  const corrected = { ...badBind, expectedRevision: state.revision, number: 12, requestId: "manual_bind_corrected_001" };
  assert.equal((await engine.control(corrected)).status, "implementation_required"); assert.equal(bindExecutes, 2);
  state = store.read(state.repo, state.delivery_id); assert.equal(state.controls.requests[corrected.requestId]?.status, "completed"); assert.equal(state.operations.at(-1)?.status, "completed");
});

test("stopping drain only collects an accepted primary execution and never starts adjacent effects", async () => {
  let dispatches = 0, inspections = 0, collects = 0, checks = 0, publications = 0;
  const executionId = "primary-external-1", proof = { kind: "run_receipt" as const, reference: "primary_receipt_1" };
  const executor = {
    async dispatch() { dispatches += 1; return {}; },
    async inspect() { inspections += 1; return { status: "completed" as const, effect: "accepted" as const, terminal: "completed" as const, execution_id: executionId, provider: "fixture", proof, result: { manifest: plan("drain-primary") } }; },
    async collect() { collects += 1; return { status: "completed" as const, effect: "accepted" as const, terminal: "completed" as const, execution_id: executionId, provider: "fixture", proof, result: { manifest: plan("drain-primary") } }; },
    async cancel() { return {}; }, async resolveOutcomeProof() { return { trusted: true, proof_digest: "e".repeat(64) }; },
  };
  const store = new FileStateStore(mkdtempSync(join(tmpdir(), "engine-drain-primary-"))), engine = new DeliveryEngine({ store, executor,
    checker: { async verify() { checks += 1; return {}; } }, publisher: { async execute() { publications += 1; return {}; } } });
  let state = engine.start({ repo: "owner/repo", issue: 1, deliveryId: "drain-primary", policy: policy() });
  const packet = { task_id: "primary-task-1" };
  state = store.mutate(state.repo, state.delivery_id, state.revision, (next) => { next.executions.push({ id: "primary-task-1", kind: "agent", stage: "plan", status: "running", external_id: executionId,
    packet, packet_digest: digest(packet), provider: "fixture", started_at: new Date().toISOString() }); next.runner = { status: "running", owner_pid: 123, execution_id: "primary-task-1" }; return next; });
  const drained = await engine.drainAcceptedExecution(state.repo, state.delivery_id, state.revision);
  assert.equal(drained.status, "plan_review"); assert.equal(drained.runner.status, "idle"); assert.deepEqual({ dispatches, inspections, collects, checks, publications }, { dispatches: 0, inspections: 1, collects: 1, checks: 0, publications: 0 });
});

test("stopping drain collects only the exact accepted reviewer and never rechecks or republishes", async () => {
  let dispatches = 0, inspections = 0, collects = 0, checks = 0, publications = 0;
  const store = new FileStateStore(mkdtempSync(join(tmpdir(), "engine-drain-reviewer-"))), manifestDigest = "a".repeat(64), producerExecutionId = "producer-task-1", producerIdentity = "fixture:producer-external-1";
  const executionId = "reviewer-external-1", taskId = "reviewer-task-1", proof = { kind: "run_receipt" as const, reference: "reviewer_receipt_1" };
  let criteriaDigest = "";
  const reviewer = {
    async dispatch() { dispatches += 1; return {}; },
    async inspect() { inspections += 1; return { status: "completed" as const, effect: "accepted" as const, terminal: "completed" as const, execution_id: executionId, provider: "fixture", proof }; },
    async collect() { collects += 1; return { status: "completed" as const, effect: "accepted" as const, terminal: "completed" as const, execution_id: executionId, provider: "fixture", proof,
      result: { status: "approved", delivery_id: "drain-reviewer", task_id: taskId, criteria_digest: criteriaDigest, candidate_sha: candidateSha } }; },
    async cancel() { return {}; }, async resolveOutcomeProof() { return { trusted: true, proof_digest: "f".repeat(64) }; },
  };
  const engine = new DeliveryEngine({ store, reviewer, checker: { async verify() { checks += 1; return {}; } }, publisher: { async execute() { publications += 1; return {}; } } });
  let state = engine.start({ repo: "owner/repo", issue: 1, deliveryId: "drain-reviewer", policy: policy() });
  const implement = { schema_version: 1 as const, kind: "implement" as const, delivery_id: state.delivery_id, repo: state.repo,
    result: { issue: 1, candidate_sha: candidateSha, base: { repo: state.repo, ref: "main", sha: baselineSha }, artifact_paths: ["src/change.ts"], verification: { tests: ["focused"] } } };
  criteriaDigest = digest({ delivery_id: state.delivery_id, issue: state.issue, candidate_sha: candidateSha, manifest_digest: manifestDigest, plan_digest: null, producer_execution_id: producerExecutionId, producer_identity: producerIdentity });
  const packet: JsonObject = { schema_version: 1, kind: "review", repo: state.repo, delivery_id: state.delivery_id, manifest_generation: 1, candidate_sha: candidateSha,
    criteria: { issue: 1, manifest_digest: manifestDigest, criteria_digest: criteriaDigest }, producer_execution_id: producerExecutionId, producer_identity: producerIdentity, task_id: taskId };
  state = store.mutate(state.repo, state.delivery_id, state.revision, (next) => {
    next.status = "implementation_review"; next.manifests.implement = { digest: manifestDigest, material_digest: "b".repeat(64), generation: 1, value: implement,
      accepted_at: new Date().toISOString(), producer_execution_id: producerExecutionId, producer_identity: producerIdentity };
    next.receipts.checks = { status: "success", candidate_sha: candidateSha, manifest_digest: manifestDigest };
    next.executions.push({ id: taskId, kind: "reviewer", stage: "engineering_review", status: "running", external_id: executionId, provider: "fixture", packet, packet_digest: digest(packet), started_at: new Date().toISOString() }); return next;
  });
  const drained = await engine.drainAcceptedExecution(state.repo, state.delivery_id, state.revision);
  assert.equal(drained.receipts.engineering?.candidate_sha, candidateSha); assert.deepEqual({ dispatches, inspections, collects, checks, publications }, { dispatches: 0, inspections: 1, collects: 1, checks: 0, publications: 0 });
});

test("fresh concrete rank snapshot 503 is the only authentic pre-effect dispatch backoff", async () => {
  let reads = 0, dispatches = 0;
  const server = createServer((_request, response) => { reads += 1; response.statusCode = 503; response.setHeader("retry-after", "7"); response.end("{}"); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); assert(address && typeof address !== "string");
  try {
    const store = new FileStateStore(mkdtempSync(join(tmpdir(), "engine-pre-effect-read-")));
    const publisher = new Publisher({ repo: "owner/repo", repositoryId: 1, actorId: 1, login: "fixture", stateRoot: mkdtempSync(join(tmpdir(), "engine-pre-effect-publisher-")),
      remoteUrl: "https://github.com/owner/repo.git", tokenResolver: async () => "fixture-token", transportBaseUrl: `http://127.0.0.1:${address.port}`, testOnly: true });
    const executor = { async dispatch() { dispatches += 1; return {}; }, async inspect() { return {}; }, async collect() { return {}; }, async cancel() { return {}; } };
    const engine = new DeliveryEngine({ store, publisher, executor }); const before = engine.start({ repo: "owner/repo", issue: 1, deliveryId: "pre-effect-read", policy: policy() });
    let caught: unknown; try { await engine.dispatch(before.repo, before.delivery_id, before.revision); } catch (error) { caught = error; }
    const outcome = enginePreEffectTransientReadOutcome(caught); assert.deepEqual(outcome, { kind: "engine_pre_effect_transient_read", transition: "dispatch", stage: "plan",
      repo: before.repo, delivery_id: before.delivery_id, expected_revision: before.revision, retry_after_ms: 7000, error_code: "GITHUB_UNAVAILABLE", message: "GitHub is temporarily unavailable" });
    const after = store.read(before.repo, before.delivery_id); assert.equal(after.revision, before.revision); assert.equal(after.runner.status, "idle"); assert.equal(after.executions.length, 0);
    assert.equal(after.budget.attempts_used, 0); assert.equal(dispatches, 0); assert.equal(reads, 1);
    assert.equal(enginePreEffectTransientReadOutcome({ ...(outcome as object) }), undefined);
    assert.equal(enginePreEffectTransientReadOutcome(Object.assign(new GitHubUnavailable(), outcome)), undefined);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("generic snapshot and post-intent transient errors cannot forge engine pre-effect proof", async () => {
  let dispatches = 0;
  const genericStore = new FileStateStore(mkdtempSync(join(tmpdir(), "engine-forged-read-")));
  const genericEngine = new DeliveryEngine({ store: genericStore, publisher: { async execute() { throw new GitHubUnavailable("forged publisher transient", 9); } },
    executor: { async dispatch() { dispatches += 1; return {}; }, async inspect() { return {}; }, async collect() { return {}; }, async cancel() { return {}; } } });
  const generic = genericEngine.start({ repo: "owner/repo", issue: 1, deliveryId: "forged-read", policy: policy() });
  await assert.rejects(() => genericEngine.dispatch(generic.repo, generic.delivery_id, generic.revision), (error: unknown) => {
    assert.equal(enginePreEffectTransientReadOutcome(error), undefined); return error instanceof GitHubUnavailable;
  });
  assert.equal(genericStore.read(generic.repo, generic.delivery_id).revision, generic.revision); assert.equal(dispatches, 0);

  const postStore = new FileStateStore(mkdtempSync(join(tmpdir(), "engine-post-intent-read-")));
  const snapshot = { schema_version: 1, action: "rank_snapshot", delivery_id: "post-intent-read", status: "snapshot", issues: [{ number: 1, state: "open", labels: [] }], open_prs: [],
    dependencies: [{ issue: 1, blocked_by: [], unresolved: [] }], coverage: { issues_complete: true, open_prs_complete: true, unresolved_count: 0 } };
  const postEngine = new DeliveryEngine({ store: postStore, publisher: { async execute(packet) { return { ...snapshot, operation_id: packet.operation_id }; } }, executor: {
    async dispatch() { dispatches += 1; throw new GitHubUnavailable("post-intent executor transient", 11); }, async inspect() { return {}; }, async collect() { return {}; }, async cancel() { return {}; },
  } });
  const post = postEngine.start({ repo: "owner/repo", issue: 1, deliveryId: "post-intent-read", policy: policy() });
  const held = await postEngine.dispatch(post.repo, post.delivery_id, post.revision); assert.equal(held.status, "blocked"); assert.equal(held.runner.status, "failed");
  assert.equal(held.executions.at(-1)?.status, "uncertain"); assert.equal(held.unresolved_effects.includes(held.executions.at(-1)!.id), true); assert.equal(dispatches, 1);
});

test("concrete readiness 503 and 429 yield authenticated retry deadlines without publication intent or writes", async () => {
  for (const statusCode of [503, 429]) {
    let reads = 0, writes = 0;
    const server = createServer((request, response) => { if (request.method !== "GET") writes += 1; reads += 1; response.statusCode = statusCode; response.setHeader("retry-after", "600"); response.end("{}"); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); assert(address && typeof address !== "string");
    try {
      const store = new FileStateStore(mkdtempSync(join(tmpdir(), `engine-readiness-${statusCode}-`)));
      const publisher = new Publisher({ repo: "owner/repo", repositoryId: 42, actorId: 7, login: "fixture", stateRoot: mkdtempSync(join(tmpdir(), `engine-readiness-publisher-${statusCode}-`)),
        remoteUrl: "https://github.com/owner/repo.git", tokenResolver: async () => "fixture-token", transportBaseUrl: `http://127.0.0.1:${address.port}`, testOnly: true });
      const engine = new DeliveryEngine({ store, publisher }), before = readinessState(store, engine, `readiness-${statusCode}`);
      let caught: unknown; try { await engine.recheckReady(before.repo, before.delivery_id, before.revision, `readiness_${statusCode}`); } catch (error) { caught = error; }
      const outcome = enginePreEffectTransientReadOutcome(caught); assert(outcome && outcome.transition === "recheck_ready");
      assert.deepEqual({ stage: outcome.stage, status: outcome.workflow_status, repo: outcome.repo, delivery: outcome.delivery_id, revision: outcome.expected_revision,
        retry: outcome.retry_after_ms, checkpoint: outcome.checkpoint, candidate: outcome.candidate_sha },
      { stage: "readiness", status: "pre_ready_ci_waiting", repo: before.repo, delivery: before.delivery_id, revision: before.revision, retry: 600_000, checkpoint: "ci_observed", candidate: candidateSha });
      const after = store.read(before.repo, before.delivery_id); assert.equal(after.revision, before.revision); assert.equal(after.status, "pre_ready_ci_waiting");
      assert.equal(after.operations.length, 0); assert.deepEqual(after.unresolved_effects, []); assert.equal(reads, 1); assert.equal(writes, 0);
      assert.equal(enginePreEffectTransientReadOutcome({ ...outcome }), undefined);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  }
});

test("stranded read-only finalization retires with exact proof and a corrected read can continue", async () => {
  let unavailable = true, writes = 0, reads = 0;
  const pull = { number: 21, node_id: "PR_21", html_url: "https://github.com/owner/repo/pull/21", state: "open", draft: true, title: "Implementation", body: "Exact body", labels: [],
    user: { id: 7, login: "fixture" }, head: { ref: "delivery/implementation", sha: candidateSha, repo: { id: 42 } }, base: { ref: "main", sha: baselineSha, repo: { id: 42 } } };
  const server = createServer((request, response) => {
    if (request.method !== "GET") writes += 1; reads += 1; response.setHeader("content-type", "application/json");
    if (unavailable) { response.statusCode = 503; response.setHeader("retry-after", "600"); response.end("{}"); return; }
    if (request.url === "/user") return response.end(JSON.stringify({ id: 7, login: "fixture", type: "User" }));
    if (request.url === "/repos/owner/repo") return response.end(JSON.stringify({ id: 42, full_name: "owner/repo", private: false }));
    if (request.url === "/repos/owner/repo/pulls/21") return response.end(JSON.stringify(pull));
    if (request.url === `/repos/owner/repo/commits/${candidateSha}/check-runs?filter=latest&per_page=100`) return response.end(JSON.stringify({ total_count: 0, check_runs: [] }));
    if (request.url === `/repos/owner/repo/commits/${candidateSha}/status`) return response.end(JSON.stringify({ state: "pending", statuses: [] }));
    response.statusCode = 404; response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); assert(address && typeof address !== "string");
  try {
    const store = new FileStateStore(mkdtempSync(join(tmpdir(), "engine-stranded-readiness-")));
    const publisher = new Publisher({ repo: "owner/repo", repositoryId: 42, actorId: 7, login: "fixture", stateRoot: mkdtempSync(join(tmpdir(), "engine-stranded-readiness-publisher-")),
      remoteUrl: "https://github.com/owner/repo.git", tokenResolver: async () => "fixture-token", transportBaseUrl: `http://127.0.0.1:${address.port}`, testOnly: true });
    const engine = new DeliveryEngine({ store, publisher }); let state = readinessState(store, engine, "stranded-readiness");
    const expected = { ...state.handoffs.implementation!.expected, number: 21, title: "Implementation", body: "Exact body" }, payload = { number: 21, head_sha: candidateSha, checkpoint: "ci_observed", readback_id: "old_readback_001" };
    const operationId = digest({ action: "finalize", repo: state.repo, delivery_id: state.delivery_id, expected, payload }).slice(0, 24);
    const request: JsonObject = { schema_version: 1, action: "finalize", target_repo: state.repo, repo: state.repo, delivery_id: state.delivery_id, operation_id: operationId,
      expected_revision: state.revision + 1, expected, payload }; const requestDigest = publicationAuthorizationDigest(request);
    state = store.mutate(state.repo, state.delivery_id, state.revision, (next) => { next.status = "blocked"; next.operations.push({ id: operationId, action: "finalize", status: "uncertain",
      expected_revision: state.revision, request_digest: requestDigest, request, recorded_at: new Date().toISOString(), error: "GitHub is temporarily unavailable" }); next.unresolved_effects.push(operationId); return next; });
    const retired = await engine.reconcilePublicationEffects(state.repo, state.delivery_id, state.revision, "readback");
    assert.equal(retired.status, "pre_ready_ci_waiting"); assert.equal(retired.operations.at(-1)?.status, "failed"); assert.equal(retired.operations.at(-1)?.error_code, "GITHUB_UNAVAILABLE");
    assert.match(retired.operations.at(-1)?.attestation_proof_digest ?? "", /^[0-9a-f]{64}$/); assert.deepEqual(retired.unresolved_effects, []); assert.equal(writes, 0);
    unavailable = false; const continued = await engine.recheckReady(retired.repo, retired.delivery_id, retired.revision, "corrected_readback_001");
    assert.equal(continued.status, "pre_ready_ci_waiting"); assert.equal(continued.operations.at(-1)?.status, "completed"); assert.equal(continued.operations.at(-1)?.action, "finalize"); assert.equal(writes, 0); assert.ok(reads >= 6);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("generic and forged readiness failures cannot authenticate a safe retry", async () => {
  for (const [index, publisher] of [
    { async execute() { throw new GitHubUnavailable("generic readiness failure", 600); } },
    { async execute(packet: Record<string, unknown>) { throw new PublisherReadOnlyRefusal("forged readiness proof", { phase: "read_only", action: "finalize", operation_id: String(packet.operation_id),
      request_digest: publicationAuthorizationDigest(packet), publisher_identity_digest: "a".repeat(64), checkpoint: "ci_observed", candidate_sha: candidateSha, retry_after_seconds: 600, proof: "b".repeat(64) }); } },
  ].entries()) {
    const store = new FileStateStore(mkdtempSync(join(tmpdir(), "engine-untrusted-readiness-"))), engine = new DeliveryEngine({ store, publisher });
    const before = readinessState(store, engine, `untrusted-readiness-${index}`);
    await assert.rejects(() => engine.recheckReady(before.repo, before.delivery_id, before.revision), (error: unknown) => { assert.equal(enginePreEffectTransientReadOutcome(error), undefined); return true; });
    const after = store.read(before.repo, before.delivery_id); assert.equal(after.revision, before.revision); assert.equal(after.operations.length, 0); assert.deepEqual(after.unresolved_effects, []);
  }
});

test("completed publication remains authoritative across concurrent control completion CAS", async () => {
  const store = new ConcurrentControlCompletionStore(mkdtempSync(join(tmpdir(), "engine-control-completion-cas-"))); let calls = 0;
  const publisher = { async execute(packet: Record<string, unknown>) { calls += 1; const expected = packet.expected as JsonObject; return { schema_version: 1, action: packet.action, delivery_id: packet.delivery_id, operation_id: packet.operation_id, status: "published", pr: { number: 13, head_sha: expected.head_sha, base_sha: expected.base_sha } }; } };
  const engine = new DeliveryEngine({ store, publisher, controlGrant: { token: "grant", repositories: ["owner/repo"], actions: ["publish_plan"] } });
  let state = engine.start({ repo: "owner/repo", issue: 1, deliveryId: "control-completion-cas", policy: policy(), safeguards: { publication: { pr: "explicit" }, allowedPaths: { plan: ["plan.md"] } } });
  state = engine.acceptManifest(state.repo, state.delivery_id, plan(state.delivery_id), state.revision); state = engine.stageHandoff(state.repo, state.delivery_id, "plan", handoff(), state.revision);
  const input = { repo: state.repo, deliveryId: state.delivery_id, expectedRevision: state.revision, action: "publish_plan" as const, requestId: "completion_cas_001", grant: "grant", draftDigest: state.handoffs.plan!.digest };
  store.armed = true; const projection = await engine.control(input); state = store.read(state.repo, state.delivery_id);
  assert.equal(projection.status, "implementation_required"); assert.equal(state.operations.at(-1)?.status, "completed"); assert.equal(state.controls.requests[input.requestId]?.status, "completed"); assert.equal(calls, 1);
  const replay = await engine.reconcileControlRequest({ ...input, repositoryInputDigest: digest({ repo: input.repo, delivery_id: input.deliveryId, expected_revision: input.expectedRevision, request_id: input.requestId, action: input.action, digest: input.draftDigest ?? null }) });
  assert.equal(replay.status, "completed"); assert.equal(calls, 1);
});

test("completed publication remains authoritative when concurrent correction removes the handoff", async () => {
  const store = new CorrectBeforeControlCompletionStore(mkdtempSync(join(tmpdir(), "engine-control-completed-correct-"))); let calls = 0;
  const publisher = { async execute(packet: Record<string, unknown>) { calls += 1; const expected = packet.expected as JsonObject; return { schema_version: 1, action: packet.action, delivery_id: packet.delivery_id, operation_id: packet.operation_id, status: "published", pr: { number: 21, head_sha: expected.head_sha, base_sha: expected.base_sha } }; } };
  const engine = new DeliveryEngine({ store, publisher, controlGrant: { token: "grant", repositories: ["owner/repo"], actions: ["publish_plan", "correct"] } });
  let state = engine.start({ repo: "owner/repo", issue: 1, deliveryId: "completed-correct-cas", policy: policy(), safeguards: { publication: { pr: "explicit" }, allowedPaths: { plan: ["plan.md"] } } });
  state = engine.acceptManifest(state.repo, state.delivery_id, plan(state.delivery_id), state.revision); state = engine.stageHandoff(state.repo, state.delivery_id, "plan", handoff(), state.revision);
  const input = { repo: state.repo, deliveryId: state.delivery_id, expectedRevision: state.revision, action: "publish_plan" as const,
    requestId: "completed_publish_001", grant: "grant", draftDigest: state.handoffs.plan!.digest };
  store.armed = true; await engine.control(input); const final = store.read(state.repo, state.delivery_id), operation = final.operations.at(-1)!;
  assert.equal(operation.status, "completed"); assert.equal(final.controls.requests[input.requestId]?.operation_id, operation.id);
  assert.equal(final.controls.requests[input.requestId]?.operation_request_digest, operation.request_digest); assert.equal(final.controls.requests[input.requestId]?.status, "completed");
  assert.equal(final.status, "plan_required"); assert.equal(final.handoffs.plan, undefined); assert.equal(calls, 1);
});

test("publication reconciliation preserves its uncertain operation after concurrent correction removes the handoff", async () => {
  let releaseEffect!: () => void, markStarted!: () => void, calls = 0;
  const effectPossible = new Promise<void>((resolve) => { releaseEffect = resolve; }), started = new Promise<void>((resolve) => { markStarted = resolve; });
  const store = new FileStateStore(mkdtempSync(join(tmpdir(), "engine-control-causal-link-")));
  const engine = new DeliveryEngine({ store, publisher: { async execute(packet: Record<string, unknown>) { calls += 1; markStarted(); await effectPossible; const expected = packet.expected as JsonObject; return { schema_version: 1, action: packet.action, delivery_id: packet.delivery_id, operation_id: packet.operation_id, status: "published", pr: { number: 19, head_sha: expected.head_sha, base_sha: expected.base_sha } }; } },
    controlGrant: { token: "grant", repositories: ["owner/repo"], actions: ["publish_plan", "correct"] } });
  let state = engine.start({ repo: "owner/repo", issue: 1, deliveryId: "control-causal-link", policy: policy(), safeguards: { publication: { pr: "explicit" }, allowedPaths: { plan: ["plan.md"] } } });
  state = engine.acceptManifest(state.repo, state.delivery_id, plan(state.delivery_id), state.revision); state = engine.stageHandoff(state.repo, state.delivery_id, "plan", handoff(), state.revision);
  const publishInput = { repo: state.repo, deliveryId: state.delivery_id, expectedRevision: state.revision, action: "publish_plan" as const,
    requestId: "causal_publish_001", grant: "grant", draftDigest: state.handoffs.plan!.digest };
  const publishing = engine.control(publishInput); await started;
  let concurrent = store.read(state.repo, state.delivery_id); assert.equal(concurrent.operations.at(-1)?.status, "intent");
  await engine.control({ repo: state.repo, deliveryId: state.delivery_id, expectedRevision: concurrent.revision, action: "correct", requestId: "causal_correct_001", grant: "grant" });
  releaseEffect(); await publishing;
  const afterEffect = store.read(state.repo, state.delivery_id), operationId = afterEffect.operations.at(-1)!.id;
  assert.equal(afterEffect.operations.at(-1)?.status, "uncertain"); assert.equal(afterEffect.controls.requests[publishInput.requestId]?.status, "uncertain"); assert.equal(afterEffect.handoffs.plan, undefined);
  assert.equal(afterEffect.controls.requests[publishInput.requestId]?.operation_id, operationId);
  assert.equal(afterEffect.controls.requests[publishInput.requestId]?.operation_request_digest, afterEffect.operations.at(-1)?.request_digest);
  store.mutate(state.repo, state.delivery_id, afterEffect.revision, (next) => { delete next.controls.requests[publishInput.requestId]!.operation_id; delete next.controls.requests[publishInput.requestId]!.operation_request_digest; return next; });
  const reconciled = await engine.reconcileControlRequest({ ...publishInput, repositoryInputDigest: repositoryCommandInputDigest(publishInput) });
  const final = store.read(state.repo, state.delivery_id);
  assert.equal(reconciled.status, "uncertain"); assert.equal(reconciled.operation_id, operationId); assert.equal(final.controls.requests[publishInput.requestId]?.status, "uncertain");
  assert.equal(final.operations.at(-1)?.status, "uncertain"); assert(final.unresolved_effects.includes(operationId)); assert.equal(calls, 1);
});

test("control request reconciliation distinguishes failed from unresolved publication effects", async () => {
  const seed = (store: FileStateStore, engine: DeliveryEngine, id: string) => { let state = engine.start({ repo: "owner/repo", issue: 1, deliveryId: id, policy: policy(), safeguards: { publication: { pr: "explicit" }, allowedPaths: { plan: ["plan.md"] } } }); state = engine.acceptManifest(state.repo, state.delivery_id, plan(state.delivery_id), state.revision); return engine.stageHandoff(state.repo, state.delivery_id, "plan", handoff(), state.revision); };
  for (const terminal of ["failed", "uncertain"] as const) {
    let calls = 0; const store = new FileStateStore(mkdtempSync(join(tmpdir(), `engine-control-${terminal}-`)));
    const engine = new DeliveryEngine({ store, publisher: { async execute() { calls += 1; throw new DeliveryError("readback remains unavailable"); } }, controlGrant: { token: "grant", repositories: ["owner/repo"], actions: ["publish_plan"] } });
    let state = seed(store, engine, `control-${terminal}`), requestId = `${terminal}_publish_001`, draftDigest = state.handoffs.plan!.digest;
    const requestDigest = digest({ repo: state.repo, delivery_id: state.delivery_id, expected_revision: state.revision, action: "publish_plan", draft_digest: draftDigest });
    const operationId = digest({ action: "publish_plan", repo: state.repo, delivery_id: state.delivery_id, expected: state.handoffs.plan!.expected, payload: state.handoffs.plan!.payload }).slice(0, 24);
    const request = { schema_version: 1, action: "publish_plan", target_repo: state.repo, repo: state.repo, delivery_id: state.delivery_id, operation_id: operationId, expected_revision: state.revision + 1, expected: state.handoffs.plan!.expected, payload: state.handoffs.plan!.payload };
    state = store.mutate(state.repo, state.delivery_id, state.revision, (next) => { next.controls.requests[requestId] = { action: "publish_plan", request_digest: requestDigest, status: terminal === "failed" ? "intent" : "uncertain", at: new Date().toISOString() }; next.operations.push({ id: operationId, action: "publish_plan", stage: "plan", status: terminal, expected_revision: state.revision, request_digest: publicationAuthorizationDigest(request), request, recorded_at: new Date().toISOString() }); if (terminal === "uncertain") next.unresolved_effects.push(operationId, requestId); return next; });
    const semantic = { repo: state.repo, deliveryId: state.delivery_id, expectedRevision: state.revision - 1, action: "publish_plan" as const, requestId, grant: "grant", draftDigest };
    const result = await engine.reconcileControlRequest({ ...semantic, repositoryInputDigest: repositoryCommandInputDigest(semantic) });
    assert.equal(result.status, terminal); assert.equal(store.read(state.repo, state.delivery_id).controls.requests[requestId]?.status, terminal); assert.equal(calls, terminal === "uncertain" ? 1 : 0);
    if (terminal === "uncertain") { assert.match(result.error ?? "", /readback remains unavailable/); assert.equal(result.error_code, "DELIVERY_BLOCKED"); }
  }
});

test("control request reconciliation terminalizes a protected pre-effect denial with diagnostics", async () => {
  const store = new FileStateStore(mkdtempSync(join(tmpdir(), "engine-control-pre-effect-denial-"))); let calls = 0;
  const engine = new DeliveryEngine({ store, publisher: { async execute() { calls += 1; return {}; } }, controlGrant: { token: "grant", repositories: ["owner/repo"], actions: ["publish_plan"] } });
  let state = engine.start({ repo: "owner/repo", issue: 1, deliveryId: "control-pre-effect-denial", policy: policy(), safeguards: { publication: { pr: "explicit" }, allowedPaths: { plan: ["plan.md"] } } });
  state = engine.acceptManifest(state.repo, state.delivery_id, plan(state.delivery_id), state.revision); state = engine.stageHandoff(state.repo, state.delivery_id, "plan", handoff(), state.revision);
  const semantic = { repo: state.repo, deliveryId: state.delivery_id, expectedRevision: state.revision, action: "publish_plan" as const,
    requestId: "pre_effect_denial_001", grant: "grant", draftDigest: state.handoffs.plan!.digest };
  const requestDigest = digest({ repo: semantic.repo, delivery_id: semantic.deliveryId, expected_revision: semantic.expectedRevision, action: semantic.action, draft_digest: semantic.draftDigest });
  state = store.mutate(state.repo, state.delivery_id, state.revision, (next) => {
    next.status = "implementation_required";
    next.controls.requests[semantic.requestId] = { action: semantic.action, request_digest: requestDigest, status: "intent", at: new Date().toISOString() };
    return next;
  });
  const result = await engine.reconcileControlRequest({ ...semantic, repositoryInputDigest: repositoryCommandInputDigest(semantic) });
  assert.equal(result.status, "failed"); assert.equal(result.error_code, "DELIVERY_BLOCKED"); assert.match(result.error ?? "", /cannot publish plan from implementation_required/);
  const after = store.read(state.repo, state.delivery_id); assert.equal(after.controls.requests[semantic.requestId]?.status, "failed"); assert.equal(after.operations.length, 0); assert.equal(calls, 0);
});

test("control request reconciliation continues only a journal-absent pre-effect request", async () => {
  const store = new FileStateStore(mkdtempSync(join(tmpdir(), "engine-control-absent-"))); let calls = 0;
  const engine = new DeliveryEngine({ store, publisher: { async execute(packet: Record<string, unknown>) { calls += 1; const expected = packet.expected as JsonObject; return { schema_version: 1, action: packet.action, delivery_id: packet.delivery_id, operation_id: packet.operation_id, status: "published", pr: { number: 12, head_sha: expected.head_sha, base_sha: expected.base_sha } }; } }, controlGrant: { token: "grant", repositories: ["owner/repo"], actions: ["publish_plan"] } });
  let state = engine.start({ repo: "owner/repo", issue: 1, deliveryId: "control-absent", policy: policy(), safeguards: { publication: { pr: "explicit" }, allowedPaths: { plan: ["plan.md"] } } });
  state = engine.acceptManifest(state.repo, state.delivery_id, plan(state.delivery_id), state.revision); state = engine.stageHandoff(state.repo, state.delivery_id, "plan", handoff(), state.revision);
  const semantic = { repo: state.repo, deliveryId: state.delivery_id, expectedRevision: state.revision, action: "publish_plan" as const, requestId: "absent_publish_001", grant: "grant", draftDigest: state.handoffs.plan!.digest };
  await assert.rejects(() => engine.reconcileControlRequest({ ...semantic, repositoryInputDigest: "f".repeat(64) }), (error: unknown) => (error as { code?: string }).code === "REQUEST_CONFLICT");
  assert.equal(calls, 0); assert.equal(store.read(state.repo, state.delivery_id).controls.requests.absent_publish_001, undefined); assert.equal(store.read(state.repo, state.delivery_id).operations.length, 0);
  const exactDigest = digest({ repo: semantic.repo, delivery_id: semantic.deliveryId, expected_revision: semantic.expectedRevision, request_id: semantic.requestId, action: semantic.action, digest: semantic.draftDigest ?? null });
  const result = await engine.reconcileControlRequest({ ...semantic, repositoryInputDigest: exactDigest });
  assert.equal(result.status, "completed"); assert.equal(calls, 1); const after = store.read(state.repo, state.delivery_id); assert.equal(after.controls.requests.absent_publish_001?.status, "completed"); assert.equal(after.operations.at(-1)?.status, "completed");
});

test("readback-only control reconciliation never starts or replays a publication effect", async () => {
  const store = new FileStateStore(mkdtempSync(join(tmpdir(), "engine-control-readback-only-"))); let calls = 0, unsafeInspections = 0;
  const engine = new DeliveryEngine({ store, publisher: {
    async execute() { calls += 1; throw new Error("readback-only invoked publisher"); },
    async inspectPublication(request: JsonObject) { unsafeInspections += 1; return { status: "completed" as const, operation_id: String(request.operation_id), request_digest: publicationAuthorizationDigest(request), receipt: {} }; },
  }, controlGrant: { token: "grant", repositories: ["owner/repo"], actions: ["publish_plan"] } });
  let state = engine.start({ repo: "owner/repo", issue: 1, deliveryId: "control-readback-only", policy: policy(), safeguards: { publication: { pr: "explicit" }, allowedPaths: { plan: ["plan.md"] } } });
  state = engine.acceptManifest(state.repo, state.delivery_id, plan(state.delivery_id), state.revision); state = engine.stageHandoff(state.repo, state.delivery_id, "plan", handoff(), state.revision);
  const semantic = { repo: state.repo, deliveryId: state.delivery_id, expectedRevision: state.revision, action: "publish_plan" as const,
    requestId: "readback_publish_001", grant: "grant", draftDigest: state.handoffs.plan!.digest };
  const repositoryInputDigest = repositoryCommandInputDigest(semantic);
  const absent = await engine.reconcileControlRequest({ ...semantic, repositoryInputDigest, mode: "readback" });
  assert.equal(absent.status, "absent"); assert.equal(calls, 0); assert.equal(store.read(state.repo, state.delivery_id).controls.requests[semantic.requestId], undefined);
  const requestDigest = digest({ repo: semantic.repo, delivery_id: semantic.deliveryId, expected_revision: semantic.expectedRevision, action: semantic.action, draft_digest: semantic.draftDigest });
  state = store.mutate(state.repo, state.delivery_id, state.revision, (next) => { next.controls.requests[semantic.requestId] = { action: semantic.action, request_digest: requestDigest, status: "intent", at: new Date().toISOString() }; return next; });
  const held = await engine.reconcileControlRequest({ ...semantic, repositoryInputDigest, mode: "readback" });
  assert.equal(held.status, "failed"); assert.equal(held.error_code, "NO_EFFECT"); assert.equal(calls, 0); assert.equal(store.read(state.repo, state.delivery_id).operations.length, 0);
  assert.equal(store.read(state.repo, state.delivery_id).controls.requests[semantic.requestId]?.status, "failed");
  const operationId = "orphaned_publish_operation", operationRequest: JsonObject = { schema_version: 1, action: "publish_plan", repo: semantic.repo, target_repo: semantic.repo,
    delivery_id: semantic.deliveryId, operation_id: operationId, expected_revision: semantic.expectedRevision + 2, expected: state.handoffs.plan!.expected, payload: state.handoffs.plan!.payload };
  state = store.mutate(state.repo, state.delivery_id, store.read(state.repo, state.delivery_id).revision, (next) => {
    delete next.controls.requests[semantic.requestId]; next.operations.push({ id: operationId, action: "publish_plan", stage: "plan", status: "uncertain",
      expected_revision: semantic.expectedRevision + 1, request_digest: publicationAuthorizationDigest(operationRequest), request: operationRequest, recorded_at: new Date().toISOString() });
    next.unresolved_effects.push(operationId); return next;
  });
  const orphaned = await engine.reconcileControlRequest({ ...semantic, repositoryInputDigest, mode: "readback" });
  assert.equal(orphaned.status, "uncertain"); assert.equal(orphaned.operation_id, operationId); assert.equal(calls, 0); assert.equal(unsafeInspections, 0);
});

test("explicit publication recovery validates the exact candidate before recovering the publisher lock", async () => {
  const store = new FileStateStore(mkdtempSync(join(tmpdir(), "engine-publisher-lock-recovery-"))), order: string[] = [];
  const publisher = { async recoverLock() { order.push("recover-lock"); }, async execute(packet: Record<string, unknown>) { order.push("execute"); const expected = packet.expected as JsonObject; return { schema_version: 1, action: packet.action, delivery_id: packet.delivery_id, operation_id: packet.operation_id, status: "published", pr: { number: 3, head_sha: expected.head_sha, base_sha: expected.base_sha } }; } };
  const engine = new DeliveryEngine({ store, publisher }); let state = engine.start({ repo: "owner/repo", issue: 1, deliveryId: "recover-publisher-lock", policy: policy(), safeguards: { publication: { pr: "explicit" }, allowedPaths: { plan: ["plan.md"] } } }); state = engine.acceptManifest(state.repo, state.delivery_id, plan(state.delivery_id), state.revision); state = engine.stageHandoff(state.repo, state.delivery_id, "plan", handoff(), state.revision);
  const operationId = digest({ action: "publish_plan", repo: state.repo, delivery_id: state.delivery_id, expected: state.handoffs.plan!.expected, payload: state.handoffs.plan!.payload }).slice(0, 24), request = { schema_version: 1, action: "publish_plan", target_repo: state.repo, repo: state.repo, delivery_id: state.delivery_id, operation_id: operationId, expected_revision: state.revision + 1, expected: state.handoffs.plan!.expected, payload: state.handoffs.plan!.payload }, requestDigest = publicationAuthorizationDigest(request);
  state = store.mutate(state.repo, state.delivery_id, state.revision, (next) => { next.operations.push({ id: operationId, action: "publish_plan", stage: "plan", status: "uncertain", expected_revision: state.revision, request_digest: requestDigest, request, recorded_at: new Date().toISOString() }); next.unresolved_effects.push(operationId); return next; });
  const recovered = await engine.reconcilePublicationEffects(state.repo, state.delivery_id, state.revision); assert.deepEqual(order, ["recover-lock", "execute"]); assert.equal(recovered.operations.at(-1)?.status, "completed"); assert.equal(recovered.status, "implementation_required");
});

test("cancellation remains non-terminal when the executor does not confirm it", async () => {
  const store = new FileStateStore(mkdtempSync(join(tmpdir(), "engine-cancel-")));
  const executor = { async dispatch() { return { execution_id: "external-1", status: "running" }; }, async inspect() { return { status: "running" }; }, async collect() { return { status: "running" }; }, async cancel() { throw new Error("transport lost"); } };
  const engine = new DeliveryEngine({ store, executor, controlGrant: { token: "grant", repositories: ["owner/repo"], actions: ["cancel"] } });
  let state = engine.start({ repo: "owner/repo", issue: 1, deliveryId: "cancel-one", policy: policy() });
  state = store.mutate(state.repo, state.delivery_id, state.revision, (next) => { next.rank_snapshot = rankSnapshot(); return next; });
  state = await engine.dispatch(state.repo, state.delivery_id, state.revision);
  const projection = await engine.control({ repo: state.repo, deliveryId: state.delivery_id, expectedRevision: state.revision, action: "cancel", requestId: "cancel_request_1", grant: "grant" });
  assert.equal(projection.status, "blocked");
  const persisted = store.read(state.repo, state.delivery_id);
  assert.equal(persisted.controls.cancelled, false);
  assert.equal(persisted.claim_status, "active");
  assert.equal(persisted.controls.requests.cancel_request_1?.status, "pending");
});

test("a persisted dispatch intent reconciles with the same task identity", async () => {
  const store = new FileStateStore(mkdtempSync(join(tmpdir(), "engine-dispatch-reconcile-")));
  let task = "";
  const executor = { async dispatch(packet: Record<string, unknown>) { task = String(packet.task_id); return { execution_id: "external-reconciled", status: "running" }; }, async inspect() { return {}; }, async collect() { return {}; }, async cancel() { return {}; } };
  const engine = new DeliveryEngine({ store, executor });
  let state = engine.start({ repo: "owner/repo", issue: 1, deliveryId: "dispatch-reconcile", policy: policy() });
  state = store.mutate(state.repo, state.delivery_id, state.revision, (next) => { next.rank_snapshot = rankSnapshot(); next.runner = { status: "dispatching", owner_pid: 999_999, current_stage: "plan", execution_id: "stable_task_123" }; next.executions.push({ id: "stable_task_123", kind: "agent", stage: "plan", status: "dispatching", started_at: new Date().toISOString() }); return next; });
  state = await engine.dispatch(state.repo, state.delivery_id, state.revision);
  assert.equal(task, "stable_task_123");
  assert.equal(state.executions[0]?.external_id, "external-reconciled");
  assert.equal(state.budget.attempts_used, 0);
});

test("implementation dispatch carries the approved plan and protected issue without publication authority", async () => {
  const store = new FileStateStore(mkdtempSync(join(tmpdir(), "engine-implement-context-")));
  let packet: Record<string, unknown> = {};
  const executor = { async dispatch(value: Record<string, unknown>) { packet = value; return { execution_id: "implementation-external", provider: "test", status: "running" }; }, async inspect() { return {}; }, async collect() { return {}; }, async cancel() { return {}; } };
  const engine = new DeliveryEngine({ store, executor });
  let state = engine.start({ repo: "owner/repo", issue: 1, deliveryId: "implement-context", policy: policy(), safeguards: { allowedPaths: { implementation: ["src/change.ts"] } } });
  state = store.mutate(state.repo, state.delivery_id, state.revision, (next) => { next.rank_snapshot = rankSnapshot(); return next; });
  state = engine.acceptManifest(state.repo, state.delivery_id, plan(state.delivery_id), state.revision);
  state = store.mutate(state.repo, state.delivery_id, state.revision, (next) => { next.status = "implementation_required"; next.receipts.plan = { approved: true, generation: 1 }; next.publication.plan = { pr: { number: 7, head_sha: planSha, base_sha: baselineSha } }; return next; });
  await engine.dispatch(state.repo, state.delivery_id, state.revision);
  const context = packet.implementation_context as JsonObject;
  assert.equal((context.selected_issue as JsonObject).number, 1);
  assert.equal((context.approved_plan as JsonObject).delivery_id, state.delivery_id);
  assert.deepEqual(context.expected_base, { repo: state.repo, ref: "main", sha: baselineSha });
  assert.deepEqual(context.allowed_paths, ["src/change.ts"]);
  assert.equal((packet.output_contract as JsonObject).skill, "implement-plan");
  assert.equal("grant" in packet, false);
  assert.equal("authorized_digest" in packet, false);
});

test("a durable collected result resumes manifest acceptance without recollecting", async () => {
  const store = new FileStateStore(mkdtempSync(join(tmpdir(), "engine-result-reconcile-")));
  let remoteCalls = 0;
  const executor = { async dispatch() { return {}; }, async inspect() { remoteCalls += 1; return {}; }, async collect() { remoteCalls += 1; return {}; }, async cancel() { return {}; } };
  const engine = new DeliveryEngine({ store, executor });
  let state = engine.start({ repo: "owner/repo", issue: 1, deliveryId: "result-reconcile", policy: policy() });
  const result = { manifest: plan(state.delivery_id) };
  state = store.mutate(state.repo, state.delivery_id, state.revision, (next) => { next.runner = { status: "running", owner_pid: null, current_stage: "plan", execution_id: "result_task_1" }; next.executions.push({ id: "result_task_1", kind: "agent", stage: "plan", status: "completed", external_id: "external-1", started_at: new Date().toISOString(), result_digest: "persisted", result: result as unknown as JsonObject }); return next; });
  state = await engine.collect(state.repo, state.delivery_id, state.revision);
  assert.equal(remoteCalls, 0);
  assert.equal(state.status, "plan_review");
  assert.equal(state.runner.status, "idle");
});

test("candidate verification persists checker and reviewer lifecycle across ticks", async () => {
  const store = new FileStateStore(mkdtempSync(join(tmpdir(), "engine-review-")));
  let checkerCalls = 0, dispatchCalls = 0, inspectCalls = 0;
  let reviewPacket: Record<string, unknown> = {};
  const checker = { async verify() { checkerCalls += 1; return { status: "success", candidate_sha: candidateSha }; } };
  const reviewer = {
    async dispatch(packet: Record<string, unknown>) { dispatchCalls += 1; reviewPacket = packet; return { execution_id: "review-external", provider: "review-provider", status: "running", effect: "accepted", terminal: "nonterminal", proof: { kind: "run_receipt", reference: "review_running" } }; },
    async inspect() { inspectCalls += 1; return inspectCalls === 1 ? { execution_id: "review-external", status: "running", effect: "accepted", terminal: "nonterminal", proof: { kind: "run_receipt", reference: "review_running" } } : { execution_id: "review-external", status: "completed", effect: "accepted", terminal: "completed", proof: { kind: "run_receipt", reference: "review_complete" }, result: { status: "approved", delivery_id: "review-one", task_id: reviewPacket.task_id, criteria_digest: (reviewPacket.criteria as JsonObject).criteria_digest, candidate_sha: candidateSha } }; },
    async collect() { return { execution_id: "review-external", status: "completed", effect: "accepted", terminal: "completed", proof: { kind: "run_receipt", reference: "review_complete" }, result: { status: "approved", delivery_id: "review-one", task_id: reviewPacket.task_id, criteria_digest: (reviewPacket.criteria as JsonObject).criteria_digest, candidate_sha: candidateSha } }; },
    async cancel() { return { execution_id: "review-external", status: "cancelled", effect: "accepted", terminal: "cancelled", proof: { kind: "run_receipt", reference: "review_cancelled" } }; },
    async resolveOutcomeProof(_outcome: unknown, context: unknown) { return { trusted: true, proof_digest: digest(context) }; },
  };
  const engine = new DeliveryEngine({ store, checker, reviewer });
  let state = engine.start({ repo: "owner/repo", issue: 1, deliveryId: "review-one", policy: policy() });
  state = store.mutate(state.repo, state.delivery_id, state.revision, (next) => { next.status = "implementation_required"; next.executions.push({ id: "implementer", kind: "agent", stage: "implement", status: "completed", external_id: "producer-external", provider: "producer-provider", implementer_identity: "producer-provider:producer-external", started_at: new Date().toISOString() }); return next; });
  state = engine.acceptManifest(state.repo, state.delivery_id, { schema_version: 1, kind: "implement", delivery_id: state.delivery_id, repo: state.repo, result: { issue: 1, candidate_sha: candidateSha, base: { repo: state.repo, ref: "main", sha: baselineSha }, artifact_paths: ["src/change.ts"], verification: ["tests passed"] } }, state.revision);
  state = store.mutate(state.repo, state.delivery_id, state.revision, (next) => { next.manifests.implement!.producer_execution_id = "implementer"; next.manifests.implement!.producer_identity = "producer-provider:producer-external"; return next; });
  state = await engine.verifyCandidate(state.repo, state.delivery_id, state.revision);
  assert.equal(state.receipts.engineering, undefined);
  state = await engine.verifyCandidate(state.repo, state.delivery_id, state.revision);
  assert.equal(state.receipts.engineering?.candidate_sha, candidateSha);
  const unchanged = await engine.verifyCandidate(state.repo, state.delivery_id, state.revision);
  assert.equal(unchanged.revision, state.revision);
  assert.equal(checkerCalls, 1);
  assert.equal(dispatchCalls, 1);
});

test("resume rejects changed pinned profile and executable bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "engine-pins-"));
  const profile = join(root, "profile.json"), runtime = join(root, "runtime");
  writeFileSync(profile, "{}\n", { mode: 0o600 }); writeFileSync(runtime, "runtime-v1\n", { mode: 0o700 });
  const locations = { profile, runtime };
  const store = new FileStateStore(join(root, "state")); const engine = new DeliveryEngine({ store, runtimeLocations: locations });
  const state = engine.start({ repo: "owner/repo", issue: 1, deliveryId: "pins-one", policy: policy(), pinLocations: locations });
  writeFileSync(profile, "{\"changed\":true}\n", { mode: 0o600 });
  assert.throws(() => engine.acceptManifest(state.repo, state.delivery_id, plan(state.delivery_id), state.revision), /pinned runtime configuration or executable changed/);
});

test("missing or stale active pointer never creates a second authoritative claim", () => {
  const store = new FileStateStore(mkdtempSync(join(tmpdir(), "engine-claim-crash-")));
  const engine = new DeliveryEngine({ store });
  let first = engine.start({ repo: "owner/repo", issue: 1, deliveryId: "claim-first", policy: policy() });
  const activePath = join(store.repoDir(first.repo), "active.json");
  unlinkSync(activePath);
  assert.throws(() => engine.start({ repo: first.repo, issue: 2, deliveryId: "claim-second", policy: policy() }), /already claimed/);
  first = store.mutate(first.repo, first.delivery_id, first.revision, (next) => { next.claim_status = "released"; return next; });
  store.release(first);
  store.writeProtected(activePath, { schema_version: 2, repo: first.repo, delivery_id: first.delivery_id, status: "active", generation: first.claim_generation, token_digest: "stale", claimed_at: first.created_at });
  const second = engine.start({ repo: first.repo, issue: 2, deliveryId: "claim-second", policy: policy() });
  assert.equal(second.claim_status, "active");
});

test("control cancel persists intent for the owning runner watcher", async () => {
  const store = new FileStateStore(mkdtempSync(join(tmpdir(), "engine-cancel-all-")));
  const cancelled: string[] = [];
  const adapter = { async dispatch() { return {}; }, async inspect() { return {}; }, async collect() { return {}; }, async cancel(id: string) { cancelled.push(id); return { status: "cancelled" }; } };
  const engine = new DeliveryEngine({ store, executor: adapter, reviewer: adapter, controlGrant: { token: "grant", repositories: ["owner/repo"], actions: ["cancel"] } });
  let state = engine.start({ repo: "owner/repo", issue: 1, deliveryId: "cancel-all", policy: policy() });
  state = store.mutate(state.repo, state.delivery_id, state.revision, (next) => { next.runner = { status: "running", owner_pid: null, execution_id: "agent-task" }; next.executions.push({ id: "agent-task", kind: "agent", stage: "implement", status: "running", external_id: "agent-external", started_at: new Date().toISOString() }, { id: "review-task", kind: "reviewer", stage: "engineering_review", status: "running", external_id: "review-external", started_at: new Date().toISOString() }); return next; });
  const result = await engine.control({ repo: state.repo, deliveryId: state.delivery_id, expectedRevision: state.revision, action: "cancel", requestId: "cancel_all_request", grant: "grant" });
  assert.equal(result.status, "plan_required");
  assert.deepEqual(cancelled, []);
  assert.equal(store.read(state.repo, state.delivery_id).controls.cancellation?.phase, "requested");
});

test("cancel cannot release a claim with an uncertain execution", async () => {
  const store = new FileStateStore(mkdtempSync(join(tmpdir(), "engine-cancel-uncertain-")));
  let cancelCalls = 0;
  const executor = { async dispatch() { return {}; }, async inspect() { return {}; }, async collect() { return {}; }, async cancel() { cancelCalls += 1; return { status: "cancelled" }; } };
  const engine = new DeliveryEngine({ store, executor, controlGrant: { token: "grant", repositories: ["owner/repo"], actions: ["cancel"] } });
  let state = engine.start({ repo: "owner/repo", issue: 1, deliveryId: "cancel-uncertain", policy: policy() });
  state = store.mutate(state.repo, state.delivery_id, state.revision, (next) => { next.runner = { status: "failed", owner_pid: null, execution_id: "uncertain-task" }; next.executions.push({ id: "uncertain-task", kind: "agent", stage: "implement", status: "uncertain", external_id: "maybe-live", started_at: new Date().toISOString() }); return next; });
  const result = await engine.control({ repo: state.repo, deliveryId: state.delivery_id, expectedRevision: state.revision, action: "cancel", requestId: "cancel_uncertain_request", grant: "grant" });
  assert.equal(result.status, "plan_required");
  const persisted = store.read(state.repo, state.delivery_id);
  assert.equal(persisted.claim_status, "active");
  assert.equal(persisted.controls.cancelled, false);
  assert.equal(persisted.controls.requests.cancel_uncertain_request?.status, "pending");
  assert.equal(cancelCalls, 0);
});

test("publication response reconciles after a concurrent pause without replay", async () => {
  const store = new FileStateStore(mkdtempSync(join(tmpdir(), "engine-publish-cas-")));
  let calls = 0;
  const publisher = { async execute(packet: Record<string, unknown>) { calls += 1; store.mutate("owner/repo", "publish-cas", undefined, (next) => { next.controls.paused = true; return next; }); const expected = packet.expected as JsonObject; return { schema_version: 1, action: packet.action, delivery_id: packet.delivery_id, operation_id: packet.operation_id, status: "published", pr: { number: 4, head_sha: expected.head_sha, base_sha: expected.base_sha } }; } };
  const engine = new DeliveryEngine({ store, publisher });
  let state = engine.start({ repo: "owner/repo", issue: 1, deliveryId: "publish-cas", policy: policy(), safeguards: { publication: { pr: "automatic" }, allowedPaths: { plan: ["plan.md"] } } });
  state = engine.acceptManifest(state.repo, state.delivery_id, plan(state.delivery_id), state.revision);
  state = engine.stageHandoff(state.repo, state.delivery_id, "plan", handoff(), state.revision);
  state = await engine.publishStage(state.repo, state.delivery_id, "plan", state.revision, state.handoffs.plan!.digest);
  assert.equal(calls, 1);
  assert.equal(state.operations[0]?.status, "completed");
  assert.equal(state.controls.paused, true);
  assert.equal(state.status, "implementation_required");
});

test("concurrent cancel waits for an in-flight publication effect", async () => {
  const store = new FileStateStore(mkdtempSync(join(tmpdir(), "engine-publish-cancel-")));
  let releasePublisher!: () => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const blocked = new Promise<void>((resolve) => { releasePublisher = resolve; });
  const publisher = { async execute(packet: Record<string, unknown>) { markStarted(); await blocked; const expected = packet.expected as JsonObject; return { schema_version: 1, action: packet.action, delivery_id: packet.delivery_id, operation_id: packet.operation_id, status: "published", pr: { number: 8, head_sha: expected.head_sha, base_sha: expected.base_sha } }; } };
  const engine = new DeliveryEngine({ store, publisher, controlGrant: { token: "grant", repositories: ["owner/repo"], actions: ["cancel"] } });
  let state = engine.start({ repo: "owner/repo", issue: 1, deliveryId: "publish-cancel", policy: policy(), safeguards: { publication: { pr: "automatic" }, allowedPaths: { plan: ["plan.md"] } } });
  state = engine.acceptManifest(state.repo, state.delivery_id, plan(state.delivery_id), state.revision);
  state = engine.stageHandoff(state.repo, state.delivery_id, "plan", handoff(), state.revision);
  const publishing = engine.publishStage(state.repo, state.delivery_id, "plan", state.revision, state.handoffs.plan!.digest);
  await started;
  const intent = store.read(state.repo, state.delivery_id);
  const cancelInput = { repo: intent.repo, deliveryId: intent.delivery_id, expectedRevision: intent.revision, action: "cancel" as const, requestId: "cancel_publish_request", grant: "grant" };
  await engine.control(cancelInput);
  assert.equal(store.read(state.repo, state.delivery_id).controls.requests.cancel_publish_request?.status, "pending");
  releasePublisher();
  await publishing;
  let persisted = store.read(state.repo, state.delivery_id);
  assert.equal(persisted.claim_status, "active");
  assert.equal(persisted.operations[0]?.status, "completed");
  await engine.control(cancelInput);
  persisted = store.read(state.repo, state.delivery_id);
  assert.equal(persisted.claim_status, "active");
  assert.equal(persisted.controls.cancellation?.phase, "requested");
});

test("correction invalidates staged and exported publication material", async () => {
  const store = new FileStateStore(mkdtempSync(join(tmpdir(), "engine-correction-stale-")));
  const engine = new DeliveryEngine({ store, controlGrant: { token: "grant", repositories: ["owner/repo"], actions: ["correct"] } });
  let state = engine.start({ repo: "owner/repo", issue: 1, deliveryId: "correction-stale", policy: policy(), safeguards: { allowedPaths: { plan: ["plan.md"] } } });
  state = engine.acceptManifest(state.repo, state.delivery_id, plan(state.delivery_id), state.revision);
  state = engine.stageHandoff(state.repo, state.delivery_id, "plan", handoff(), state.revision);
  state = store.mutate(state.repo, state.delivery_id, state.revision, (next) => { next.publication.plan_manual_handoff = { status: "manual_handoff" }; return next; });
  await engine.control({ repo: state.repo, deliveryId: state.delivery_id, expectedRevision: state.revision, action: "correct", requestId: "correct_request_1", grant: "grant" });
  const corrected = store.read(state.repo, state.delivery_id);
  assert.equal(corrected.handoffs.plan, undefined);
  assert.equal(corrected.publication.plan_manual_handoff, undefined);
});

test("manual implementation binding cannot bypass independent engineering verification", async () => {
  const store = new FileStateStore(mkdtempSync(join(tmpdir(), "engine-manual-gate-")));
  let calls = 0;
  const publisher = { async execute() { calls += 1; return {}; } };
  const engine = new DeliveryEngine({ store, publisher });
  let state = engine.start({ repo: "owner/repo", issue: 1, deliveryId: "manual-gate", policy: policy(), safeguards: { allowedPaths: { implementation: ["src/change.ts"] } } });
  state = store.mutate(state.repo, state.delivery_id, state.revision, (next) => { next.status = "implementation_required"; return next; });
  state = engine.acceptManifest(state.repo, state.delivery_id, { schema_version: 1, kind: "implement", delivery_id: state.delivery_id, repo: state.repo, result: { issue: 1, candidate_sha: candidateSha, base: { repo: state.repo, ref: "main", sha: baselineSha }, artifact_paths: ["src/change.ts"], verification: ["agent report"] } }, state.revision);
  state = engine.stageHandoff(state.repo, state.delivery_id, "implementation", implementationHandoff(), state.revision);
  state = store.mutate(state.repo, state.delivery_id, state.revision, (next) => { next.publication.implementation_manual_handoff = { status: "manual_handoff" }; return next; });
  await assert.rejects(() => engine.bindManualPullRequest(state.repo, state.delivery_id, "implementation", 9, state.revision), /independent engineering verification/);
  assert.equal(calls, 0);
});
