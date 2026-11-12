import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeliveryEngine } from "./engine.ts";
import { FileStateStore } from "./store.ts";
import { dashboardProjection } from "./projection.ts";
import type { DeliveryPolicy } from "./types.ts";

const root = mkdtempSync(join(tmpdir(), "delivery-v2-demo-"));
try {
  const policy: DeliveryPolicy = { version: 1, delivery: { final_target: "main", publisher_id: 7, require_github_actions: true }, branches: { default_parent: "main", plan_template: "delivery/plan", implementation_template: "delivery/impl", allowed_parent_prefixes: [] }, eligibility: { required_labels: [], excluded_labels: [] }, approvals: { plan: { minimum: 0, reviewer_ids: [] }, implementation: { minimum: 0, reviewer_ids: [] } }, tracking: {}, _source: { ref: "refs/heads/main", sha: "1".repeat(40), digest: "2".repeat(64), fetched_at: new Date().toISOString() } };
  const publisher = { async execute(packet: Record<string, unknown>) { const payload = packet.payload as Record<string, unknown>; const manifest = payload.manifest as Record<string, unknown> | undefined; const result = manifest?.result as Record<string, unknown> | undefined; return { schema_version: 1, action: packet.action, delivery_id: packet.delivery_id, operation_id: packet.operation_id, status: "completed", head_sha: result?.plan_revision ?? result?.candidate_sha, base_sha: result?.base }; } };
  const candidate = "5".repeat(40);
  const checker = { async verify() { return { status: "success", candidate_sha: candidate }; } };
  let reviewPacket: Record<string, any>;
  const reviewer = {
    async dispatch(packet: Record<string, unknown>) { reviewPacket = packet; return { execution_id: "fixture-independent-review", status: "completed", provider: "fixture" }; },
    async inspect() { return { status: "completed" }; },
    async collect() { return { status: "completed", result: { status: "approved", candidate_sha: candidate, delivery_id: "demo", task_id: reviewPacket.task_id, criteria_digest: reviewPacket.criteria.criteria_digest } }; },
    async cancel() { return { status: "cancelled" }; },
  };
  const engine = new DeliveryEngine({ store: new FileStateStore(root), publisher, checker, reviewer });
  let state = engine.start({ repo: "example/toolkit", issue: 42, deliveryId: "demo", policy, safeguards: { publication: { pr: "automatic" }, allowedPaths: { plan: ["plan.md"], implementation: ["src/change.ts"] } } });
  state = engine.acceptManifest(state.repo, state.delivery_id, { schema_version: 1, kind: "plan", delivery_id: "demo", repo: state.repo, result: { artifact_paths: ["plan.md"], artifact_hashes: { "plan.md": "a".repeat(64) }, plan_revision: "3".repeat(40), issue: 42, baseline: { repo: state.repo, ref: "main", sha: "4".repeat(40) } } }, state.revision);
  state = engine.stageHandoff(state.repo, state.delivery_id, "plan", { expected: { head: "delivery/demo-plan", base: "main", head_sha: "3".repeat(40), base_sha: "4".repeat(40), previous_sha: null }, payload: { title: "Plan issue 42", body: "Plan", bundle: "/tmp/plan.bundle", allowed_paths: ["plan.md"] } }, state.revision);
  state = await engine.publishStage(state.repo, state.delivery_id, "plan", state.revision, state.handoffs.plan!.digest);
  state = engine.acceptManifest(state.repo, state.delivery_id, { schema_version: 1, kind: "implement", delivery_id: "demo", repo: state.repo, result: { candidate_sha: "5".repeat(40), artifact_paths: ["src/change.ts"], verification: ["tests passed"], issue: 42, base: { repo: state.repo, ref: "main", sha: "4".repeat(40) } } }, state.revision);
  state = engine.store.mutate(state.repo, state.delivery_id, state.revision, (next) => {
    next.manifests.implement!.producer_execution_id = "fixture-implementation-task";
    next.manifests.implement!.producer_identity = "agent:fixture:fixture-implementation";
    next.executions.push({ id: "fixture-implementation-task", kind: "agent", stage: "implement", status: "completed", provider: "fixture", external_id: "fixture-implementation", started_at: new Date().toISOString() });
    return next;
  });
  state = engine.stageHandoff(state.repo, state.delivery_id, "implementation", { expected: { head: "delivery/demo", base: "main", head_sha: "5".repeat(40), base_sha: "4".repeat(40), previous_sha: null }, payload: { title: "Implement issue 42", body: "Implementation", bundle: "/tmp/implementation.bundle", allowed_paths: ["src/change.ts"] } }, state.revision);
  state = await engine.verifyCandidate(state.repo, state.delivery_id, state.revision);
  state = await engine.publishStage(state.repo, state.delivery_id, "implementation", state.revision, state.handoffs.implementation!.digest);
  console.log(JSON.stringify(dashboardProjection(state), null, 2));
} finally { rmSync(root, { recursive: true, force: true }); }
