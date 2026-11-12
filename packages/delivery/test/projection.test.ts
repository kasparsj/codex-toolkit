import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runSchema } from "../../../plugins/paseo-delivery/shared/rpc.ts";
import { DeliveryEngine } from "../src/engine.ts";
import { dashboardProjection } from "../src/projection.ts";
import { reviewBody, reviewContext } from "../src/reviews.ts";
import { FileStateStore } from "../src/store.ts";
import type { DeliveryState } from "../src/types.ts";
import { policy } from "./helpers.ts";

const baseline = "a".repeat(40);
const candidate = "c".repeat(40);
const privateSentinel = "PRIVATE_BODY_MUST_NOT_LEAK_7f41";

function projectedRun(state: DeliveryState): Record<string, unknown> {
  const snapshot = dashboardProjection(state, new Date(state.updated_at)) as { runs: Record<string, unknown>[] };
  return snapshot.runs[0]!;
}

function stagedPlan(): DeliveryState {
  const store = new FileStateStore(mkdtempSync(join(tmpdir(), "projection-")));
  const engine = new DeliveryEngine({ store });
  let state = engine.start({ repo: "example/toolkit", issue: 42, deliveryId: "fixture-plan-review", policy: policy(1, 0), safeguards: { publication: { pr: "explicit" }, allowedPaths: { plan: ["docs/plan.md"] } } });
  state = engine.acceptManifest(state.repo, state.delivery_id, {
    schema_version: 1, kind: "plan", delivery_id: state.delivery_id, repo: state.repo,
    result: { issue: 42, baseline: { repo: state.repo, ref: "main", sha: baseline }, base: { repo: state.repo, ref: "main", sha: baseline }, plan_revision: candidate, artifact_paths: ["docs/plan.md"], artifact_hashes: { "docs/plan.md": "d".repeat(64) } },
  }, state.revision);
  return engine.stageHandoff(state.repo, state.delivery_id, "plan", {
    expected: { head: "delivery/plan-42", head_sha: candidate, base: "main", base_sha: baseline, previous_sha: null },
    payload: { title: "Fixture: local plan awaiting review", body: privateSentinel, bundle: "/private/path/candidate.bundle", allowed_paths: ["docs/plan.md"] },
  }, state.revision);
}

test("staged handoff projects exact digest and revisions without protected body", () => {
  const state = stagedPlan();
  const run = projectedRun(state);
  assert.equal(run.sourceRevision, baseline);
  assert.equal(run.currentRevision, candidate);
  assert.equal(run.revision, state.revision);
  assert.equal(run.review, undefined, "review metadata is not applicable before a PR is bound");
  assert.deepEqual(run.draft, {
    kind: "plan_pr", id: `${state.delivery_id}:plan`, digest: state.handoffs.plan!.digest, status: "staged",
    title: "Fixture: local plan awaiting review", bodyAvailableInCli: true, publicationMode: "explicit",
  });
  const serialized = JSON.stringify(run);
  assert.equal(serialized.includes(privateSentinel), false);
  assert.equal(serialized.includes("/private/path/candidate.bundle"), false);
  assert.equal(serialized.includes("docs/plan.md"), false);
});

test("review freshness represents exact bound identity, not approval", () => {
  const state = stagedPlan();
  state.publication.plan = { status: "published", pr: { number: 7, head_sha: candidate, base_sha: baseline, draft: true, html_url: "https://github.com/example/toolkit/pull/7" } };
  state.receipts.plan = { approved: false, approvers: [], rejectors: [], commit_id: candidate, generation: 1, checked_at: state.updated_at };
  const run = projectedRun(state);
  const context = reviewContext({ stage: "plan", generation: 1, issue: 42, material_hashes: { manifest: state.manifests.plan!.material_digest }, baseline_sha: baseline, base_repo: state.repo, base_ref: "main", base_sha: baseline, final_repo: state.repo, final_ref: "main", policy_digest: state.policy.digest });
  assert.deepEqual(run.review, {
    fresh: true, headSha: candidate, baseSha: baseline,
    instructions: [`Approve with this exact review body: ${reviewBody("plan", 1, context, "approve")}`, `Reject with this exact review body: ${reviewBody("plan", 1, context, "reject")}`], receipts: [],
  });
  assert.equal(run.prUrl, "https://github.com/example/toolkit/pull/7");
  (state.publication.plan.pr as Record<string, unknown>).head_sha = "e".repeat(40);
  assert.equal((projectedRun(state).review as { fresh: boolean }).fresh, false);
});

test("completed projection parses with native UI schema and uses a string report", () => {
  const state = stagedPlan();
  state.status = "completed";
  const run = projectedRun(state);
  assert.equal(typeof run.finalReport, "string");
  const parsed = runSchema.parse(run);
  assert.equal(parsed.sourceRevision, baseline);
  assert.equal(parsed.currentRevision, candidate);
  assert.equal(parsed.revision, state.revision);
});

test("fresh RPC projection keeps old evidence visible without disabling controls", () => {
  const state = stagedPlan();
  state.updated_at = "2020-01-01T00:00:00.000Z";
  state.runner.status = "running";
  state.status = "publication_pending";
  state.receipts.engineering = { candidate_sha: candidate };
  state.publication.implementation = { pr: { number: 9, head_sha: candidate, base_sha: baseline, html_url: "https://github.com/example/toolkit/pull/9" } };
  state.publication.final = { ci: { name: "CI", conclusion: "success", html_url: "https://github.com/example/toolkit/actions/runs/1" } };
  const run = (dashboardProjection(state, new Date("2026-01-01T00:00:00.000Z")) as { runs: Record<string, unknown>[] }).runs[0]!;
  assert.equal(run.stale, false);
  assert.equal(run.evidenceStale, true);
  assert.equal(run.evidenceAt, state.updated_at);
  assert.equal((run.checks as { local: Array<{ status: string }>; actions: Array<{ status: string }> }).local[0]?.status, "completed");
  assert.equal((run.checks as { local: Array<{ status: string }>; actions: Array<{ status: string }> }).actions[0]?.status, "completed");
  assert.equal((run.availableActions as string[]).includes("recover"), false, "healthy running work is not offered as stranded recovery");
  assert.equal(run.prUrl, "https://github.com/example/toolkit/pull/9");
  assert.equal(run.issueUrl, "https://github.com/example/toolkit/issues/42");
});

test("verification projects deterministic candidate checks independently and excludes private detail", () => {
  const state = stagedPlan(), manifestDigest = "f".repeat(64);
  state.manifests.implement = { ...state.manifests.plan!, digest: manifestDigest, value: { schema_version: 1, kind: "implement", repo: state.repo, delivery_id: state.delivery_id, result: { candidate_sha: candidate } } };
  state.receipts.checks = { status: "success", candidate_sha: candidate, manifest_digest: manifestDigest, checked_at: state.updated_at, commands: { private: privateSentinel }, output: "/private/checker/output" };
  let run = projectedRun(state), local = (run.checks as { local: Array<{ name: string; status: string; summary?: string }> }).local;
  assert.deepEqual(local, [{ name: "Configured candidate checks", status: "completed", summary: `Exact candidate ${candidate}` }]);
  assert.equal(JSON.stringify(run).includes(privateSentinel), false); assert.equal(JSON.stringify(run).includes("/private/checker/output"), false);
  state.receipts.engineering = { candidate_sha: candidate };
  local = (projectedRun(state).checks as { local: Array<{ name: string; status: string; summary?: string }> }).local;
  assert.deepEqual(local.map((item) => item.name), ["Configured candidate checks", "Independent engineering review"]);
  state.receipts.checks.candidate_sha = "b".repeat(40);
  run = projectedRun(state); local = (run.checks as { local: Array<{ name: string; status: string }> }).local;
  assert.equal(local[0]?.status, "stale");
  state.receipts.checks.candidate_sha = candidate; state.receipts.checks.manifest_digest = "0".repeat(64);
  assert.equal((projectedRun(state).checks as { local: Array<{ status: string }> }).local[0]?.status, "stale");
  runSchema.parse(projectedRun(state));
});

test("terminal and released runs expose no consequential run controls", () => {
  for (const status of ["review_ready", "completed", "cancelled", "plan_review"] as const) {
    const state = stagedPlan(); state.status = status; state.claim_status = "released"; state.runner.status = "failed";
    assert.deepEqual(projectedRun(state).availableActions, [], status);
  }
  const waitingForRelease = stagedPlan(); waitingForRelease.status = "review_ready";
  assert.deepEqual(projectedRun(waitingForRelease).availableActions, []);
});

test("handled or rejected Pi input explains unknown effects without overstating the proof or exposing private errors", () => {
  const state = stagedPlan(); state.status = "blocked"; state.runner.status = "failed";
  state.executions.push({ id: "handled-input", kind: "agent", stage: "rank", status: "uncertain", provider: "pi", started_at: state.updated_at,
    effect: "unknown", terminal: "failed", proof: { kind: "no_ordinary_run", reference: `ar_${"a".repeat(32)}` }, proof_digest: "e".repeat(64), outcome_error: `${privateSentinel} /private/session/path` });
  state.unresolved_effects = ["handled-input"];
  const run = projectedRun(state), blockers = run.blockers as Array<{ code: string; message: string }>;
  assert.equal(run.status, "blocked"); assert.equal(blockers[0]?.code, "PI_NO_ORDINARY_RUN");
  assert.equal(blockers[0]!.message, "Pi did not start an ordinary run. Effects after input submission are unknown; inspect them before explicit recovery.");
  for (const disposition of ["handled", "rejected"]) {
    state.executions[0]!.outcome_error = `${disposition}: ${privateSentinel} /private/session/path`;
    assert.deepEqual(projectedRun(state).blockers, blockers, "the shared proof does not attest the input disposition");
  }
  assert.equal(JSON.stringify(run).includes(privateSentinel), false); assert.equal(JSON.stringify(run).includes("/private/session/path"), false);
  assert.equal((run.availableActions as string[]).includes("resume"), false); assert.equal((run.availableActions as string[]).includes("retry_review"), false);
  assert.deepEqual(run.unresolvedEffects, ["handled-input"]); runSchema.parse(run);
  state.executions[0]!.proof_digest = undefined;
  assert.equal((projectedRun(state).blockers as Array<{ code: string }>)[0]?.code, "DELIVERY_BLOCKED", "unverified evidence retains the generic hold");
});
