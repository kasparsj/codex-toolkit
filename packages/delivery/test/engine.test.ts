import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DeliveryEngine } from "../src/engine.ts";
import { FileStateStore } from "../src/store.ts";
import { policy } from "./helpers.ts";

function plan(id: string, repo: string, sha = "3".repeat(40)) { return { schema_version: 1, kind: "plan", delivery_id: id, repo, result: { artifact_paths: ["plan.md"], artifact_hashes: { "plan.md": "a".repeat(64) }, plan_revision: sha, issue: 1, baseline: { repo, ref: "main", sha: "4".repeat(40) } } }; }
function handoff(sha: string) { return { expected: { head: "delivery/one", base: "main", head_sha: sha, base_sha: "4".repeat(40), previous_sha: null }, payload: { title: "Plan", body: "Body", bundle: "/tmp/candidate.bundle", allowed_paths: ["plan.md"] } }; }

test("engine persists publication intent before exact response and advances zero gate", async () => {
  const store = new FileStateStore(mkdtempSync(join(tmpdir(), "engine-"))); const calls: Record<string, unknown>[] = [];
  const publisher = { async execute(packet: Record<string, unknown>) { calls.push(packet); const expected = packet.expected as Record<string, unknown>; return { schema_version: 1, action: packet.action, delivery_id: packet.delivery_id, operation_id: packet.operation_id, status: "published", pr: { number: 1, head_sha: expected.head_sha, base_sha: expected.base_sha } }; } };
  const engine = new DeliveryEngine({ store, publisher }); let state = engine.start({ repo: "owner/repo", issue: 1, deliveryId: "one", policy: policy(), safeguards: { publication: { pr: "automatic" }, allowedPaths: { plan: ["plan.md"] } } });
  state = engine.acceptManifest(state.repo, state.delivery_id, plan(state.delivery_id, state.repo), state.revision);
  state = engine.stageHandoff(state.repo, state.delivery_id, "plan", handoff("3".repeat(40)), state.revision);
  state = await engine.publishStage(state.repo, state.delivery_id, "plan", state.revision, state.handoffs.plan!.digest);
  assert.equal(state.status, "implementation_required"); assert.equal(state.operations[0]?.status, "completed"); assert.equal(calls.length, 1); assert.match(calls[0]?.authorized_digest as string, /^[0-9a-f]{64}$/);
  state = engine.acceptManifest(state.repo, state.delivery_id, { schema_version: 1, kind: "implement", delivery_id: state.delivery_id, repo: state.repo, result: { candidate_sha: "5".repeat(40), artifact_paths: ["src/change.ts"], verification: ["npm test passed", "npm run typecheck passed"], issue: 1, base: { repo: state.repo, ref: "main", sha: "4".repeat(40) } } }, state.revision);
  assert.equal(state.manifests.implement?.value.result.verification instanceof Array, true);
});

test("material correction increments generation and invalidates receipts", async () => {
  const store = new FileStateStore(mkdtempSync(join(tmpdir(), "correction-"))); const engine = new DeliveryEngine({ store, controlGrant: { token: "grant", repositories: ["owner/repo"], actions: ["correct"] } });
  let state = engine.start({ repo: "owner/repo", issue: 1, deliveryId: "one", policy: policy(1, 0) }); state = engine.acceptManifest(state.repo, state.delivery_id, plan(state.delivery_id, state.repo), state.revision);
  const projection = await engine.control({ repo: state.repo, deliveryId: state.delivery_id, expectedRevision: state.revision, action: "correct", requestId: "request_123", grant: "grant" });
  state = store.read(state.repo, state.delivery_id); state = engine.acceptManifest(state.repo, state.delivery_id, plan(state.delivery_id, state.repo, "5".repeat(40)), state.revision); assert.equal(state.manifests.plan?.generation, 2); assert.equal(projection.status, "plan_required");
});

test("dispatch loss remains uncertain and does not relaunch", async () => {
  let dispatches = 0; const executor = { async dispatch() { dispatches += 1; throw new Error("lost response"); }, async inspect() { return {}; }, async collect() { return {}; }, async cancel() { return {}; } };
  const publisher = { async execute(packet: Record<string, unknown>) { return { schema_version: 1, action: "rank_snapshot", delivery_id: packet.delivery_id, operation_id: packet.operation_id, status: "snapshot", issues: [{ number: 1, state: "open", pull_request: false, labels: [] }], open_prs: [], dependencies: [{ issue: 1, blocked_by: [], blocks: [], related: [], unresolved: [] }], coverage: { issues_complete: true, open_prs_complete: true, unresolved_count: 0 } }; } };
  const store = new FileStateStore(mkdtempSync(join(tmpdir(), "dispatch-"))); const engine = new DeliveryEngine({ store, executor, publisher }); let state = engine.start({ repo: "owner/repo", issue: 1, deliveryId: "one", policy: policy() }); state = await engine.dispatch(state.repo, state.delivery_id, state.revision);
  assert.equal(state.runner.status, "failed"); assert.equal(state.executions[0]?.status, "uncertain"); assert.equal(dispatches, 1); await assert.rejects(() => engine.dispatch(state.repo, state.delivery_id, state.revision), /existing execution must be reconciled/i);
});

test("fresh controls refuse terminal or released deliveries without journal mutation", async () => {
  const actions = ["pause", "resume", "cancel", "recover", "correct", "recheck_ready", "retry_review"] as const;
  for (const status of ["review_ready", "completed", "cancelled", "plan_review"] as const) {
    const store = new FileStateStore(mkdtempSync(join(tmpdir(), "terminal-control-"))), engine = new DeliveryEngine({ store, controlGrant: { token: "terminal-grant", repositories: ["owner/repo"], actions: [...actions] } });
    let state = engine.start({ repo: "owner/repo", issue: 1, deliveryId: `terminal-${status}`, policy: policy() });
    state = store.mutate(state.repo, state.delivery_id, state.revision, (next) => { next.status = status; next.claim_status = status === "review_ready" ? "active" : "released"; return next; });
    for (const action of actions) await assert.rejects(() => engine.control({ repo: state.repo, deliveryId: state.delivery_id, expectedRevision: state.revision, action, requestId: `terminal_${action}_001`, grant: "terminal-grant" }), /terminal|released/i);
    assert.equal(store.read(state.repo, state.delivery_id).revision, state.revision);
    assert.deepEqual(store.read(state.repo, state.delivery_id).controls.requests, {});
  }
});

test("completed control replay remains readable after delivery release", async () => {
  const store = new FileStateStore(mkdtempSync(join(tmpdir(), "terminal-replay-"))), engine = new DeliveryEngine({ store, controlGrant: { token: "terminal-grant", repositories: ["owner/repo"], actions: ["pause"] } });
  let state = engine.start({ repo: "owner/repo", issue: 1, deliveryId: "released-replay", policy: policy() });
  const input = { repo: state.repo, deliveryId: state.delivery_id, expectedRevision: state.revision, action: "pause" as const, requestId: "pause_before_release_001", grant: "terminal-grant" };
  await engine.control(input); state = store.read(state.repo, state.delivery_id);
  state = store.mutate(state.repo, state.delivery_id, state.revision, (next) => { next.status = "review_ready"; next.claim_status = "released"; return next; });
  await engine.control(input); assert.equal(store.read(state.repo, state.delivery_id).revision, state.revision);
});
