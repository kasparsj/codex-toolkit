import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DeliveryEngine } from "../src/engine.ts";
import { digest } from "../src/core.ts";
import { createRunExport } from "../src/export.ts";
import { GitHubTransport, GitHubUnavailable } from "../src/github.ts";
import { FileStateStore } from "../src/store.ts";
import type { DeliveryPolicy } from "../src/types.ts";

function localPolicy(): DeliveryPolicy {
  return {
    version: 1,
    delivery: { final_target: "main", publisher_id: 7 },
    branches: { default_parent: "main", plan_template: "delivery/plan-{issue}", implementation_template: "delivery/issue-{issue}" },
    eligibility: { required_labels: ["ready"], excluded_labels: ["blocked"] },
    approvals: { plan: { minimum: 1, reviewer_ids: [101] }, implementation: { minimum: 1, reviewer_ids: [101] } },
    _source: { ref: "refs/heads/main", sha: "a".repeat(40), digest: "b".repeat(64), fetched_at: new Date().toISOString() },
  };
}

test("HTTP date Retry-After is retained as a server deadline", async () => {
  const server = createServer((request, response) => {
    response.statusCode = 503; response.setHeader("retry-after", new Date(Date.now() + 600_000).toUTCString()); response.end("{}");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address(); assert(address && typeof address !== "string");
    const client = new GitHubTransport({ repo: "example/toolkit", token: "fixture", baseUrl: `http://127.0.0.1:${address.port}`, testOnly: true });
    await assert.rejects(() => client.object("GET", "/repos/example/toolkit"), (error: unknown) => {
      assert.ok(error instanceof GitHubUnavailable); assert.ok(error.retryAfterSeconds >= 598 && error.retryAfterSeconds <= 600); return true;
    });
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("script launchers are pinned by bytes and portable exports retain only their digests", () => {
  const root = mkdtempSync(join(tmpdir(), "delivery-launcher-pins-"));
  try {
    const script = join(root, "launcher.mjs"); writeFileSync(script, "console.log('original');\n");
    const locations = { executor_arg_1: script };
    const engine = new DeliveryEngine({ store: new FileStateStore(join(root, "state")), runtimeLocations: locations });
    const state = engine.start({ repo: "example/toolkit", issue: 42, deliveryId: "script-pinning", policy: localPolicy(), pinLocations: locations });
    const portable = createRunExport(state);
    assert.deepEqual((portable.identity.pins as Record<string, unknown>).artifacts, state.pins.artifacts);
    assert.equal(JSON.stringify(portable).includes(script), false);
    writeFileSync(script, "console.log('changed in place');\n");
    assert.throws(() => engine.acceptManifest(state.repo, state.delivery_id, {
      schema_version: 1, kind: "plan", delivery_id: state.delivery_id, repo: state.repo,
      result: { issue: 42, baseline: { repo: state.repo, ref: "main", sha: "a".repeat(40) }, plan_revision: "c".repeat(40), artifact_paths: ["plan.md"], artifact_hashes: { "plan.md": "d".repeat(64) } },
    }, state.revision), /pinned.*changed|artifact.*changed/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("separate CLI processes preserve dashboard controls, reject stale writes and validate portable exports", () => {
  const root = mkdtempSync(join(tmpdir(), "delivery-cli-journey-"));
  const repo = "example/toolkit", id = "operator-journey";
  const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const env = { ...process.env, DELIVERY_OPERATOR_GRANT: "local-journey-operator-grant" };
  const invoke = (command: string, args: string[] = []) => {
    const result = spawnSync(process.execPath, ["--experimental-strip-types", cliPath, command, "--state-dir", root, ...args], { env, encoding: "utf8", timeout: 10_000 });
    assert.equal(result.error, undefined);
    return { code: result.status, envelope: JSON.parse(result.stdout) };
  };
  const identity = ["--repo", repo, "--delivery-id", id];
  try {
    const engine = new DeliveryEngine({ store: new FileStateStore(root) });
    let state = engine.start({ repo, issue: 42, deliveryId: id, policy: localPolicy() });
    state = engine.acceptManifest(repo, id, {
      schema_version: 1, kind: "plan", delivery_id: id, repo,
      result: { issue: 42, baseline: { repo, ref: "main", sha: "a".repeat(40) }, plan_revision: "c".repeat(40), artifact_paths: ["docs/plan.md"], artifact_hashes: { "docs/plan.md": "d".repeat(64) } },
    }, state.revision);
    const listing = invoke("list");
    assert.equal(listing.code, 0);
    assert.equal(listing.envelope.data.runs[0].deliveryId, id);
    const status = invoke("status", identity);
    assert.equal(status.code, 0);
    const initial = status.envelope.data.runs[0];
    assert.equal(initial.currentRevision, "c".repeat(40));
    const paused = invoke("pause", [...identity, "--expected-revision", String(state.revision), "--request-id", "pause-journey-1"]);
    assert.equal(paused.code, 0);
    const pausedRevision = paused.envelope.data.revision;
    assert.ok(pausedRevision > state.revision);
    const stale = invoke("control-resume", [...identity, "--expected-revision", String(state.revision), "--request-id", "stale-journey-1"]);
    assert.notEqual(stale.code, 0);
    assert.equal(stale.envelope.error.code, "STALE_REVISION");
    const resumed = invoke("control-resume", [...identity, "--expected-revision", String(pausedRevision), "--request-id", "resume-journey-1"]);
    assert.equal(resumed.code, 0);
    assert.equal(resumed.envelope.data.paused, false);
    const output = join(root, "journey-export.json");
    assert.equal(invoke("export", [...identity, "--output", output]).code, 0);
    const inspect = spawnSync(process.execPath, ["--experimental-strip-types", cliPath, "inspect-export", "--input", output], { encoding: "utf8", timeout: 10_000 });
    assert.equal(inspect.status, 0);
    const exported = JSON.parse(readFileSync(output, "utf8"));
    assert.ok(!JSON.stringify(exported).includes(env.DELIVERY_OPERATOR_GRANT));
    exported.digest = "0".repeat(64); writeFileSync(output, JSON.stringify(exported));
    const corrupt = spawnSync(process.execPath, ["--experimental-strip-types", cliPath, "inspect-export", "--input", output], { encoding: "utf8", timeout: 10_000 });
    assert.notEqual(corrupt.status, 0);
    assert.equal(JSON.parse(corrupt.stdout).ok, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the real existing planning skill manifest preserves repository, ref and SHA", () => {
  const store = new FileStateStore(mkdtempSync(join(tmpdir(), "delivery-skill-contract-")));
  const engine = new DeliveryEngine({ store });
  const repo = "example/toolkit";
  const state = engine.start({ repo, issue: 42, deliveryId: "skill-parity", policy: localPolicy() });
  const baseline = { repo, ref: "main", sha: "a".repeat(40) };
  const manifest = {
    schema_version: 1, kind: "plan", delivery_id: state.delivery_id, repo,
    result: {
      issue: 42, baseline, base: baseline, plan_revision: "c".repeat(40),
      artifact_paths: ["docs/plans/issue-42.md"],
      artifact_hashes: { "docs/plans/issue-42.md": "d".repeat(64) },
    },
  };
  const accepted = engine.acceptManifest(repo, state.delivery_id, manifest, state.revision);
  assert.equal(accepted.status, "plan_review");
  assert.deepEqual(accepted.manifests.plan?.value.result.baseline, baseline);
  assert.deepEqual(accepted.manifests.plan?.value.result.base, baseline);
  assert.equal(store.read(repo, state.delivery_id).issue, 42);
});

test("no-candidate selection releases only its own claim", async () => {
  const store = new FileStateStore(mkdtempSync(join(tmpdir(), "delivery-rank-contract-")));
  const publisher = { async execute(packet: Record<string, unknown>) {
    return {
      schema_version: 1, action: "rank_snapshot", delivery_id: packet.delivery_id,
      operation_id: packet.operation_id, status: "snapshot", issues: [], open_prs: [], dependencies: [],
      coverage: { issues_complete: true, open_prs_complete: true, unresolved_count: 0 },
    };
  } };
  const engine = new DeliveryEngine({ store, publisher });
  let first = engine.start({ repo: "example/toolkit", deliveryId: "empty-backlog", policy: localPolicy() });
  first = await engine.refreshRankSnapshot(first.repo, first.delivery_id, first.revision);
  const completed = engine.acceptManifest(first.repo, first.delivery_id, {
    schema_version: 1, kind: "rank", delivery_id: first.delivery_id, repo: first.repo,
    result: { no_candidate: true, shortlist: [] },
  }, first.revision);
  assert.equal(completed.status, "completed");
  const next = engine.start({ repo: first.repo, deliveryId: "next-request", policy: localPolicy() });
  assert.equal(next.claim_status, "active");
  assert.equal(store.read(first.repo, first.delivery_id).status, "completed");
});

test("implementation publication waits for independently verified exact candidate", async () => {
  const root = mkdtempSync(join(tmpdir(), "delivery-publication-order-"));
  const candidate = "e".repeat(40), baseline = "a".repeat(40), repo = "example/toolkit", id = "publication-order";
  const calls: string[] = [];
  const publisher = { async execute(packet: Record<string, unknown>) {
    calls.push(String(packet.action)); const expected = packet.expected as Record<string, unknown>;
    return { schema_version: 1, action: packet.action, delivery_id: packet.delivery_id, operation_id: packet.operation_id, status: "published", pr: { number: calls.length, head_sha: expected.head_sha, base_sha: expected.base_sha } };
  } };
  const checker = { async verify() { return { status: "success", candidate_sha: candidate }; } };
  let reviewPacket: Record<string, any>;
  const reviewer = {
    async dispatch(packet: Record<string, unknown>) { reviewPacket = packet; return { execution_id: "independent-review", status: "completed", effect: "accepted", terminal: "completed", provider: "fixture", proof: { kind: "run_receipt", reference: "integration_review" }, result: { status: "approved", candidate_sha: candidate, delivery_id: id, task_id: packet.task_id, criteria_digest: (packet.criteria as Record<string, unknown>).criteria_digest } }; },
    async inspect() { return { execution_id: "independent-review", status: "completed", effect: "accepted", terminal: "completed", proof: { kind: "run_receipt", reference: "integration_review" }, result: { status: "approved", candidate_sha: candidate, delivery_id: id, task_id: reviewPacket.task_id, criteria_digest: reviewPacket.criteria.criteria_digest } }; },
    async collect() { return { execution_id: "independent-review", status: "completed", effect: "accepted", terminal: "completed", proof: { kind: "run_receipt", reference: "integration_review" }, result: { status: "approved", candidate_sha: candidate, delivery_id: id, task_id: reviewPacket.task_id, criteria_digest: reviewPacket.criteria.criteria_digest } }; },
    async cancel() { return { execution_id: "independent-review", status: "cancelled", effect: "accepted", terminal: "cancelled", proof: { kind: "run_receipt", reference: "integration_cancel" } }; },
    async resolveOutcomeProof(_outcome: unknown, context: unknown) { return { trusted: true, proof_digest: digest(context) }; },
  };
  try {
    const engine = new DeliveryEngine({ store: new FileStateStore(root), publisher, checker, reviewer });
    const p = localPolicy(); p.approvals.plan.minimum = 0; p.approvals.implementation.minimum = 0;
    let state = engine.start({ repo, issue: 42, deliveryId: id, policy: p, safeguards: { publication: { pr: "automatic" }, allowedPaths: { plan: ["plan.md"], implementation: ["src/change.ts"] } } });
    const handoff = (sha: string, paths: string[]) => ({ expected: { head: `delivery/${paths[0] === "plan.md" ? "plan" : "implementation"}`, base: "main", head_sha: sha, base_sha: baseline, previous_sha: null }, payload: { title: "Fixture", body: "Fixture body", bundle: "/private/tmp/fixture.bundle", allowed_paths: paths } });
    state = engine.acceptManifest(repo, id, { schema_version: 1, kind: "plan", delivery_id: id, repo, result: { issue: 42, plan_revision: "c".repeat(40), baseline: { repo, ref: "main", sha: baseline }, artifact_paths: ["plan.md"], artifact_hashes: { "plan.md": "d".repeat(64) } } }, state.revision);
    state = engine.stageHandoff(repo, id, "plan", handoff("c".repeat(40), ["plan.md"]), state.revision);
    state = await engine.publishStage(repo, id, "plan", state.revision, state.handoffs.plan!.digest);
    state = engine.acceptManifest(repo, id, { schema_version: 1, kind: "implement", delivery_id: id, repo, result: { issue: 42, candidate_sha: candidate, base: { repo, ref: "main", sha: baseline }, artifact_paths: ["src/change.ts"], verification: ["agent claims tests pass"] } }, state.revision);
    // This seam test supplies a fixture producer; the foreground journey exercises real collect stamping.
    state = engine.store.mutate(repo, id, state.revision, (next) => {
      next.manifests.implement!.producer_execution_id = "fixture-implementation-task";
      next.manifests.implement!.producer_identity = "agent:fixture:fixture-implementation";
      next.executions.push({ id: "fixture-implementation-task", kind: "agent", stage: "implement", status: "completed", provider: "fixture", external_id: "fixture-implementation", started_at: new Date().toISOString() });
      return next;
    });
    state = engine.stageHandoff(repo, id, "implementation", handoff(candidate, ["src/change.ts"]), state.revision);
    await assert.rejects(() => engine.publishStage(repo, id, "implementation", state.revision, state.handoffs.implementation!.digest), /engineering verification/i);
    assert.deepEqual(calls, ["publish_plan"]);
    state = await engine.verifyCandidate(repo, id, state.revision);
    assert.equal(state.receipts.engineering?.candidate_sha, candidate);
    state = await engine.publishStage(repo, id, "implementation", state.revision, state.handoffs.implementation!.digest);
    assert.deepEqual(calls, ["publish_plan", "publish_implementation"]);
    assert.equal(state.status, "publication_pending");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
