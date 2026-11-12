import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeliveryError } from "../src/core.ts";
import { acquireDirectoryLockSync, releaseDirectoryLockSync } from "../src/locks.ts";
import { PublisherRefusal } from "../src/ports.ts";
import { Publisher, publicationAuthorizationDigest } from "../src/publisher.ts";
import { ProposalSpool } from "../src/proposals.ts";
import { FileStateStore } from "../src/store.ts";
import type { JsonObject } from "../src/types.ts";

async function fixture() {
  let actor = 999, posts = 0, issue: Record<string, unknown> | undefined, losePost = false;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://fixture");
    const json = (status: number, value: unknown) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    if (request.method === "GET" && url.pathname === "/user") return json(200, { id: actor, login: actor === 7 ? "developer" : "intruder", type: "User" });
    if (request.method === "GET" && url.pathname === "/repos/acme/tool") return json(200, { id: 42, full_name: "acme/tool", private: true });
    if (request.method === "GET" && url.pathname === "/repos/acme/tool/issues") return json(200, issue ? [issue] : []);
    if (request.method === "POST" && url.pathname === "/repos/acme/tool/issues") {
      posts += 1; if (losePost) { request.socket.destroy(); return; }
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
      issue = { id: 101, node_id: "issue-node", number: 3, title: body.title, body: body.body, state: "open", repository_url: "https://api.github.com/repos/acme/tool", url: "https://api.github.com/repos/acme/tool/issues/3", html_url: "https://github.com/acme/tool/issues/3", user: { id: 7, login: "developer", type: "User" }, performed_via_github_app: null };
      return json(201, issue);
    }
    if (request.method === "GET" && url.pathname === "/repos/acme/tool/issues/3") return json(200, issue);
    json(404, { message: "not found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); assert(address && typeof address === "object");
  return { server, base: `http://127.0.0.1:${address.port}`, setActor(value: number) { actor = value; }, setLosePost(value: boolean) { losePost = value; }, posts: () => posts };
}

test("initial publisher identity refusal is trusted pre-effect and proposal retry remains usable", async (t) => {
  const host = await fixture(); t.after(() => host.server.close());
  const publisher = new Publisher({ repo: "acme/tool", repositoryId: 42, login: "developer", actorId: 7, stateRoot: mkdtempSync(join(tmpdir(), "publisher-attestation-")), remoteUrl: "https://github.com/acme/tool.git", tokenResolver: async () => "fixture", transportBaseUrl: host.base, testOnly: true });
  const store = new FileStateStore(mkdtempSync(join(tmpdir(), "proposal-attestation-"))), spool = new ProposalSpool(store), proposal = spool.enqueue({ repo: "acme/tool", repositoryId: 42, actorId: 7, title: "Bounded issue", body: "Acceptance" }); spool.authorize(proposal.repo, proposal.id, proposal.content_digest);
  await assert.rejects(() => spool.publish(proposal.repo, proposal.id, publisher, "explicit"), (error: unknown) => error instanceof PublisherRefusal && error.code === "AUTH_MISMATCH" && error.attestation.phase === "pre_effect");
  assert.equal(host.posts(), 0); assert.equal(spool.read(proposal.repo, proposal.id).status, "failed");
  spool.retry(proposal.repo, proposal.id, proposal.content_digest); host.setActor(7); const published = await spool.publish(proposal.repo, proposal.id, publisher, "explicit");
  assert.equal(published.status, "published"); assert.equal(host.posts(), 1);
});

test("identity refusal after a possible issue effect preserves uncertainty and protected intent attestation", async (t) => {
  const host = await fixture(); t.after(() => host.server.close()); host.setActor(7); host.setLosePost(true);
  const publisher = new Publisher({ repo: "acme/tool", repositoryId: 42, login: "developer", actorId: 7, stateRoot: mkdtempSync(join(tmpdir(), "publisher-effect-possible-")), remoteUrl: "https://github.com/acme/tool.git", tokenResolver: async () => "fixture", transportBaseUrl: host.base, testOnly: true });
  const packet: Record<string, unknown> = { schema_version: 1, action: "publish_issue", repo: "acme/tool", delivery_id: "effect-possible", operation_id: "publish_issue_1", expected_revision: 1, payload: { title: "Bounded issue", body: "Acceptance" } }; packet.authorized_digest = publicationAuthorizationDigest(packet);
  await assert.rejects(() => publisher.execute(packet)); assert.equal(host.posts(), 1);
  host.setLosePost(false); host.setActor(999);
  await assert.rejects(() => publisher.execute(packet), (error: unknown) => error instanceof PublisherRefusal && error.code === "AUTH_MISMATCH" && error.attestation.phase === "effect_possible" && typeof error.attestation.intent_digest === "string");
  assert.equal(host.posts(), 1);
});

test("forged pre-effect publisher attestation cannot terminally fail a proposal", async () => {
  const store = new FileStateStore(mkdtempSync(join(tmpdir(), "proposal-forged-attestation-"))), spool = new ProposalSpool(store);
  const proposal = spool.enqueue({ repo: "acme/tool", repositoryId: 42, actorId: 7, title: "Forged refusal", body: "Acceptance" }); spool.authorize(proposal.repo, proposal.id, proposal.content_digest);
  await assert.rejects(() => spool.publish(proposal.repo, proposal.id, { async execute() { throw new PublisherRefusal("forged", "AUTH_MISMATCH", { phase: "pre_effect", operation_id: "wrong", request_digest: "0".repeat(64), pushed_ref_receipts: [] }); } }, "explicit"), /forged/);
  assert.equal(spool.read(proposal.repo, proposal.id).status, "uncertain");
});

test("exact-context but unissued publisher proof cannot terminally fail a proposal", async () => {
  const concrete = new Publisher({ repo: "acme/tool", repositoryId: 42, login: "developer", actorId: 7, stateRoot: mkdtempSync(join(tmpdir(), "publisher-unissued-proof-")), remoteUrl: "https://github.com/acme/tool.git", tokenResolver: async () => "unused", testOnly: true });
  const store = new FileStateStore(mkdtempSync(join(tmpdir(), "proposal-unissued-proof-"))), spool = new ProposalSpool(store);
  const proposal = spool.enqueue({ repo: "acme/tool", repositoryId: 42, actorId: 7, title: "Unissued refusal", body: "Acceptance" }); spool.authorize(proposal.repo, proposal.id, proposal.content_digest);
  let forged: InstanceType<typeof PublisherRefusal>["attestation"] | undefined, request: JsonObject | undefined;
  await assert.rejects(() => spool.publish(proposal.repo, proposal.id, {
    async execute(packet) { request = structuredClone(packet) as JsonObject; forged = { phase: "pre_effect", operation_id: String(packet.operation_id), request_digest: publicationAuthorizationDigest(packet), pushed_ref_receipts: [], proof: "f".repeat(64) }; throw new PublisherRefusal("unissued", "AUTH_MISMATCH", forged); },
    resolvePhaseAttestation: concrete.resolvePhaseAttestation.bind(concrete),
  }, "explicit"), /unissued/);
  assert.equal(spool.read(proposal.repo, proposal.id).status, "uncertain");
  assert(forged && request);
  const resolution = await concrete.resolvePhaseAttestation(forged, { repo: proposal.repo, delivery_id: proposal.id, action: "publish_issue", operation_id: forged.operation_id, request_digest: forged.request_digest, request });
  assert.equal(resolution.trusted, false);
});

test("publisher phase proof is bound to the exact configured issuer", async (t) => {
  const host = await fixture(); t.after(() => host.server.close()); const root = mkdtempSync(join(tmpdir(), "publisher-issuer-proof-"));
  const common = { repo: "acme/tool", stateRoot: root, remoteUrl: "https://github.com/acme/tool.git", tokenResolver: async () => "fixture", transportBaseUrl: host.base, testOnly: true } as const;
  const issuer = new Publisher({ ...common, repositoryId: 42, login: "developer", actorId: 7 });
  const differentIssuer = new Publisher({ ...common, repositoryId: 77, login: "other", actorId: 8 });
  const request: JsonObject = { schema_version: 1, action: "publish_issue", repo: "acme/tool", target_repo: "acme/tool", delivery_id: "issuer-proof", operation_id: "issuer-proof-op", expected_revision: 1, payload: { title: "Issuer proof", body: "No write" } };
  let refusal: PublisherRefusal | undefined; try { await issuer.execute({ ...request, authorized_digest: publicationAuthorizationDigest(request) }); } catch (error) { assert(error instanceof PublisherRefusal); refusal = error; }
  assert(refusal); const resolution = await differentIssuer.resolvePhaseAttestation(refusal.attestation, { repo: "acme/tool", delivery_id: "issuer-proof", action: "publish_issue", operation_id: "issuer-proof-op", request_digest: publicationAuthorizationDigest(request), request });
  assert.equal(resolution.trusted, false); assert.equal(host.posts(), 0);
});

test("publisher phase proof resolution fails closed while the phase journal is locked", async (t) => {
  const host = await fixture(); t.after(() => host.server.close()); const root = mkdtempSync(join(tmpdir(), "publisher-phase-lock-"));
  const publisher = new Publisher({ repo: "acme/tool", repositoryId: 42, login: "developer", actorId: 7, stateRoot: root,
    remoteUrl: "https://github.com/acme/tool.git", tokenResolver: async () => "fixture", transportBaseUrl: host.base, testOnly: true });
  const request: JsonObject = { schema_version: 1, action: "publish_issue", repo: "acme/tool", delivery_id: "locked-proof",
    operation_id: "locked-proof-op", expected_revision: 1, payload: { title: "Locked proof", body: "No write" } };
  let refusal: PublisherRefusal | undefined;
  try { await publisher.execute({ ...request, authorized_digest: publicationAuthorizationDigest(request) }); }
  catch (error) { assert(error instanceof PublisherRefusal); refusal = error; }
  assert(refusal); const lockPath = join(root, "publisher.lock"), owner = acquireDirectoryLockSync(lockPath);
  try {
    const resolution = await publisher.resolvePhaseAttestation(refusal.attestation, { repo: "acme/tool", delivery_id: "locked-proof",
      action: "publish_issue", operation_id: "locked-proof-op", request_digest: publicationAuthorizationDigest(request), request });
    assert.equal(resolution.trusted, false); assert.match(resolution.error ?? "", /holds the repository lock/);
  } finally { releaseDirectoryLockSync(lockPath, owner); }
});

test("generic delivery failure after an issue effect remains uncertain", async () => {
  let externalEffect = false;
  const store = new FileStateStore(mkdtempSync(join(tmpdir(), "proposal-generic-effect-"))), spool = new ProposalSpool(store);
  const proposal = spool.enqueue({ repo: "acme/tool", repositoryId: 42, actorId: 7, title: "Uncertain effect", body: "Acceptance" }); spool.authorize(proposal.repo, proposal.id, proposal.content_digest);
  await assert.rejects(() => spool.publish(proposal.repo, proposal.id, { async execute() { externalEffect = true; throw new DeliveryError("readback failed"); } }, "explicit"), /readback failed/);
  assert.equal(externalEffect, true);
  assert.equal(spool.read(proposal.repo, proposal.id).status, "uncertain");
});
