import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";
import { GitHubTransport, resolveGhToken } from "../src/github.ts";
import { DeliveryEngine } from "../src/engine.ts";
import { Publisher, publicationAuthorizationDigest } from "../src/publisher.ts";
import { FileStateStore } from "../src/store.ts";
import { TrustedGit } from "../src/trusted-git.ts";
import type { JsonObject } from "../src/types.ts";
import { policy } from "./helpers.ts";

function git(cwd: string, ...args: string[]): string { return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" } }).trim(); }

async function fixtureGit(): Promise<{ root: string; remote: string; work: string; base: string; candidate: string; bundle: string }> {
  const root = await mkdtemp(join(tmpdir(), "delivery-publisher-")); const remote = join(root, "remote.git"); const work = join(root, "work");
  mkdirSync(work); git(root, "init", "--bare", remote); git(work, "init");
  writeFileSync(join(work, "README.md"), "base\n"); git(work, "add", "README.md"); git(work, "commit", "-m", "base"); const base = git(work, "rev-parse", "HEAD");
  git(work, "remote", "add", "origin", remote); git(work, "push", "origin", `${base}:refs/heads/main`);
  writeFileSync(join(work, "README.md"), "candidate\n"); git(work, "commit", "-am", "candidate"); const candidate = git(work, "rev-parse", "HEAD");
  git(work, "branch", "candidate-bundle", candidate); const bundle = join(root, "candidate.bundle"); git(work, "bundle", "create", bundle, "candidate-bundle"); chmodSync(bundle, 0o600);
  return { root, remote, work, base, candidate, bundle };
}

test("trusted Git imports exact history, enforces path allowlist, and lease-pushes", async () => {
  const fixture = await fixtureGit(); const trusted = new TrustedGit({ root: join(fixture.root, "trusted"), remoteUrl: fixture.remote, allowLocalRemote: true });
  await trusted.open();
  try {
    await trusted.fetchBase("main", fixture.base); await trusted.importCandidate(fixture.bundle, fixture.candidate);
    await trusted.verifyCandidate(fixture.base, fixture.candidate, ["README.md"]);
    await assert.rejects(() => trusted.verifyCandidate(fixture.base, fixture.candidate, ["docs"]), /outside allowlist/);
    assert.equal(await trusted.remoteHead("delivery/test"), null); await trusted.push("delivery/test", fixture.candidate, null);
    assert.equal(await trusted.remoteHead("delivery/test"), fixture.candidate);
    await assert.rejects(() => trusted.push("delivery/test", fixture.base, null), /changed before push/);
    git(fixture.work, "checkout", "-b", "unsafe-history", fixture.base);
    execFileSync("ln", ["-s", "README.md", join(fixture.work, "link")]); git(fixture.work, "add", "link"); git(fixture.work, "commit", "-m", "unsafe intermediate symlink");
    execFileSync("rm", [join(fixture.work, "link")]); writeFileSync(join(fixture.work, "link"), "safe final file\n"); git(fixture.work, "add", "link"); git(fixture.work, "commit", "-m", "hide unsafe entry");
    const unsafe = git(fixture.work, "rev-parse", "HEAD"), unsafeBundle = join(fixture.root, "unsafe.bundle"); git(fixture.work, "bundle", "create", unsafeBundle, "unsafe-history"); chmodSync(unsafeBundle, 0o600);
    await trusted.importCandidate(unsafeBundle, unsafe);
    await assert.rejects(() => trusted.verifyCandidate(fixture.base, unsafe, ["link"]), /history contains unsafe tree entry/);
  } finally { await trusted.close(); await rm(fixture.root, { recursive: true, force: true }); }
});

test("GitHub transport rejects non-allowlisted operations and cross-origin pagination", async () => {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.setHeader("link", `<https://example.invalid/repos/acme/tool/issues?page=2>; rel="next"`);
    response.end("[]");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert(address && typeof address !== "string");
  const client = new GitHubTransport({ repo: "acme/tool", token: "fixture-token", baseUrl: `http://127.0.0.1:${address.port}`, testOnly: true });
  await assert.rejects(() => client.object("POST", "/repos/acme/tool/pulls/1/merge", {}), /outside.*allowlist/);
  await assert.rejects(() => client.pages("/repos/acme/tool/issues", { state: "all" }), /pagination escaped/);
  server.close();
});

test("GitHub transport bounds streaming bodies and keeps the deadline through body read", async () => {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url?.includes("slow")) { response.write("["); setTimeout(() => response.end("]"), 250); return; }
    response.write(JSON.stringify({ value: "0123456789abcdef" })); response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); assert(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const slow = new GitHubTransport({ repo: "acme/tool", token: "fixture-token", baseUrl, testOnly: true, timeoutMs: 40 });
  await assert.rejects(() => slow.pages("/repos/acme/tool/issues", { state: "slow" }), /request failed/);
  const bounded = new GitHubTransport({ repo: "acme/tool", token: "fixture-token", baseUrl, testOnly: true, maxResponseBytes: 8 });
  await assert.rejects(() => bounded.object("GET", "/repos/acme/tool"), /exceeds size limit/);
  server.close();
});

test("selected gh account preserves custom config but scrubs ambient tokens", async () => {
  const root = await mkdtemp(join(tmpdir(), "delivery-gh-")), gh = join(root, "gh-fixture.mjs"), record = join(root, "record.json"), config = join(root, "gh-config");
  writeFileSync(gh, `#!/usr/bin/env node\nimport{writeFileSync}from'node:fs';const a=process.argv.slice(2);if(a.includes('--help')){process.stdout.write('--user --no-refresh');}else{writeFileSync(${JSON.stringify(record)},JSON.stringify({args:a,config:process.env.GH_CONFIG_DIR,gh:process.env.GH_TOKEN,github:process.env.GITHUB_TOKEN}));process.stdout.write('selected-token');}\n`); chmodSync(gh, 0o700);
  const oldConfig = process.env.GH_CONFIG_DIR, oldGh = process.env.GH_TOKEN, oldGitHub = process.env.GITHUB_TOKEN;
  process.env.GH_CONFIG_DIR = config; process.env.GH_TOKEN = "ambient-gh"; process.env.GITHUB_TOKEN = "ambient-github";
  try {
    assert.equal(await resolveGhToken({ login: "developer", ghPath: gh }), "selected-token");
    const observed = JSON.parse(readFileSync(record, "utf8"));
    assert.deepEqual(observed.args, ["auth", "token", "--hostname", "github.com", "--user", "developer", "--no-refresh"]); assert.equal(observed.config, config); assert.equal(observed.gh, undefined); assert.equal(observed.github, undefined);
  } finally {
    if (oldConfig === undefined) delete process.env.GH_CONFIG_DIR; else process.env.GH_CONFIG_DIR = oldConfig;
    if (oldGh === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = oldGh;
    if (oldGitHub === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = oldGitHub;
    await rm(root, { recursive: true, force: true });
  }
});

test("publisher recovers a lost issue-create response without duplicate POST", async () => {
  const root = await mkdtemp(join(tmpdir(), "delivery-issue-")); let posts = 0; let issue: Record<string, unknown> | null = null;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://fixture"); response.setHeader("content-type", "application/json");
    if (url.pathname === "/user") return response.end(JSON.stringify({ id: 7, login: "developer", type: "User" }));
    if (url.pathname === "/repos/acme/tool") return response.end(JSON.stringify({ id: 42, full_name: "acme/tool", private: false }));
    if (url.pathname === "/repos/acme/tool/issues" && request.method === "GET") return response.end(JSON.stringify(issue ? [issue] : []));
    if (url.pathname === "/repos/acme/tool/issues" && request.method === "POST") {
      posts += 1; let raw = ""; for await (const part of request) raw += part; const body = JSON.parse(raw);
      issue = { id: 99, node_id: "I_99", number: 3, title: body.title, body: body.body, repository_url: "https://api.github.com/repos/acme/tool", url: "https://api.github.com/repos/acme/tool/issues/3", html_url: "https://github.com/acme/tool/issues/3", user: { id: 7, login: "developer", type: "User" } };
      request.socket.destroy(); return;
    }
    if (url.pathname === "/repos/acme/tool/issues/3") return response.end(JSON.stringify(issue));
    response.statusCode = 404; response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); assert(address && typeof address !== "string");
  const publisher = new Publisher({ repo: "acme/tool", repositoryId: 42, login: "developer", actorId: 7, stateRoot: root, remoteUrl: "https://github.com/acme/tool.git", tokenResolver: async () => "fixture-token", transportBaseUrl: `http://127.0.0.1:${address.port}`, testOnly: true });
  const packet: Record<string, unknown> = { schema_version: 1, action: "publish_issue", repo: "acme/tool", delivery_id: "draft-1", operation_id: "issue-op", expected_revision: 1, payload: { title: "A bounded issue", body: "Reviewed body" } };
  packet.authorized_digest = publicationAuthorizationDigest(packet);
  const first = await publisher.execute(packet); const second = await publisher.execute(packet);
  assert.equal(first.status, "published"); assert.deepEqual(second.issue, first.issue); assert.equal(posts, 1);
  server.close(); await rm(root, { recursive: true, force: true });
});

test("publisher pushes exact candidate and creates only an open draft PR", async () => {
  const fixture = await fixtureGit(); let posts = 0, tokenResolutions = 0; let pull: Record<string, unknown> | null = null;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://fixture"); response.setHeader("content-type", "application/json");
    if (url.pathname === "/user") return response.end(JSON.stringify({ id: 7, login: "developer", type: "User" }));
    if (url.pathname === "/repos/acme/tool") return response.end(JSON.stringify({ id: 42, full_name: "acme/tool", private: false }));
    if (url.pathname === "/repos/acme/tool/pulls" && request.method === "GET") return response.end(JSON.stringify(pull ? [pull] : []));
    if (url.pathname === "/repos/acme/tool/pulls" && request.method === "POST") {
      posts += 1; let raw = ""; for await (const part of request) raw += part; const body = JSON.parse(raw);
      pull = { number: 8, node_id: "PR_8", html_url: "https://github.com/acme/tool/pull/8", state: "open", draft: body.draft, title: body.title, body: body.body, user: { id: 7, login: "developer" }, head: { ref: body.head, sha: fixture.candidate, repo: { id: 42 } }, base: { ref: body.base, sha: fixture.base, repo: { id: 42 } } };
      return response.end(JSON.stringify(pull));
    }
    if (url.pathname === "/repos/acme/tool/pulls/8") return response.end(JSON.stringify(pull));
    response.statusCode = 404; response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); assert(address && typeof address !== "string");
  const publisher = new Publisher({ repo: "acme/tool", repositoryId: 42, login: "developer", actorId: 7, stateRoot: join(fixture.root, "state"), remoteUrl: fixture.remote, allowLocalRemote: true, tokenResolver: async () => { tokenResolutions += 1; return "fixture-token"; }, transportBaseUrl: `http://127.0.0.1:${address.port}`, testOnly: true });
  const packet: Record<string, unknown> = { schema_version: 1, action: "publish_plan", repo: "acme/tool", delivery_id: "delivery-1", operation_id: "pr-op", expected_revision: 2,
    expected: { head: "delivery/plan", head_sha: fixture.candidate, base: "main", base_sha: fixture.base, previous_sha: null },
    payload: { title: "docs: plan issue #1", body: "Exact reviewed plan", bundle: fixture.bundle, allowed_paths: ["README.md"] } };
  packet.authorized_digest = publicationAuthorizationDigest(packet);
  const result = await publisher.execute(packet); assert.equal(result.status, "published"); assert.equal((result.pr as Record<string, unknown>).draft, true); assert.equal(posts, 1); assert.equal(tokenResolutions, 1);
  const readback = await publisher.inspectPublication(packet as JsonObject); assert.equal(readback.status, "completed"); assert.deepEqual(readback.receipt?.pr, result.pr);
  assert.equal(posts, 1);
  assert.equal(git(fixture.root, "--git-dir", fixture.remote, "rev-parse", "refs/heads/delivery/plan"), fixture.candidate);
  server.close(); await rm(fixture.root, { recursive: true, force: true });
});

test("engine replay reads the concrete publisher journal after a lost PR result without another push or POST", async () => {
  const fixture = await fixtureGit(); let posts = 0, writes = 0; let pull: Record<string, unknown> | null = null;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://fixture"); response.setHeader("content-type", "application/json");
    if (request.method !== "GET") writes += 1;
    if (url.pathname === "/user") return response.end(JSON.stringify({ id: 7, login: "developer", type: "User" }));
    if (url.pathname === "/repos/acme/tool") return response.end(JSON.stringify({ id: 42, full_name: "acme/tool", private: false }));
    if (url.pathname === "/repos/acme/tool/pulls" && request.method === "GET") return response.end(JSON.stringify(pull ? [pull] : []));
    if (url.pathname === "/repos/acme/tool/pulls" && request.method === "POST") {
      posts += 1; let raw = ""; for await (const part of request) raw += part; const body = JSON.parse(raw);
      pull = { number: 18, node_id: "PR_18", html_url: "https://github.com/acme/tool/pull/18", state: "open", draft: body.draft, title: body.title, body: body.body,
        user: { id: 7, login: "developer" }, head: { ref: body.head, sha: fixture.candidate, repo: { id: 42 } }, base: { ref: body.base, sha: fixture.base, repo: { id: 42 } } };
      return response.end(JSON.stringify(pull));
    }
    if (url.pathname === "/repos/acme/tool/pulls/18") return response.end(JSON.stringify(pull));
    response.statusCode = 404; response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); assert(address && typeof address !== "string");
  class LostResultPublisher extends Publisher {
    executions = 0;
    override async execute(packet: Record<string, unknown>): Promise<Record<string, unknown>> {
      this.executions += 1; await super.execute(packet); throw new Error("simulated engine process loss after publisher journal commit");
    }
  }
  const stateRoot = join(fixture.root, "state"), store = new FileStateStore(join(fixture.root, "engine"));
  const publisher = new LostResultPublisher({ repo: "acme/tool", repositoryId: 42, login: "developer", actorId: 7, stateRoot, remoteUrl: fixture.remote, allowLocalRemote: true,
    tokenResolver: async () => "fixture-token", transportBaseUrl: `http://127.0.0.1:${address.port}`, testOnly: true });
  const engine = new DeliveryEngine({ store, publisher, controlGrant: { token: "grant", repositories: ["acme/tool"], actions: ["publish_plan"] } });
  let state = engine.start({ repo: "acme/tool", issue: 1, deliveryId: "lost-pr-result", policy: policy(), safeguards: { publication: { pr: "explicit" }, allowedPaths: { plan: ["README.md"] } } });
  state = engine.acceptManifest(state.repo, state.delivery_id, { schema_version: 1, kind: "plan", delivery_id: state.delivery_id, repo: state.repo,
    result: { issue: 1, plan_revision: fixture.candidate, baseline: { repo: state.repo, ref: "main", sha: fixture.base }, artifact_paths: ["README.md"], artifact_hashes: { "README.md": "a".repeat(64) } } }, state.revision);
  state = engine.stageHandoff(state.repo, state.delivery_id, "plan", { expected: { head: "delivery/lost-result", head_sha: fixture.candidate, base: "main", base_sha: fixture.base, previous_sha: null },
    payload: { title: "docs: exact plan", body: "Exact reviewed plan", bundle: fixture.bundle, allowed_paths: ["README.md"] } }, state.revision);
  const input = { repo: state.repo, deliveryId: state.delivery_id, expectedRevision: state.revision, action: "publish_plan" as const, requestId: "lost_result_concrete_001", grant: "grant", draftDigest: state.handoffs.plan!.digest };
  assert.equal((await engine.control(input)).status, "blocked");
  assert.equal((await engine.control(input)).status, "implementation_required");
  assert.equal(publisher.executions, 1); assert.equal(posts, 1); assert.equal(writes, 1);
  assert.equal(git(fixture.root, "--git-dir", fixture.remote, "rev-parse", "refs/heads/delivery/lost-result"), fixture.candidate);
  state = store.read(state.repo, state.delivery_id); assert.equal(state.operations.at(-1)?.status, "completed"); assert.equal(state.controls.requests[input.requestId]?.status, "completed");
  server.close(); await rm(fixture.root, { recursive: true, force: true });
});

test("manual publication binding is read-only and requires exact draft identity", async () => {
  const fixture = await fixtureGit(), root = join(fixture.root, "state"); let writes = 0;
  const sha = fixture.candidate, baseSha = fixture.base;
  const pr = { number: 11, node_id: "PR_11", html_url: "https://github.com/acme/tool/pull/11", state: "open", draft: true,
    title: "Exact title", body: "Exact body", user: { id: 7, login: "developer" },
    head: { ref: "delivery/manual", sha, repo: { id: 42 } }, base: { ref: "main", sha: baseSha, repo: { id: 42 } } };
  const server = createServer((request, response) => {
    if (request.method !== "GET") writes += 1; response.setHeader("content-type", "application/json");
    if (request.url === "/user") return response.end(JSON.stringify({ id: 7, login: "developer", type: "User" }));
    if (request.url === "/repos/acme/tool") return response.end(JSON.stringify({ id: 42, full_name: "acme/tool", private: false }));
    if (request.url === "/repos/acme/tool/pulls/11") return response.end(JSON.stringify(pr));
    response.statusCode = 404; response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); assert(address && typeof address !== "string");
  const publisher = new Publisher({ repo: "acme/tool", repositoryId: 42, login: "developer", actorId: 7, stateRoot: root, remoteUrl: fixture.remote, allowLocalRemote: true, tokenResolver: async () => "fixture-token", transportBaseUrl: `http://127.0.0.1:${address.port}`, testOnly: true });
  const exportPacket = { schema_version: 1, action: "export_handoff", repo: "acme/tool", delivery_id: "manual-1", operation_id: "export-1",
    expected: { head: "delivery/manual", head_sha: sha, base: "main", base_sha: baseSha }, payload: { title: "Exact title", body: "Exact body", bundle: fixture.bundle, allowed_paths: ["README.md"] } };
  const exportResult = await publisher.execute(exportPacket);
  const bindPacket = { schema_version: 1, action: "bind_manual_pr", repo: "acme/tool", delivery_id: "manual-1", operation_id: "bind-1",
    expected: { head: "delivery/manual", head_sha: sha, base: "main", base_sha: baseSha }, payload: { number: 11, title: "Exact title", body: "Exact body" } };
  const result = await publisher.execute(bindPacket);
  assert.equal(result.status, "bound"); assert.equal((result.evidence as Record<string, unknown>).writes, 0); assert.equal(writes, 0);
  assert.deepEqual(await publisher.inspectPublication(exportPacket), { status: "completed", operation_id: "export-1", request_digest: publicationAuthorizationDigest(exportPacket), receipt: exportResult });
  assert.deepEqual(await publisher.inspectPublication(bindPacket), { status: "completed", operation_id: "bind-1", request_digest: publicationAuthorizationDigest(bindPacket), receipt: result });
  assert.equal(writes, 0);
  server.close(); await rm(fixture.root, { recursive: true, force: true });
});

test("finalize blocks ready and tracking transitions before their engine checkpoints", async () => {
  const root = await mkdtemp(join(tmpdir(), "delivery-finalize-")); const sha = "c".repeat(40); let labels: unknown[] = [];
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/user") return response.end(JSON.stringify({ id: 7, login: "developer", type: "User" }));
    if (request.url === "/repos/acme/tool") return response.end(JSON.stringify({ id: 42, full_name: "acme/tool", private: false }));
    if (request.url === "/repos/acme/tool/pulls/12") return response.end(JSON.stringify({ number: 12, node_id: "PR_12", html_url: "https://github.com/acme/tool/pull/12", state: "open", draft: false, title: "T", body: "B", labels, user: { id: 7, login: "developer" }, head: { ref: "delivery/x", sha, repo: { id: 42 } }, base: { ref: "main", sha: "d".repeat(40), repo: { id: 42 } } }));
    if (request.url === `/repos/acme/tool/commits/${sha}/check-runs?filter=latest&per_page=100`) return response.end(JSON.stringify({ total_count: 1, check_runs: [{ id: 1, name: "test", status: "completed", conclusion: "success", head_sha: sha }] }));
    if (request.url === `/repos/acme/tool/commits/${sha}/status`) return response.end(JSON.stringify({ state: "success", statuses: [{ id: 2 }] }));
    response.statusCode = 404; response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); assert(address && typeof address !== "string");
  const publisher = new Publisher({ repo: "acme/tool", repositoryId: 42, login: "developer", actorId: 7, stateRoot: root, remoteUrl: "https://github.com/acme/tool.git", tokenResolver: async () => "fixture-token", transportBaseUrl: `http://127.0.0.1:${address.port}`, testOnly: true });
  const common = { schema_version: 1, action: "finalize", repo: "acme/tool", delivery_id: "final-1", operation_id: "finalize-1",
    expected: { head: "delivery/x", head_sha: sha, base: "main", base_sha: "d".repeat(40), title: "T", body: "B" } };
  await assert.rejects(() => publisher.execute({ ...common, payload: { number: 12, head_sha: sha, checkpoint: "ci_observed", tracking_label: "review" } }), /marked ready before/);
  const tracking = await publisher.execute({ ...common, payload: { number: 12, head_sha: sha, checkpoint: "ready_requested", tracking_label: "review" } }); assert.equal(tracking.status, "tracking_pending");
  labels = [{ name: "review" }];
  await assert.rejects(() => publisher.execute({ ...common, payload: { number: 12, head_sha: sha, checkpoint: "ready_requested", tracking_label: "review" } }), /label was applied before/);
  const readyPacket = { ...common, payload: { number: 12, head_sha: sha, checkpoint: "tracking_requested", tracking_label: "review" } };
  const ready = await publisher.execute(readyPacket); assert.equal(ready.status, "review_ready");
  assert.deepEqual(await publisher.inspectPublication(readyPacket), { status: "completed", operation_id: "finalize-1", request_digest: publicationAuthorizationDigest(readyPacket), receipt: ready });
  server.close(); await rm(root, { recursive: true, force: true });
});

test("rank snapshot is complete, selected-identity bound, and exposes dependency coverage", async () => {
  const root = await mkdtemp(join(tmpdir(), "delivery-rank-"));
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/user") return response.end(JSON.stringify({ id: 7, login: "developer", type: "User" }));
    if (request.url === "/repos/acme/tool") return response.end(JSON.stringify({ id: 42, full_name: "acme/tool", private: false, default_branch: "main" }));
    if (request.url?.startsWith("/repos/acme/tool/issues?")) return response.end(JSON.stringify([
      { number: 4, id: 104, node_id: "I_4", title: "Work", body: "Blocked by #2\nRelated to other/repo#9", state: "open", labels: [{ id: 1, name: "ready" }], user: { id: 8, login: "author", type: "User" }, assignees: [], milestone: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-02T00:00:00Z", html_url: "https://github.com/acme/tool/issues/4" },
      { number: 2, id: 102, node_id: "I_2", title: "Prerequisite", body: "", state: "open", labels: [], user: { id: 8, login: "author", type: "User" }, assignees: [], milestone: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-02T00:00:00Z", html_url: "https://github.com/acme/tool/issues/2" },
    ]));
    if (request.url?.startsWith("/repos/acme/tool/pulls?")) return response.end(JSON.stringify([{ number: 5, id: 205, node_id: "PR_5", title: "Overlap", body: "Touches work", state: "open", draft: true, labels: [], user: { id: 9, login: "contributor", type: "User" }, head: { ref: "feature", sha: "a".repeat(40), repo: { id: 42 } }, base: { ref: "main", sha: "b".repeat(40), repo: { id: 42 } }, html_url: "https://github.com/acme/tool/pull/5" }]));
    response.statusCode = 404; response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); assert(address && typeof address !== "string");
  const publisher = new Publisher({ repo: "acme/tool", repositoryId: 42, login: "developer", actorId: 7, stateRoot: root, remoteUrl: "https://github.com/acme/tool.git", tokenResolver: async () => "fixture-token", transportBaseUrl: `http://127.0.0.1:${address.port}`, testOnly: true });
  const result = await publisher.execute({ schema_version: 1, action: "rank_snapshot", repo: "acme/tool", delivery_id: "rank-1", operation_id: "snapshot-1" });
  assert.equal(result.status, "snapshot"); assert.equal((result.issues as unknown[]).length, 2); assert.equal((result.open_prs as unknown[]).length, 1);
  assert.deepEqual((result.dependencies as Record<string, unknown>[]).find((value) => value.issue === 4)!.blocked_by, [2]); assert.equal((result.coverage as Record<string, unknown>).unresolved_count, 1);
  server.close(); await rm(root, { recursive: true, force: true });
});

test("ambiguous or refused issue creation records a terminal intent and never re-POSTs", async () => {
  for (const mode of ["lost", "refused"] as const) {
    const root = await mkdtemp(join(tmpdir(), `delivery-${mode}-`)); let posts = 0;
    const server = createServer(async (request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/user") return response.end(JSON.stringify({ id: 7, login: "developer", type: "User" }));
      if (request.url === "/repos/acme/tool") return response.end(JSON.stringify({ id: 42, full_name: "acme/tool", private: false }));
      if (request.url?.startsWith("/repos/acme/tool/issues?") && request.method === "GET") return response.end("[]");
      if (request.url === "/repos/acme/tool/issues" && request.method === "POST") { posts += 1; if (mode === "lost") request.socket.destroy(); else { response.statusCode = 422; response.end(JSON.stringify({ message: "validation failed" })); } return; }
      response.statusCode = 404; response.end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); assert(address && typeof address !== "string");
    const publisher = new Publisher({ repo: "acme/tool", repositoryId: 42, login: "developer", actorId: 7, stateRoot: root, remoteUrl: "https://github.com/acme/tool.git", tokenResolver: async () => "fixture-token", transportBaseUrl: `http://127.0.0.1:${address.port}`, testOnly: true });
    const packet: Record<string, unknown> = { schema_version: 1, action: "publish_issue", repo: "acme/tool", delivery_id: `draft-${mode}`, operation_id: "issue-op", payload: { title: "Title", body: "Body" } }; packet.authorized_digest = publicationAuthorizationDigest(packet);
    await assert.rejects(() => publisher.execute(packet)); await assert.rejects(() => publisher.execute(packet)); assert.equal(posts, 1);
    server.close(); await rm(root, { recursive: true, force: true });
  }
});

test("cross-process publication lock excludes a concurrent publisher attempt", async () => {
  const root = await mkdtemp(join(tmpdir(), "delivery-lock-")); let posts = 0, issue: Record<string, unknown> | null = null;
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/user") return response.end(JSON.stringify({ id: 7, login: "developer", type: "User" }));
    if (request.url === "/repos/acme/tool") return response.end(JSON.stringify({ id: 42, full_name: "acme/tool", private: false }));
    if (request.url?.startsWith("/repos/acme/tool/issues?") && request.method === "GET") return response.end(JSON.stringify(issue ? [issue] : []));
    if (request.url === "/repos/acme/tool/issues" && request.method === "POST") { posts += 1; let raw = ""; for await (const chunk of request) raw += chunk; const value = JSON.parse(raw); issue = { id: 1, node_id: "I_1", number: 1, title: value.title, body: value.body, repository_url: "https://api.github.com/repos/acme/tool", url: "https://api.github.com/repos/acme/tool/issues/1", html_url: "https://github.com/acme/tool/issues/1", user: { id: 7, login: "developer", type: "User" } }; return response.end(JSON.stringify(issue)); }
    if (request.url === "/repos/acme/tool/issues/1") return response.end(JSON.stringify(issue));
    response.statusCode = 404; response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); assert(address && typeof address !== "string");
  let resolutions = 0; const config = { repo: "acme/tool", repositoryId: 42, login: "developer", actorId: 7, stateRoot: root, remoteUrl: "https://github.com/acme/tool.git", tokenResolver: async () => { resolutions += 1; if (resolutions === 1) await new Promise((resolve) => setTimeout(resolve, 100)); return "fixture-token"; }, transportBaseUrl: `http://127.0.0.1:${address.port}`, testOnly: true };
  const one = new Publisher(config), two = new Publisher(config); const packet: Record<string, unknown> = { schema_version: 1, action: "publish_issue", repo: "acme/tool", delivery_id: "locked", operation_id: "op", payload: { title: "T", body: "B" } }; packet.authorized_digest = publicationAuthorizationDigest(packet);
  const first = one.execute(packet); await new Promise((resolve) => setTimeout(resolve, 20)); await assert.rejects(() => two.execute(packet), /holds the repository lock/); assert.equal((await first).status, "published"); assert.equal(posts, 1);
  server.close(); await rm(root, { recursive: true, force: true });
});

test("retargeted bound PR is rejected before any candidate ref change", async () => {
  const fixture = await fixtureGit(); git(fixture.work, "push", "origin", `${fixture.candidate}:refs/heads/delivery/plan`);
  writeFileSync(join(fixture.work, "README.md"), "next candidate\n"); git(fixture.work, "commit", "-am", "next"); const next = git(fixture.work, "rev-parse", "HEAD"); git(fixture.work, "branch", "next-bundle", next); const bundle = join(fixture.root, "next.bundle"); git(fixture.work, "bundle", "create", bundle, "next-bundle"); chmodSync(bundle, 0o600);
  const retargeted = { number: 8, node_id: "PR_8", html_url: "https://github.com/acme/tool/pull/8", state: "open", draft: true, title: "old", body: "old", user: { id: 7, login: "developer" }, head: { ref: "delivery/plan", sha: fixture.candidate, repo: { id: 42 } }, base: { ref: "other", sha: fixture.base, repo: { id: 42 } } };
  const server = createServer((request, response) => { response.setHeader("content-type", "application/json");
    if (request.url === "/user") return response.end(JSON.stringify({ id: 7, login: "developer", type: "User" }));
    if (request.url === "/repos/acme/tool") return response.end(JSON.stringify({ id: 42, full_name: "acme/tool", private: false }));
    if (request.url?.startsWith("/repos/acme/tool/pulls?")) return response.end(JSON.stringify([retargeted]));
    if (request.url === "/repos/acme/tool/pulls/8") return response.end(JSON.stringify(retargeted)); response.statusCode = 404; response.end("{}"); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); assert(address && typeof address !== "string");
  const publisher = new Publisher({ repo: "acme/tool", repositoryId: 42, login: "developer", actorId: 7, stateRoot: join(fixture.root, "state"), remoteUrl: fixture.remote, allowLocalRemote: true, tokenResolver: async () => "fixture-token", transportBaseUrl: `http://127.0.0.1:${address.port}`, testOnly: true });
  const packet: Record<string, unknown> = { schema_version: 1, action: "publish_implementation", repo: "acme/tool", delivery_id: "retarget", operation_id: "op", expected: { number: 8, head: "delivery/plan", head_sha: next, base: "main", base_sha: fixture.base, previous_sha: fixture.candidate }, payload: { title: "new", body: "new", bundle, allowed_paths: ["README.md"] } }; packet.authorized_digest = publicationAuthorizationDigest(packet);
  await assert.rejects(() => publisher.execute(packet), /bound pull request differs before publication/);
  assert.equal(git(fixture.root, "--git-dir", fixture.remote, "rev-parse", "refs/heads/delivery/plan"), fixture.candidate);
  git(fixture.work, "push", "--force", "origin", `${fixture.candidate}:refs/heads/main`);
  const moved: Record<string, unknown> = { ...packet, delivery_id: "moved-base", operation_id: "op-2", expected: { head: "delivery/moved", head_sha: next, base: "main", base_sha: fixture.base, previous_sha: null } }; moved.authorized_digest = publicationAuthorizationDigest(moved);
  await assert.rejects(() => publisher.execute(moved), /remote base branch moved/);
  assert.equal(git(fixture.work, "ls-remote", "--heads", fixture.remote, "refs/heads/delivery/moved"), "");
  server.close(); await rm(fixture.root, { recursive: true, force: true });
});
