import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { RequestListener } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { digest } from "../src/core.ts";
import { DeliveryEngine } from "../src/engine.ts";
import { GitHubTransport } from "../src/github.ts";
import { Publisher } from "../src/publisher.ts";
import { FileStateStore } from "../src/store.ts";
import type { DeliveryState } from "../src/types.ts";
import { policy } from "./helpers.ts";

const candidateSha = "5".repeat(40);
const baselineSha = "4".repeat(40);

function issue(number: number, state: "open" | "closed", body = "") {
  return { number, id: 100 + number, node_id: `I_${number}`, title: `Issue ${number}`, body, state, labels: [], user: { id: 8, login: "author", type: "User" }, assignees: [], milestone: null,
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-02T00:00:00Z", html_url: `https://github.com/acme/tool/issues/${number}` };
}

async function listen(handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert(address && typeof address !== "string");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

function publisher(baseUrl: string, stateRoot = mkdtempSync(join(tmpdir(), "reader-publisher-"))) {
  return new Publisher({ repo: "acme/tool", repositoryId: 42, login: "developer", actorId: 7, stateRoot,
    remoteUrl: "https://github.com/acme/tool.git", tokenResolver: async () => "fixture-token", transportBaseUrl: baseUrl, testOnly: true });
}

test("real rank snapshot normalization drives actual engine eligibility", async () => {
  const rows = [
    issue(1, "open"),
    issue(2, "open", "Blocks #4"),
    issue(3, "closed"),
    issue(4, "open"),
    issue(5, "open", "Blocked by #3"),
    issue(6, "open", "Requires #99"),
    issue(7, "open", "Depends on other/repo#1"),
    issue(8, "open", "Blocked by #9"),
    issue(9, "open", "Blocked by #8"),
    issue(10, "open", "Blocked by acme/tool#2"),
  ];
  const { server, baseUrl } = await listen((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/user") return response.end(JSON.stringify({ id: 7, login: "developer", type: "User" }));
    if (request.url === "/repos/acme/tool") return response.end(JSON.stringify({ id: 42, full_name: "acme/tool", private: false, default_branch: "main" }));
    if (request.url?.startsWith("/repos/acme/tool/issues?")) return response.end(JSON.stringify(rows));
    if (request.url?.startsWith("/repos/acme/tool/pulls?")) return response.end("[]");
    response.statusCode = 404; response.end("{}");
  });
  try {
    const sharedPublisher = publisher(baseUrl);
    const select = async (number: number, accepted: boolean) => {
      const store = new FileStateStore(mkdtempSync(join(tmpdir(), `rank-select-${number}-`)));
      const engine = new DeliveryEngine({ store, publisher: sharedPublisher });
      let state = engine.start({ repo: "acme/tool", deliveryId: `rank-select-${number}`, policy: policy() });
      state = await engine.refreshRankSnapshot(state.repo, state.delivery_id, state.revision);
      const manifest = { schema_version: 1, kind: "rank", repo: state.repo, delivery_id: state.delivery_id, result: { winner: number, shortlist: [number] } };
      if (accepted) assert.equal(engine.acceptManifest(state.repo, state.delivery_id, manifest, state.revision).issue, number);
      else assert.throws(() => engine.acceptManifest(state.repo, state.delivery_id, manifest, state.revision), /dependencies are blocked or unresolved/);
    };
    await select(1, true); // independent
    await select(4, false); // reverse Blocks edge from #2
    await select(5, true); // closed prerequisite is resolved
    await select(6, false); // missing prerequisite is unknown
    await select(7, false); // foreign prerequisite is unknown
    await select(8, false); await select(9, false); // cycle is blocked
    await select(10, false); // same-repository qualified prerequisite
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

function readinessState(store: FileStateStore, engine: DeliveryEngine, id: string): DeliveryState {
  let state = engine.start({ repo: "acme/tool", issue: 1, deliveryId: id, policy: policy(), safeguards: { publication: { pr: "automatic" }, allowedPaths: { implementation: ["src/change.ts"] } } });
  const manifest = { schema_version: 1 as const, kind: "implement" as const, delivery_id: id, repo: "acme/tool",
    result: { issue: 1, candidate_sha: candidateSha, base: { repo: "acme/tool", ref: "main", sha: baselineSha }, artifact_paths: ["src/change.ts"], verification: { tests: ["focused"] } } };
  return store.mutate(state.repo, state.delivery_id, state.revision, (next) => {
    const expected = { head: "delivery/implementation", head_sha: candidateSha, base: "main", base_sha: baselineSha, previous_sha: null };
    const payload = { title: "Implementation", body: "Exact body", bundle: "/tmp/implementation.bundle", allowed_paths: ["src/change.ts"] };
    const checks = { status: "success", candidate_sha: candidateSha, manifest_digest: digest(manifest) };
    next.status = "tracking_pending"; next.manifests.implement = { digest: digest(manifest), material_digest: "b".repeat(64), generation: 1, value: manifest, accepted_at: new Date().toISOString() };
    next.handoffs.implementation = { digest: digest({ expected, payload, generation: 1 }), generation: 1, expected, payload, staged_at: new Date().toISOString() };
    next.publication.implementation = { status: "published", pr: { number: 21, head_sha: candidateSha, base_sha: baselineSha } };
    next.receipts.checks = checks; next.receipts.engineering = { candidate_sha: candidateSha, producer_execution_id: "producer-task", producer_identity: "fixture:producer", checker: checks,
      review: { status: "approved", candidate_sha: candidateSha, reviewer_identity: "fixture:reviewer" } };
    return next;
  });
}

test("complete exact-head check-run transport controls finalization and claim release", async () => {
  type Mode = "success" | "pending" | "failure" | "truncated" | "malformed" | "head-drift" | "total-drift" | "duplicate" | "cycle" | "query-drift" | "page-error" | "invalid-status";
  let mode: Mode = "success";
  const { server, baseUrl } = await listen((request, response) => {
    response.setHeader("content-type", "application/json");
    const url = new URL(request.url!, "http://fixture.invalid");
    if (url.pathname === "/user") return response.end(JSON.stringify({ id: 7, login: "developer", type: "User" }));
    if (url.pathname === "/repos/acme/tool") return response.end(JSON.stringify({ id: 42, full_name: "acme/tool", private: false }));
    if (url.pathname === "/repos/acme/tool/pulls/21") return response.end(JSON.stringify({ number: 21, node_id: "PR_21", html_url: "https://github.com/acme/tool/pull/21", state: "open", draft: false, title: "Implementation", body: "Exact body", labels: [{ name: "delivery-review" }], user: { id: 7, login: "developer" }, head: { ref: "delivery/implementation", sha: candidateSha, repo: { id: 42 } }, base: { ref: "main", sha: baselineSha, repo: { id: 42 } } }));
    if (url.pathname.endsWith("/check-runs")) {
      assert.equal(url.searchParams.get("filter"), "latest"); assert.equal(url.searchParams.get("per_page"), "100");
      if (url.searchParams.get("page") === "2") {
        if (mode === "page-error") { response.statusCode = 503; response.setHeader("retry-after", "600"); return response.end("{}"); }
        if (mode === "malformed") return response.end(JSON.stringify({ total_count: 2 }));
        if (mode === "cycle") response.setHeader("link", `<${baseUrl}${url.pathname}?filter=latest&per_page=100&page=2>; rel="next"`);
        return response.end(JSON.stringify({ total_count: mode === "total-drift" ? 3 : 2, check_runs: [{ id: mode === "duplicate" ? 1 : 2, name: "second",
          status: mode === "pending" ? "in_progress" : mode === "invalid-status" ? "mystery" : "completed",
          conclusion: mode === "pending" ? null : mode === "failure" ? "failure" : "success", head_sha: mode === "head-drift" ? "6".repeat(40) : candidateSha }] }));
      }
      if (mode !== "truncated") response.setHeader("link", `<${baseUrl}${url.pathname}?filter=${mode === "query-drift" ? "all" : "latest"}&per_page=100&page=2>; rel="next"`);
      return response.end(JSON.stringify({ total_count: 2, check_runs: [{ id: 1, name: "first", status: "completed", conclusion: "success", head_sha: candidateSha }] }));
    }
    if (url.pathname.endsWith("/status")) return response.end(JSON.stringify({ state: "success", sha: candidateSha, total_count: 1, statuses: [{ id: 3 }] }));
    response.statusCode = 404; response.end("{}");
  });
  try {
    for (const expected of ["success", "pending", "failure", "truncated", "malformed", "head-drift", "total-drift", "duplicate", "cycle", "query-drift", "page-error", "invalid-status"] as const) {
      mode = expected; const store = new FileStateStore(mkdtempSync(join(tmpdir(), `checks-${expected}-`))); const engine = new DeliveryEngine({ store, publisher: publisher(baseUrl) });
      const before = readinessState(store, engine, `checks-${expected}`);
      if (!["success", "pending", "failure"].includes(expected)) {
        await assert.rejects(() => engine.recheckReady(before.repo, before.delivery_id, before.revision, `readback-${expected}`));
        const held = store.read(before.repo, before.delivery_id); assert.equal(held.claim_status, "active"); assert.equal(held.status, "tracking_pending");
      } else {
        const after = await engine.recheckReady(before.repo, before.delivery_id, before.revision, `readback-${expected}`);
        assert.equal(after.status, expected === "success" ? "review_ready" : expected === "failure" ? "pre_ready_ci_blocked" : "pre_ready_ci_waiting");
        assert.equal(after.claim_status, expected === "success" ? "released" : "active");
        assert.equal(((after.publication.final?.ci as Record<string, unknown>).check_runs as unknown[]).length, 2);
      }
    }
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("check-run envelope pagination obeys the configured page bound", async () => {
  const { server, baseUrl } = await listen((request, response) => {
    response.setHeader("content-type", "application/json");
    response.setHeader("link", `<${baseUrl}/repos/acme/tool/commits/${candidateSha}/check-runs?filter=latest&per_page=100&page=2>; rel="next"`);
    response.end(JSON.stringify({ total_count: 2, check_runs: [{ id: 1, name: "first", status: "completed", conclusion: "success", head_sha: candidateSha }] }));
  });
  try {
    const client = new GitHubTransport({ repo: "acme/tool", token: "fixture-token", baseUrl, testOnly: true, maxPages: 1 });
    await assert.rejects(() => client.checkRuns(`/repos/acme/tool/commits/${candidateSha}/check-runs`, candidateSha), /page limit/);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
