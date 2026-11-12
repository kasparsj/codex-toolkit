import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DeliveryEngine } from "../src/engine.ts";
import { createRunExport, inspectRunExport, writeRunExport } from "../src/export.ts";
import { ProposalSpool } from "../src/proposals.ts";
import { FileStateStore } from "../src/store.ts";
import { policy } from "./helpers.ts";
import { canonicalJson, DeliveryError, digest } from "../src/core.ts";
import { Publisher, publicationAuthorizationDigest } from "../src/publisher.ts";
import type { JsonObject } from "../src/types.ts";

const publisherModule = new URL("../src/publisher.ts", import.meta.url).href;
function childExit(child: ReturnType<typeof spawn>): Promise<void> { return new Promise((resolve) => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once("exit", () => resolve()); }); }

test("portable export excludes fencing secrets and proposal authorization is exact digest", async () => {
  const root = mkdtempSync(join(tmpdir(), "portable-")); const runtime = join(root, "runtime"); writeFileSync(runtime, "trusted runtime\n", { mode: 0o700 });
  const store = new FileStateStore(root); const engine = new DeliveryEngine({ store }); const state = engine.start({ repo: "owner/repo", issue: 1, deliveryId: "one", policy: policy(), pinLocations: { runtime } });
  const exported = createRunExport(state); const text = JSON.stringify(exported); assert.doesNotMatch(text, /claim_token|authorized_digest|\/trusted\/runtime/); assert.match(exported.digest, /^[0-9a-f]{64}$/);
  const path = join(store.root, "run.export.json"); writeRunExport(path, exported); assert.equal(inspectRunExport(path).digest, exported.digest);
  const spool = new ProposalSpool(store); const proposal = spool.enqueue({ repo: state.repo, repositoryId: 10, actorId: 7, title: "A bounded issue", body: "Acceptance criteria" });
  assert.throws(() => spool.authorize(state.repo, proposal.id, "0".repeat(64)), /digest mismatch/);
  assert.equal(spool.authorize(state.repo, proposal.id, proposal.content_digest).status, "authorized");
  const published = await spool.publish(state.repo, proposal.id, { async execute(packet) { assert.match(packet.authorized_digest as string, /^[0-9a-f]{64}$/); return { schema_version: 1, action: packet.action, delivery_id: packet.delivery_id, operation_id: packet.operation_id, status: "published", issue: { number: 9, url: "https://github.com/owner/repo/issues/9" } }; } }, "explicit");
  assert.equal(published.status, "published");
});

test("portable export allowlists verification evidence and rejects private receipt fields", () => {
  const root = mkdtempSync(join(tmpdir(), "portable-private-receipts-")), store = new FileStateStore(root), engine = new DeliveryEngine({ store });
  let state = engine.start({ repo: "owner/repo", issue: 1, deliveryId: "private-receipts", policy: policy() });
  const candidate = "5".repeat(40), manifestDigest = "a".repeat(64), criteriaDigest = "b".repeat(64), contextDigest = "c".repeat(64), checkedAt = "2026-11-12T10:00:00.000Z";
  state = store.mutate(state.repo, state.delivery_id, state.revision, (next) => {
    next.receipts.plan = { approved: true, approvers: [101], rejectors: [], minimum: 1, review_ids: { "101": 7001 }, context_digest: contextDigest, commit_id: candidate, generation: 1, checked_at: checkedAt, raw_text: "private plan transcript" };
    next.receipts.checks = { status: "success", candidate_sha: candidate, manifest_digest: manifestDigest, checked_at: checkedAt, session_file: "/private/protected/checker/session.json", diagnostics: "private checker transcript" };
    next.receipts.engineering = {
      candidate_sha: candidate,
      producer_execution_id: "producer-task",
      producer_identity: "pi:/private/protected/producer/session.json",
      criteria_digest: criteriaDigest,
      checked_at: checkedAt,
      checker: next.receipts.checks,
      review: { status: "approved", delivery_id: next.delivery_id, task_id: "review-task", criteria_digest: criteriaDigest, candidate_sha: candidate, reviewer_identity: "pi:/private/protected/reviewer/session.json", proof_path: "/private/protected/reviewer/receipt.json", raw_text: "private reviewer transcript" },
    };
    next.executions.push({ id: "producer-task", kind: "agent", stage: "implement", status: "completed", external_id: "/private/protected/agent/session.json", started_at: checkedAt, finished_at: checkedAt, result_digest: manifestDigest });
    next.pins.skills["private/path"] = "/private/protected/pin/source.txt";
    next.history.push({ event: "private_diagnostic", revision: next.revision, at: checkedAt, error: "private runtime transcript" });
    return next;
  });

  const exported = createRunExport(state), text = JSON.stringify(exported), receipts = exported.decisions.receipts as JsonObject;
  assert.doesNotMatch(text, /private (?:plan|checker|reviewer|runtime) transcript|\/private\/protected/);
  assert.equal((receipts.plan as JsonObject).context_digest, contextDigest);
  assert.equal((receipts.checks as JsonObject).manifest_digest, manifestDigest);
  const engineering = receipts.engineering as JsonObject;
  assert.equal(engineering.candidate_sha, candidate);
  assert.equal(engineering.criteria_digest, criteriaDigest);
  assert.match(String(engineering.producer_identity_digest), /^[0-9a-f]{64}$/);
  assert.equal(((engineering.review as JsonObject).status), "approved");
  assert.match(String((engineering.review as JsonObject).reviewer_identity_digest), /^[0-9a-f]{64}$/);

  const path = join(root, "private-safe.export.json"); writeRunExport(path, exported); assert.equal(inspectRunExport(path).digest, exported.digest);
  const forged = structuredClone(exported), forgedReceipts = forged.decisions.receipts as JsonObject, forgedEngineering = forgedReceipts.engineering as JsonObject;
  (forgedEngineering.review as JsonObject).raw_text = "private reviewer transcript";
  const { digest: _oldDigest, ...forgedBody } = forged; forged.digest = digest(forgedBody);
  const forgedPath = join(root, "private-forged.export.json"); writeRunExport(forgedPath, forged);
  assert.throws(() => inspectRunExport(forgedPath), /protected|invalid/i);
});

test("untyped issue publication refusal remains uncertain and explicitly retryable", async () => {
  const store = new FileStateStore(mkdtempSync(join(tmpdir(), "proposal-refused-"))), spool = new ProposalSpool(store), proposal = spool.enqueue({ repo: "owner/repo", repositoryId: 10, actorId: 7, title: "Retry bounded issue", body: "Acceptance criteria" }); spool.authorize(proposal.repo, proposal.id, proposal.content_digest);
  await assert.rejects(() => spool.publish(proposal.repo, proposal.id, { async execute() { throw new DeliveryError("GitHub refused the request (422)", "GITHUB_REFUSED"); } }, "explicit"), /refused/);
  assert.equal(spool.read(proposal.repo, proposal.id).status, "uncertain"); assert.equal(spool.retry(proposal.repo, proposal.id, proposal.content_digest).status, "authorized"); assert.equal(spool.remove(proposal.repo, proposal.id, proposal.content_digest).status, "removed");
});

test("proposal readback reports authoritative absence without authorizing or executing", async () => {
  const store = new FileStateStore(mkdtempSync(join(tmpdir(), "proposal-readback-absent-"))), spool = new ProposalSpool(store);
  const proposal = spool.enqueue({ repo: "acme/tool", repositoryId: 42, actorId: 7, title: "Paused proposal", body: "No effect" }); let inspections = 0;
  const result = await spool.reconcilePublication(proposal.repo, proposal.id, { async execute() { throw new Error("readback executed publisher"); }, async inspectPublication() { inspections += 1; throw new Error("absence inspected publisher"); } }, { mode: "readback" });
  assert.equal(result.status, "absent"); assert.equal(inspections, 0); assert.equal(spool.read(proposal.repo, proposal.id).status, "queued");
  const stranded = spool.enqueue({ repo: "acme/tool", repositoryId: 42, actorId: 7, title: "Stranded proposal", body: "No publisher intent" }); spool.authorize(stranded.repo, stranded.id, stranded.content_digest);
  const operationId = digest({ repo: stranded.repo, id: stranded.id, content_digest: stranded.content_digest }).slice(0, 24), request = { schema_version: 1, action: "publish_issue", repo: stranded.repo, target_repo: stranded.repo, delivery_id: stranded.id, operation_id: operationId, expected_revision: 1, payload: { title: stranded.title, body: stranded.body } }, requestDigest = publicationAuthorizationDigest(request), proposalPath = join(store.repoDir(stranded.repo), "proposals", stranded.id, "proposal.json");
  store.withRepoLock(stranded.repo, () => { const value = spool.read(stranded.repo, stranded.id); value.status = "publishing"; value.operation = { id: operationId, request_digest: requestDigest, recorded_at: new Date().toISOString() }; store.writeProtected(proposalPath, value); });
  const publisher = new Publisher({ repo: stranded.repo, repositoryId: 42, actorId: 7, login: "developer", stateRoot: mkdtempSync(join(tmpdir(), "publisher-readback-absent-")), remoteUrl: "https://github.com/acme/tool.git", tokenResolver: async () => { throw new Error("absence resolved credentials"); }, testOnly: true });
  const strandedResult = await spool.reconcilePublication(stranded.repo, stranded.id, publisher, { mode: "readback" }); assert.equal(strandedResult.status, "absent"); assert.equal(spool.read(stranded.repo, stranded.id).status, "uncertain");
});

test("proposal readback rejects changed protected proposal content before inspection", async () => {
  const store = new FileStateStore(mkdtempSync(join(tmpdir(), "proposal-readback-changed-"))), spool = new ProposalSpool(store);
  const proposal = spool.enqueue({ repo: "acme/tool", repositoryId: 42, actorId: 7, title: "Original proposal", body: "Exact body" }); spool.authorize(proposal.repo, proposal.id, proposal.content_digest);
  const operationId = digest({ repo: proposal.repo, id: proposal.id, content_digest: proposal.content_digest }).slice(0, 24), request = { schema_version: 1, action: "publish_issue", repo: proposal.repo, target_repo: proposal.repo, delivery_id: proposal.id, operation_id: operationId, expected_revision: 1, payload: { title: proposal.title, body: proposal.body } }, requestDigest = publicationAuthorizationDigest(request), proposalPath = join(store.repoDir(proposal.repo), "proposals", proposal.id, "proposal.json");
  store.withRepoLock(proposal.repo, () => { const value = spool.read(proposal.repo, proposal.id); value.status = "publishing"; value.operation = { id: operationId, request_digest: requestDigest, recorded_at: new Date().toISOString() }; value.title = "Changed proposal"; store.writeProtected(proposalPath, value); });
  let inspections = 0;
  await assert.rejects(() => spool.reconcilePublication(proposal.repo, proposal.id, { async execute() { throw new Error("unexpected execute"); }, async inspectPublication() { inspections += 1; return { status: "absent", operation_id: operationId, request_digest: requestDigest }; } }, { mode: "readback" }), (error: unknown) => (error as { code?: string }).code === "REQUEST_CONFLICT");
  assert.equal(inspections, 0); assert.equal(spool.read(proposal.repo, proposal.id).status, "publishing");
});

test("proposal readback does not trust a forged terminal inspector", async () => {
  const store = new FileStateStore(mkdtempSync(join(tmpdir(), "proposal-readback-forged-"))), spool = new ProposalSpool(store), proposal = spool.enqueue({ repo: "acme/tool", repositoryId: 42, actorId: 7, title: "Forged terminal", body: "Exact body" }); spool.authorize(proposal.repo, proposal.id, proposal.content_digest);
  const operationId = digest({ repo: proposal.repo, id: proposal.id, content_digest: proposal.content_digest }).slice(0, 24), request = { schema_version: 1, action: "publish_issue", repo: proposal.repo, target_repo: proposal.repo, delivery_id: proposal.id, operation_id: operationId, expected_revision: 1, payload: { title: proposal.title, body: proposal.body } }, requestDigest = publicationAuthorizationDigest(request), proposalPath = join(store.repoDir(proposal.repo), "proposals", proposal.id, "proposal.json");
  store.withRepoLock(proposal.repo, () => { const value = spool.read(proposal.repo, proposal.id); value.status = "publishing"; value.operation = { id: operationId, request_digest: requestDigest, recorded_at: new Date().toISOString() }; store.writeProtected(proposalPath, value); }); let inspections = 0;
  const result = await spool.reconcilePublication(proposal.repo, proposal.id, { async execute() { throw new Error("unexpected execute"); }, async inspectPublication() { inspections += 1; return { status: "completed", operation_id: operationId, request_digest: requestDigest, receipt: { number: 1 } }; } }, { mode: "readback" });
  assert.equal(result.status, "uncertain"); assert.equal(inspections, 0); assert.equal(spool.read(proposal.repo, proposal.id).status, "uncertain");
});

test("proposal readback reconciles an accepted issue after publisher process loss with GET only", { timeout: 20_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "proposal-readback-crash-")), store = new FileStateStore(join(root, "delivery")), spool = new ProposalSpool(store), stateRoot = join(root, "publisher");
  const proposal = spool.enqueue({ repo: "acme/tool", repositoryId: 42, actorId: 7, title: "Recovered proposal", body: "Exact effect" }); spool.authorize(proposal.repo, proposal.id, proposal.content_digest);
  let posts = 0, issue: Record<string, unknown> | undefined, accepted!: () => void; const acceptedPost = new Promise<void>((resolve) => { accepted = resolve; });
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json"); const url = new URL(request.url!, "http://fixture");
    if (url.pathname === "/user") return response.end(JSON.stringify({ id: 7, login: "developer", type: "User" }));
    if (url.pathname === "/repos/acme/tool") return response.end(JSON.stringify({ id: 42, full_name: "acme/tool", private: false }));
    if (url.pathname === "/repos/acme/tool/issues" && request.method === "GET") return response.end(JSON.stringify(issue ? [issue] : []));
    if (url.pathname === "/repos/acme/tool/issues" && request.method === "POST") { posts += 1; let raw = ""; for await (const chunk of request) raw += chunk; const body = JSON.parse(raw); issue = { id: 81, node_id: "I_81", number: 81, title: body.title, body: body.body, repository_url: "https://api.github.com/repos/acme/tool", url: "https://api.github.com/repos/acme/tool/issues/81", html_url: "https://github.com/acme/tool/issues/81", user: { id: 7, login: "developer", type: "User" }, performed_via_github_app: null }; accepted(); return; }
    if (url.pathname === "/repos/acme/tool/issues/81") return response.end(JSON.stringify(issue)); response.statusCode = 404; response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); t.after(() => server.close()); const address = server.address(); assert(address && typeof address !== "string");
  const operationId = digest({ repo: proposal.repo, id: proposal.id, content_digest: proposal.content_digest }).slice(0, 24), request = { schema_version: 1, action: "publish_issue", repo: proposal.repo, target_repo: proposal.repo, delivery_id: proposal.id, operation_id: operationId, expected_revision: 1, payload: { title: proposal.title, body: proposal.body } }, requestDigest = publicationAuthorizationDigest(request);
  const proposalPath = join(store.repoDir(proposal.repo), "proposals", proposal.id, "proposal.json"); store.withRepoLock(proposal.repo, () => { const value = spool.read(proposal.repo, proposal.id); value.status = "publishing"; value.operation = { id: operationId, request_digest: requestDigest, recorded_at: new Date().toISOString() }; store.writeProtected(proposalPath, value); });
  const config = { repo: proposal.repo, repositoryId: 42, login: "developer", actorId: 7, stateRoot, remoteUrl: "https://github.com/acme/tool.git", transportBaseUrl: `http://127.0.0.1:${address.port}`, testOnly: true }, packet = { ...request, authorized_digest: requestDigest };
  const childCode = `const {Publisher}=await import(${JSON.stringify(publisherModule)});const config=${JSON.stringify(config)};config.tokenResolver=async()=>"fixture";await new Publisher(config).execute(${canonicalJson(packet)});`;
  const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", childCode], { stdio: "ignore" }), exited = childExit(child);
  try { await acceptedPost; child.kill("SIGKILL"); await exited; const publisher = new Publisher({ ...config, tokenResolver: async () => "fixture" }); await publisher.recoverLock(); const result = await spool.reconcilePublication(proposal.repo, proposal.id, publisher, { mode: "readback" }); assert.equal(result.status, "completed"); assert.equal(result.operation_id, operationId); assert.equal(spool.read(proposal.repo, proposal.id).status, "published"); assert.equal(posts, 1); }
  finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited; }
});

test("proposal readback holds zero, multiple, lookalike and cyclic issue results without writes", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "proposal-readback-holds-")), store = new FileStateStore(join(root, "delivery")), spool = new ProposalSpool(store), stateRoot = join(root, "publisher");
  let mode: "zero" | "multiple" | "lookalike" | "cycle" = "zero", rows: Record<string, unknown>[] = [], posts = 0, base = "";
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json"); const url = new URL(request.url!, "http://fixture");
    if (url.pathname === "/user") return response.end(JSON.stringify({ id: 7, login: "developer", type: "User" }));
    if (url.pathname === "/repos/acme/tool") return response.end(JSON.stringify({ id: 42, full_name: "acme/tool", private: false }));
    if (url.pathname === "/repos/acme/tool/issues" && request.method === "POST") { posts += 1; response.statusCode = 500; return response.end("{}"); }
    if (url.pathname === "/repos/acme/tool/issues" && request.method === "GET") { if (mode === "cycle") response.setHeader("link", `<${base}${request.url}>; rel="next"`); return response.end(JSON.stringify(rows)); }
    response.statusCode = 404; response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); t.after(() => server.close()); const address = server.address(); assert(address && typeof address !== "string"); base = `http://127.0.0.1:${address.port}`;
  const publisher = new Publisher({ repo: "acme/tool", repositoryId: 42, login: "developer", actorId: 7, stateRoot, remoteUrl: "https://github.com/acme/tool.git", transportBaseUrl: base, tokenResolver: async () => "fixture", testOnly: true });
  const publisherIdentityDigest = digest({ repo: "acme/tool", repository_id: 42, actor_id: 7, login: "developer", remote_url: "https://github.com/acme/tool.git", transport_base_url: base, test_only: true, allow_local_remote: false });
  for (const currentMode of ["zero", "multiple", "lookalike", "cycle"] as const) {
    mode = currentMode; const proposal = spool.enqueue({ repo: "acme/tool", repositoryId: 42, actorId: 7, title: `Held ${currentMode}`, body: "Exact body" }); spool.authorize(proposal.repo, proposal.id, proposal.content_digest);
    const operationId = digest({ repo: proposal.repo, id: proposal.id, content_digest: proposal.content_digest }).slice(0, 24), request = { schema_version: 1, action: "publish_issue", repo: proposal.repo, target_repo: proposal.repo, delivery_id: proposal.id, operation_id: operationId, expected_revision: 1, payload: { title: proposal.title, body: proposal.body } }, requestDigest = publicationAuthorizationDigest(request);
    const marker = `<!-- codex-toolkit-issue:${digest({ repo: proposal.repo, repository_id: 42, actor_id: 7, delivery_id: proposal.id, operation_id: operationId, title: proposal.title, body: proposal.body })} -->`, body = `${proposal.body}\n\n${marker}`;
    const exact = { id: 91, node_id: "I_91", number: 91, title: proposal.title, body, repository_url: "https://api.github.com/repos/acme/tool", url: "https://api.github.com/repos/acme/tool/issues/91", html_url: "https://github.com/acme/tool/issues/91", user: { id: 7, login: "developer", type: "User" }, performed_via_github_app: null };
    rows = currentMode === "zero" || currentMode === "cycle" ? [] : currentMode === "multiple" ? [exact, { ...exact, id: 92, node_id: "I_92", number: 92 }] : [{ ...exact, title: "Lookalike" }];
    const intentDirectory = join(stateRoot, "publication-intents", proposal.id); mkdirSync(intentDirectory, { recursive: true, mode: 0o700 });
    const intentPath = join(intentDirectory, `${createHash("sha256").update(`publish_issue\0${operationId}`).digest("hex")}.json`);
    writeFileSync(intentPath, canonicalJson({ schema_version: 1, repo: proposal.repo, repository_id: 42, actor_id: 7, publisher_identity_digest: publisherIdentityDigest, action: "publish_issue", delivery_id: proposal.id, operation_id: operationId, request_digest: requestDigest, phase: "create_attempted", marker, updated_at: new Date().toISOString() }), { mode: 0o600 });
    const proposalPath = join(store.repoDir(proposal.repo), "proposals", proposal.id, "proposal.json"); store.withRepoLock(proposal.repo, () => { const value = spool.read(proposal.repo, proposal.id); value.status = "publishing"; value.operation = { id: operationId, request_digest: requestDigest, recorded_at: new Date().toISOString() }; store.writeProtected(proposalPath, value); });
    const result = await spool.reconcilePublication(proposal.repo, proposal.id, publisher, { mode: "readback" }); assert.equal(result.status, "uncertain", currentMode); assert.equal(spool.read(proposal.repo, proposal.id).status, "uncertain", currentMode);
  }
  assert.equal(posts, 0);
});

test("proposal readback terminalizes only an exact definitive pre-effect refusal", async () => {
  const root = mkdtempSync(join(tmpdir(), "proposal-readback-refused-")), store = new FileStateStore(join(root, "delivery")), spool = new ProposalSpool(store), stateRoot = join(root, "publisher");
  const proposal = spool.enqueue({ repo: "acme/tool", repositoryId: 42, actorId: 7, title: "Refused proposal", body: "Exact body" }); spool.authorize(proposal.repo, proposal.id, proposal.content_digest);
  const operationId = digest({ repo: proposal.repo, id: proposal.id, content_digest: proposal.content_digest }).slice(0, 24), request = { schema_version: 1, action: "publish_issue", repo: proposal.repo, target_repo: proposal.repo, delivery_id: proposal.id, operation_id: operationId, expected_revision: 1, payload: { title: proposal.title, body: proposal.body } }, requestDigest = publicationAuthorizationDigest(request);
  const marker = `<!-- codex-toolkit-issue:${digest({ repo: proposal.repo, repository_id: 42, actor_id: 7, delivery_id: proposal.id, operation_id: operationId, title: proposal.title, body: proposal.body })} -->`, intentDirectory = join(stateRoot, "publication-intents", proposal.id);
  const publisher = new Publisher({ repo: proposal.repo, repositoryId: 42, login: "developer", actorId: 7, stateRoot, remoteUrl: "https://github.com/acme/tool.git", tokenResolver: async () => "unused", testOnly: true });
  const publisherIdentityDigest = digest({ repo: proposal.repo, repository_id: 42, actor_id: 7, login: "developer", remote_url: "https://github.com/acme/tool.git", transport_base_url: null, test_only: true, allow_local_remote: false });
  mkdirSync(intentDirectory, { recursive: true, mode: 0o700 }); writeFileSync(join(intentDirectory, `${createHash("sha256").update(`publish_issue\0${operationId}`).digest("hex")}.json`), canonicalJson({ schema_version: 1, repo: proposal.repo, repository_id: 42, actor_id: 7, publisher_identity_digest: publisherIdentityDigest, action: "publish_issue", delivery_id: proposal.id, operation_id: operationId, request_digest: requestDigest, phase: "blocked", marker, reason: "create_refused", updated_at: new Date().toISOString() }), { mode: 0o600 });
  const proposalPath = join(store.repoDir(proposal.repo), "proposals", proposal.id, "proposal.json"); store.withRepoLock(proposal.repo, () => { const value = spool.read(proposal.repo, proposal.id); value.status = "publishing"; value.operation = { id: operationId, request_digest: requestDigest, recorded_at: new Date().toISOString() }; store.writeProtected(proposalPath, value); });
  const result = await spool.reconcilePublication(proposal.repo, proposal.id, publisher, { mode: "readback" }); assert.equal(result.status, "failed"); assert.equal(spool.read(proposal.repo, proposal.id).status, "failed");
});

test("proposal readback fails closed for configured issuer drift and post-effect auth loss", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "proposal-readback-issuer-")), store = new FileStateStore(join(root, "delivery")), spool = new ProposalSpool(store);
  const seed = (id: string, stateRoot: string, phase: "published" | "create_attempted", publisherIdentityDigest: string) => {
    const proposal = spool.enqueue({ repo: "acme/tool", repositoryId: 42, actorId: 7, id, title: `Issuer ${id}`, body: "Exact body" }); spool.authorize(proposal.repo, proposal.id, proposal.content_digest);
    const operationId = digest({ repo: proposal.repo, id: proposal.id, content_digest: proposal.content_digest }).slice(0, 24), request = { schema_version: 1, action: "publish_issue", repo: proposal.repo, target_repo: proposal.repo, delivery_id: proposal.id, operation_id: operationId, expected_revision: 1, payload: { title: proposal.title, body: proposal.body } }, requestDigest = publicationAuthorizationDigest(request), marker = `<!-- codex-toolkit-issue:${digest({ repo: proposal.repo, repository_id: 42, actor_id: 7, delivery_id: proposal.id, operation_id: operationId, title: proposal.title, body: proposal.body })} -->`;
    const intentDirectory = join(stateRoot, "publication-intents", proposal.id); mkdirSync(intentDirectory, { recursive: true, mode: 0o700 }); writeFileSync(join(intentDirectory, `${createHash("sha256").update(`publish_issue\0${operationId}`).digest("hex")}.json`), canonicalJson({ schema_version: 1, repo: proposal.repo, repository_id: 42, actor_id: 7, publisher_identity_digest: publisherIdentityDigest, action: "publish_issue", delivery_id: proposal.id, operation_id: operationId, request_digest: requestDigest, phase, marker, ...(phase === "published" ? { number: 7, node_id: "I_7", remote_id: 7 } : {}), updated_at: new Date().toISOString() }), { mode: 0o600 });
    const proposalPath = join(store.repoDir(proposal.repo), "proposals", proposal.id, "proposal.json"); store.withRepoLock(proposal.repo, () => { const value = spool.read(proposal.repo, proposal.id); value.status = "publishing"; value.operation = { id: operationId, request_digest: requestDigest, recorded_at: new Date().toISOString() }; store.writeProtected(proposalPath, value); }); return proposal;
  };
  const driftRoot = join(root, "drift-publisher"), intendedIdentity = digest({ repo: "acme/tool", repository_id: 42, actor_id: 7, login: "developer", remote_url: "https://github.com/acme/tool.git", transport_base_url: null, test_only: true, allow_local_remote: false }), drifted = seed("issuer-drift", driftRoot, "published", intendedIdentity);
  const driftedPublisher = new Publisher({ repo: "acme/tool", repositoryId: 77, login: "other", actorId: 8, stateRoot: driftRoot, remoteUrl: "https://github.com/acme/tool.git", tokenResolver: async () => "unused", testOnly: true });
  const driftResult = await spool.reconcilePublication(drifted.repo, drifted.id, driftedPublisher, { mode: "readback" }); assert.equal(driftResult.status, "uncertain"); assert.equal(spool.read(drifted.repo, drifted.id).status, "uncertain");

  const server = createServer((request, response) => { response.setHeader("content-type", "application/json"); if (request.url === "/user") return response.end(JSON.stringify({ id: 999, login: "intruder", type: "User" })); response.statusCode = 500; response.end("{}"); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); t.after(() => server.close()); const address = server.address(); assert(address && typeof address !== "string"); const base = `http://127.0.0.1:${address.port}`, authRoot = join(root, "auth-publisher"), authIdentity = digest({ repo: "acme/tool", repository_id: 42, actor_id: 7, login: "developer", remote_url: "https://github.com/acme/tool.git", transport_base_url: base, test_only: true, allow_local_remote: false }), afterPost = seed("auth-after-post", authRoot, "create_attempted", authIdentity);
  const correctPublisher = new Publisher({ repo: "acme/tool", repositoryId: 42, login: "developer", actorId: 7, stateRoot: authRoot, remoteUrl: "https://github.com/acme/tool.git", transportBaseUrl: base, tokenResolver: async () => "fixture", testOnly: true });
  const authResult = await spool.reconcilePublication(afterPost.repo, afterPost.id, correctPublisher, { mode: "readback" }); assert.equal(authResult.status, "uncertain"); assert.equal(spool.read(afterPost.repo, afterPost.id).status, "uncertain");
});
