import { createHash, randomBytes } from "node:crypto";
import { lstat, open, readFile, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { canonicalJson, DeliveryError, digest, repoIdentity, requireCondition, validateDeliveryId, validateRef, validateSha } from "./core.ts";
import { GitHubTransport, GitHubUnavailable, resolveGhToken } from "./github.ts";
import { acquireDirectoryLockSync, ensurePrivateDirectorySync, recoverDirectoryLockSync, releaseDirectoryLockSync, type DirectoryIdentity } from "./locks.ts";
import { TrustedGit } from "./trusted-git.ts";
import { PublisherReadOnlyRefusal, PublisherRefusal, type PublisherPhaseAttestation, type PublisherPhaseAttestationResolution, type PublisherPhaseExpectedContext, type PublisherPublicationInspection, type PublisherReadOnlyAttestation, type PublisherReadOnlyAttestationResolution } from "./ports.ts";
import type { JsonObject } from "./types.ts";

export interface PublisherConfig {
  repo: string; repositoryId: number; login: string; actorId: number;
  stateRoot: string; remoteUrl: string;
  tokenResolver?: () => Promise<string>;
  transportBaseUrl?: string; testOnly?: boolean; allowLocalRemote?: boolean;
}

type Packet = Record<string, unknown>;
type Intent = Record<string, unknown> & { phase: string; request_digest: string };

function object(value: unknown, label: string): Record<string, unknown> {
  requireCondition(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string, max = 256): string { requireCondition(typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= max, `invalid ${label}`); return value; }
function integer(value: unknown, label: string): number { requireCondition(Number.isInteger(value) && (value as number) > 0, `invalid ${label}`); return value as number; }
function lowerSha(value: unknown, label: string): string { validateSha(value, label); return value; }

export function publicationAuthorizationDigest(packet: Packet): string {
  return digest({ schema_version: packet.schema_version, action: packet.action, repo: packet.repo ?? packet.target_repo,
    delivery_id: packet.delivery_id, operation_id: packet.operation_id,
    ...(packet.expected_revision !== undefined ? { expected_revision: packet.expected_revision } : {}),
    ...(packet.expected !== undefined ? { expected: packet.expected } : {}),
    ...(packet.payload !== undefined ? { payload: packet.payload } : {}) });
}

function publicationRequest(packet: Packet): Record<string, unknown> {
  return { schema_version: packet.schema_version, action: packet.action, repo: packet.repo ?? packet.target_repo,
    delivery_id: packet.delivery_id, operation_id: packet.operation_id,
    ...(packet.expected_revision !== undefined ? { expected_revision: packet.expected_revision } : {}),
    ...(packet.expected !== undefined ? { expected: packet.expected } : {}),
    ...(packet.payload !== undefined ? { payload: packet.payload } : {}) };
}

function issueMarker(config: PublisherConfig, packet: Packet, payload: Record<string, unknown>): string {
  return `<!-- codex-toolkit-issue:${digest({ repo: config.repo, repository_id: config.repositoryId, actor_id: config.actorId,
    delivery_id: packet.delivery_id, operation_id: packet.operation_id, title: payload.title, body: payload.body })} -->`;
}

export class Publisher {
  readonly config: PublisherConfig;
  #stateRootIdentity?: DirectoryIdentity;
  constructor(config: PublisherConfig) {
    requireCondition(repoIdentity(config.repo) === `github.com/${config.repo.toLowerCase()}`, "publisher repository must be owner/name on github.com");
    requireCondition(Number.isInteger(config.repositoryId) && config.repositoryId > 0 && Number.isInteger(config.actorId) && config.actorId > 0, "publisher numeric identities are required");
    requireCondition(/^[A-Za-z0-9-]{1,39}$/.test(config.login), "invalid publisher login");
    requireCondition(resolve(config.stateRoot) === config.stateRoot, "publisher state root must be absolute and canonical");
    const canonicalRemote = `https://github.com/${config.repo}.git`;
    requireCondition(config.remoteUrl === canonicalRemote || config.testOnly === true && config.allowLocalRemote === true, "publisher remote does not match repository");
    if (config.transportBaseUrl) requireCondition(config.testOnly === true, "custom transport is test-only");
    this.config = { ...config };
    this.#ensureStateRoot();
  }

  #ensureStateRoot(): void {
    this.#stateRootIdentity = ensurePrivateDirectorySync(this.config.stateRoot, this.#stateRootIdentity);
  }

  #stateDirectory(...components: string[]): string {
    this.#ensureStateRoot();
    const directory = join(this.config.stateRoot, ...components);
    ensurePrivateDirectorySync(directory);
    this.#ensureStateRoot();
    return directory;
  }

  async recoverLock(): Promise<void> {
    this.#ensureStateRoot();
    recoverDirectoryLockSync(join(this.config.stateRoot, "publisher.lock"));
    this.#ensureStateRoot();
  }

  async #session(): Promise<{ client: GitHubTransport; token: string; repository: Record<string, unknown> }> {
    const token = this.config.tokenResolver ? await this.config.tokenResolver() : await resolveGhToken({ login: this.config.login });
    const client = new GitHubTransport({ repo: this.config.repo, token,
      ...(this.config.transportBaseUrl ? { baseUrl: this.config.transportBaseUrl } : {}),
      ...(this.config.testOnly !== undefined ? { testOnly: this.config.testOnly } : {}) });
    const actor = await client.object("GET", "/user");
    requireCondition(actor.id === this.config.actorId && String(actor.login).toLowerCase() === this.config.login.toLowerCase() && actor.type === "User", "selected GitHub actor does not match publisher policy", "AUTH_MISMATCH");
    const repository = await client.object("GET", `/repos/${this.config.repo}`);
    requireCondition(repository.id === this.config.repositoryId && String(repository.full_name).toLowerCase() === this.config.repo.toLowerCase() && typeof repository.private === "boolean", "GitHub repository identity does not match publisher policy", "REPO_MISMATCH");
    return { client, token, repository };
  }

  async #locked<T>(callback: () => Promise<T>): Promise<T> {
    this.#ensureStateRoot();
    const path = join(this.config.stateRoot, "publisher.lock"); let owner;
    try { owner = acquireDirectoryLockSync(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new DeliveryError("another publication operation holds the repository lock", "PUBLICATION_BUSY"); throw error; }
    try { return await callback(); }
    finally { releaseDirectoryLockSync(path, owner); }
  }

  #identity(packet: Packet): { action: string; delivery: string; operation: string; requestDigest: string } {
    requireCondition(packet.schema_version === 1, "publisher packet schema must be 1");
    const action = text(packet.action, "action", 64);
    const delivery = text(packet.delivery_id, "delivery_id", 80); validateDeliveryId(delivery);
    const operation = text(packet.operation_id, "operation_id", 128);
    requireCondition((packet.repo ?? packet.target_repo) === this.config.repo, "packet repository differs from publisher scope");
    if (packet.expected_revision !== undefined) requireCondition(Number.isInteger(packet.expected_revision) && (packet.expected_revision as number) >= 0, "invalid expected revision");
    return { action, delivery, operation, requestDigest: publicationAuthorizationDigest(packet) };
  }

  #base(packet: Packet): Record<string, unknown> { const id = this.#identity(packet); return { schema_version: 1, action: id.action, delivery_id: id.delivery, operation_id: id.operation }; }

  async #intentPath(packet: Packet): Promise<string> {
    const id = this.#identity(packet); const directory = this.#stateDirectory("publication-intents", id.delivery);
    return join(directory, `${createHash("sha256").update(`${id.action}\0${id.operation}`).digest("hex")}.json`);
  }
  async #loadIntent(packet: Packet): Promise<Intent | null> {
    const path = await this.#intentPath(packet);
    try { this.#ensureStateRoot(); const info = await lstat(path); const euid = process.geteuid?.(); requireCondition(info.isFile() && !info.isSymbolicLink() && (euid === undefined || info.uid === euid) && (info.mode & 0o077) === 0, "publication intent is unsafe"); this.#ensureStateRoot(); return JSON.parse(await readFile(path, "utf8")) as Intent; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; if (error instanceof DeliveryError) throw error; throw new DeliveryError("publication intent is invalid"); }
  }
  #publisherIdentity(): Record<string, unknown> {
    return {
      repo: this.config.repo,
      repository_id: this.config.repositoryId,
      actor_id: this.config.actorId,
      login: this.config.login.toLowerCase(),
      remote_url: this.config.remoteUrl,
      transport_base_url: this.config.transportBaseUrl ?? null,
      test_only: this.config.testOnly === true,
      allow_local_remote: this.config.allowLocalRemote === true,
    };
  }
  #phaseAttestation(packet: Packet, intent: Intent | null): Omit<PublisherPhaseAttestation, "proof"> {
    const id = this.#identity(packet);
    const pushed = intent && ["pr_pending", "create_attempted", "update_attempted", "published", "blocked"].includes(intent.phase) && typeof intent.head === "string" && typeof intent.head_sha === "string"
      ? [digest({ operation_id: id.operation, request_digest: id.requestDigest, head: intent.head, head_sha: intent.head_sha, previous_sha: intent.previous_sha ?? null })]
      : [];
    return { phase: intent ? "effect_possible" : "pre_effect", operation_id: id.operation, request_digest: id.requestDigest,
      publisher_identity_digest: digest(this.#publisherIdentity()), ...(intent ? { intent_digest: digest(intent) } : {}), pushed_ref_receipts: pushed };
  }
  async #attestation(packet: Packet, intent: Intent | null): Promise<PublisherPhaseAttestation> {
    const attestation = { ...this.#phaseAttestation(packet, intent), proof: randomBytes(32).toString("hex") };
    const directory = this.#stateDirectory("phase-attestations"), path = join(directory, `${attestation.proof}.json`), temp = `${path}.${process.pid}.tmp`;
    const publisherIdentity = this.#publisherIdentity();
    const record = { schema_version: 1, repo: this.config.repo, action: packet.action, delivery_id: packet.delivery_id, operation_id: packet.operation_id,
      request_digest: publicationAuthorizationDigest(packet), request: publicationRequest(packet), publisher_identity: publisherIdentity,
      publisher_identity_digest: digest(publisherIdentity), attestation };
    const handle = await open(temp, "wx", 0o600); try { await handle.writeFile(canonicalJson(record)); await handle.sync(); } finally { await handle.close(); }
    this.#ensureStateRoot(); await rename(temp, path); const parent = await open(directory, "r"); try { await parent.sync(); } finally { await parent.close(); }
    return attestation;
  }
  async resolvePhaseAttestation(attestation: PublisherPhaseAttestation, expected: PublisherPhaseExpectedContext): Promise<PublisherPhaseAttestationResolution> {
    try {
      return await this.#locked(async () => {
        const publisherIdentity = this.#publisherIdentity(), publisherIdentityDigest = digest(publisherIdentity);
        requireCondition(expected.repo === this.config.repo && expected.delivery_id === expected.request.delivery_id && expected.action === expected.request.action
          && expected.operation_id === expected.request.operation_id && expected.request_digest === publicationAuthorizationDigest(expected.request), "publisher attestation expected context is invalid");
        requireCondition(attestation.operation_id === expected.operation_id && attestation.request_digest === expected.request_digest
          && attestation.publisher_identity_digest === publisherIdentityDigest && typeof attestation.proof === "string" && /^[0-9a-f]{64}$/.test(attestation.proof), "publisher attestation context does not match the protected request");
        const directory = this.#stateDirectory("phase-attestations"), path = join(directory, `${attestation.proof}.json`); this.#ensureStateRoot();
        const info = await lstat(path), euid = process.geteuid?.(); requireCondition(info.isFile() && !info.isSymbolicLink() && (euid === undefined || info.uid === euid) && (info.mode & 0o077) === 0 && info.size <= 256 * 1024, "publisher attestation proof is unsafe");
        const record = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
        requireCondition(record.schema_version === 1 && record.repo === expected.repo && record.action === expected.action && record.delivery_id === expected.delivery_id
          && record.operation_id === expected.operation_id && record.request_digest === expected.request_digest && canonicalJson(record.request) === canonicalJson(publicationRequest(expected.request))
          && canonicalJson(record.publisher_identity) === canonicalJson(publisherIdentity) && record.publisher_identity_digest === publisherIdentityDigest
          && canonicalJson(record.attestation) === canonicalJson(attestation), "publisher attestation proof was not issued for the protected request");
        const currentIntent = await this.#loadIntent(expected.request);
        const { proof: _proof, ...unprovedAttestation } = attestation;
        requireCondition(canonicalJson(this.#phaseAttestation(expected.request, currentIntent)) === canonicalJson(unprovedAttestation), "publisher attestation no longer matches the protected phase");
        return { trusted: true, proof_digest: digest(record) };
      });
    } catch (error) { return { trusted: false, error: error instanceof Error ? error.message : String(error) }; }
  }
  async #readOnlyAttestation(packet: Packet, unavailable: GitHubUnavailable): Promise<PublisherReadOnlyAttestation> {
    const id = this.#identity(packet), payload = object(packet.payload, "finalize request");
    requireCondition(id.action === "finalize", "read-only attestation is limited to finalization", "INVALID_ARGUMENT");
    const checkpoint = payload.checkpoint === undefined ? "ci_observed" : text(payload.checkpoint, "finalize checkpoint", 64);
    requireCondition(["ci_observed", "ready_requested", "tracking_requested"].includes(checkpoint), "invalid finalize checkpoint");
    const candidateSha = lowerSha(payload.head_sha, "expected head SHA"), retryAfterSeconds = unavailable.retryAfterSeconds;
    requireCondition(Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0, "invalid GitHub retry deadline", "OPERATION_UNRESOLVED");
    const proof = randomBytes(32).toString("hex"), publisherIdentity = this.#publisherIdentity(), publisherIdentityDigest = digest(publisherIdentity);
    const attestation: PublisherReadOnlyAttestation = { phase: "read_only", action: "finalize", operation_id: id.operation, request_digest: id.requestDigest,
      publisher_identity_digest: publisherIdentityDigest, checkpoint: checkpoint as PublisherReadOnlyAttestation["checkpoint"], candidate_sha: candidateSha,
      retry_after_seconds: retryAfterSeconds, proof };
    const directory = this.#stateDirectory("read-only-attestations"), path = join(directory, `${proof}.json`), temp = `${path}.${process.pid}.tmp`;
    const record = { schema_version: 1, repo: this.config.repo, action: id.action, delivery_id: id.delivery, operation_id: id.operation,
      request_digest: id.requestDigest, request: publicationRequest(packet), publisher_identity: publisherIdentity, publisher_identity_digest: publisherIdentityDigest, attestation };
    const handle = await open(temp, "wx", 0o600); try { await handle.writeFile(canonicalJson(record)); await handle.sync(); } finally { await handle.close(); }
    this.#ensureStateRoot(); await rename(temp, path); const parent = await open(directory, "r"); try { await parent.sync(); } finally { await parent.close(); }
    return attestation;
  }
  async resolveReadOnlyAttestation(attestation: PublisherReadOnlyAttestation, expected: PublisherPhaseExpectedContext): Promise<PublisherReadOnlyAttestationResolution> {
    try {
      return await this.#locked(async () => {
        const publisherIdentity = this.#publisherIdentity(), publisherIdentityDigest = digest(publisherIdentity), payload = object(expected.request.payload, "finalize request");
        requireCondition(expected.action === "finalize" && expected.repo === this.config.repo && expected.delivery_id === expected.request.delivery_id
          && expected.operation_id === expected.request.operation_id && expected.request_digest === publicationAuthorizationDigest(expected.request), "publisher read-only expected context is invalid");
        const checkpoint = payload.checkpoint === undefined ? "ci_observed" : text(payload.checkpoint, "finalize checkpoint", 64), candidateSha = lowerSha(payload.head_sha, "expected head SHA");
        requireCondition(attestation.phase === "read_only" && attestation.action === "finalize" && attestation.operation_id === expected.operation_id
          && attestation.request_digest === expected.request_digest && attestation.publisher_identity_digest === publisherIdentityDigest
          && attestation.checkpoint === checkpoint && attestation.candidate_sha === candidateSha && Number.isFinite(attestation.retry_after_seconds)
          && attestation.retry_after_seconds >= 0 && /^[0-9a-f]{64}$/.test(attestation.proof), "publisher read-only attestation context differs from the protected request");
        const directory = this.#stateDirectory("read-only-attestations"), path = join(directory, `${attestation.proof}.json`); this.#ensureStateRoot();
        const info = await lstat(path), euid = process.geteuid?.(); requireCondition(info.isFile() && !info.isSymbolicLink() && (euid === undefined || info.uid === euid)
          && (info.mode & 0o077) === 0 && info.size <= 256 * 1024, "publisher read-only attestation proof is unsafe");
        const record = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
        requireCondition(record.schema_version === 1 && record.repo === expected.repo && record.action === expected.action && record.delivery_id === expected.delivery_id
          && record.operation_id === expected.operation_id && record.request_digest === expected.request_digest && canonicalJson(record.request) === canonicalJson(publicationRequest(expected.request))
          && canonicalJson(record.publisher_identity) === canonicalJson(publisherIdentity) && record.publisher_identity_digest === publisherIdentityDigest
          && canonicalJson(record.attestation) === canonicalJson(attestation), "publisher read-only attestation proof was not issued for the protected request");
        return { trusted: true, proof_digest: digest(record) };
      });
    } catch (error) { return { trusted: false, error: error instanceof Error ? error.message : String(error) }; }
  }
  async #finalizeWithAttestation(packet: Packet): Promise<Record<string, unknown>> {
    try { return await this.#finalize(packet); }
    catch (error) {
      if (!(error instanceof GitHubUnavailable)) throw error;
      throw new PublisherReadOnlyRefusal(error.message, await this.#readOnlyAttestation(packet, error));
    }
  }
  async inspectPublication(request: JsonObject): Promise<PublisherPublicationInspection> {
    return this.#locked(async () => {
      const id = this.#identity(request);
      if (id.action === "export_handoff") return this.#inspectHandoff(request, id);
      if (id.action === "bind_manual_pr") return this.#inspectManualPull(request, id);
      if (id.action === "finalize") return this.#inspectReadOnly(request, id, () => this.#finalizeWithAttestation(request));
      requireCondition(id.action === "publish_issue" || id.action === "publish_plan" || id.action === "publish_implementation", "publication action does not support readback-only inspection", "INVALID_ARGUMENT");
      const intent = await this.#loadIntent(request);
      if (!intent) return { status: "absent", operation_id: id.operation, request_digest: id.requestDigest };
      requireCondition(intent.repo === this.config.repo && intent.repository_id === this.config.repositoryId && intent.actor_id === this.config.actorId
        && intent.publisher_identity_digest === digest(this.#publisherIdentity()) && intent.action === id.action && intent.delivery_id === id.delivery
        && intent.operation_id === id.operation && intent.request_digest === id.requestDigest,
      "publication intent differs from the exact configured issuer or protected request", "INTENT_CONFLICT");
      if (id.action === "publish_plan" || id.action === "publish_implementation") return this.#inspectPull(request, id, intent);
      const receipt = (): JsonObject => {
        const number = integer(intent.number, "issue number"), nodeId = text(intent.node_id, "issue node ID", 256);
        return { number, node_id: nodeId, url: `https://github.com/${this.config.repo}/issues/${number}` };
      };
      if (intent.phase === "published") return { status: "completed", operation_id: id.operation, request_digest: id.requestDigest, receipt: receipt() };
      if (intent.phase === "blocked" && intent.reason === "create_refused") return { status: "failed", operation_id: id.operation, request_digest: id.requestDigest, error: "GitHub definitively refused issue creation before an effect" };
      if (intent.phase !== "create_attempted" && !(intent.phase === "blocked" && intent.reason === "ambiguous_readback")) return { status: "uncertain", operation_id: id.operation, request_digest: id.requestDigest, error: `issue publication phase ${intent.phase} is not terminal` };
      try {
        const payload = object(request.payload, "issue payload"), title = text(payload.title, "issue title", 512), originalBody = typeof payload.body === "string" ? payload.body : "";
        requireCondition(Buffer.byteLength(originalBody) <= 64 * 1024, "issue body exceeds limit");
        const marker = issueMarker(this.config, request, payload), body = `${originalBody}${originalBody ? "\n\n" : ""}${marker}`;
        requireCondition(intent.marker === marker, "issue publication marker differs from the protected request", "INTENT_CONFLICT");
        const { client } = await this.#session(), rows = await client.pages(`/repos/${this.config.repo}/issues`, { state: "all" });
        const matches = rows.filter((row) => typeof row.body === "string" && row.body.includes(marker));
        if (matches.length !== 1) return { status: "uncertain", operation_id: id.operation, request_digest: id.requestDigest, error: `issue readback matched ${matches.length} records` };
        const issue = matches[0]!, number = integer(issue.number, "issue number"), issueUser = object(issue.user, "issue author");
        requireCondition(issue.pull_request === undefined && issue.title === title && issue.body === body
          && issue.repository_url === `https://api.github.com/repos/${this.config.repo}` && issue.url === `https://api.github.com/repos/${this.config.repo}/issues/${number}`
          && issue.html_url === `https://github.com/${this.config.repo}/issues/${number}` && issueUser.id === this.config.actorId
          && String(issueUser.login).toLowerCase() === this.config.login.toLowerCase() && issueUser.type === "User" && issue.performed_via_github_app == null,
        "issue readback differs from authorized payload");
        const exact = await client.object("GET", `/repos/${this.config.repo}/issues/${number}`);
        requireCondition(exact.id === issue.id && exact.node_id === issue.node_id && exact.title === title && exact.body === body, "authoritative issue readback changed");
        await this.#journal(request, "published", { marker, number, node_id: exact.node_id, remote_id: exact.id });
        const published = await this.#loadIntent(request); requireCondition(published?.phase === "published", "published issue journal was not retained", "OPERATION_UNRESOLVED");
        const publishedReceipt = { number, node_id: text(exact.node_id, "issue node ID", 256), url: `https://github.com/${this.config.repo}/issues/${number}` };
        return { status: "completed", operation_id: id.operation, request_digest: id.requestDigest, receipt: publishedReceipt };
      } catch (error) {
        return { status: "uncertain", operation_id: id.operation, request_digest: id.requestDigest, error: (error instanceof Error ? error.message : String(error)).replace(/[\r\n\t]+/g, " ").slice(0, 500) };
      }
    });
  }

  async #inspectHandoff(request: JsonObject, id: { action: string; delivery: string; operation: string; requestDigest: string }): Promise<PublisherPublicationInspection> {
    try {
      const handoff = await this.#loadHandoff(request), expected = object(request.expected, "expected publication"), payload = object(request.payload, "handoff payload");
      const exact = { repo: this.config.repo, repository_id: this.config.repositoryId, remote: this.config.remoteUrl,
        head: expected.head, head_sha: expected.head_sha, base: expected.base, base_sha: expected.base_sha,
        title: payload.title, body: payload.body, bundle: payload.bundle, allowed_paths: payload.allowed_paths,
        request_digest: id.requestDigest, instructions: "Publish the exact candidate branch and open a draft pull request, then bind its number." };
      requireCondition(canonicalJson(handoff) === canonicalJson(exact), "manual handoff differs from the protected export request", "INTENT_CONFLICT");
      return { status: "completed", operation_id: id.operation, request_digest: id.requestDigest,
        receipt: { ...this.#base(request), status: "manual_handoff", handoff: handoff as JsonObject } };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "absent", operation_id: id.operation, request_digest: id.requestDigest };
      return this.#inspectionFailure(id, error, "uncertain");
    }
  }

  async #inspectReadOnly(request: JsonObject, id: { action: string; delivery: string; operation: string; requestDigest: string }, inspect: () => Promise<Record<string, unknown>>): Promise<PublisherPublicationInspection> {
    try { return { status: "completed", operation_id: id.operation, request_digest: id.requestDigest, receipt: await inspect() as JsonObject }; }
    catch (error) { if (error instanceof PublisherReadOnlyRefusal) throw error; return this.#inspectionFailure(id, error, "failed"); }
  }

  async #inspectManualPull(request: JsonObject, id: { action: string; delivery: string; operation: string; requestDigest: string }): Promise<PublisherPublicationInspection> {
    return this.#inspectReadOnly(request, id, async () => {
      const expected = object(request.expected, "expected publication"), payload = object(request.payload, "manual binding"), handoff = await this.#loadHandoff(request);
      const number = integer(payload.number, "pull request number"), title = text(payload.title, "pull request title", 512), body = text(payload.body, "pull request body", 256 * 1024);
      for (const [key, value] of Object.entries({ repo: this.config.repo, repository_id: this.config.repositoryId, head: expected.head, head_sha: expected.head_sha, base: expected.base, base_sha: expected.base_sha, title, body })) requireCondition(handoff[key] === value, "manual binding differs from protected exported handoff");
      const { client } = await this.#session(), pr = await client.object("GET", `/repos/${this.config.repo}/pulls/${number}`);
      this.#verifyPull(pr, expected, title, body, number);
      return { ...this.#base(request), status: "bound", pr: this.#publicPull(pr), evidence: { mode: "read_only_manual_binding", writes: 0 } };
    });
  }

  async #inspectPull(request: JsonObject, id: { action: string; delivery: string; operation: string; requestDigest: string }, intent: Intent): Promise<PublisherPublicationInspection> {
    const expected = object(request.expected, "expected publication"), payload = object(request.payload, "pull request payload");
    const head = text(expected.head, "head", 256), base = text(expected.base, "base", 256), sha = lowerSha(expected.head_sha, "candidate SHA"), baseSha = lowerSha(expected.base_sha, "base SHA");
    const previousSha = expected.previous_sha === null || expected.previous_sha === undefined ? null : lowerSha(expected.previous_sha, "previous SHA");
    const priorNumber = expected.number === undefined || expected.number === null ? undefined : integer(expected.number, "bound pull request number");
    const title = text(payload.title, "pull request title", 512), body = text(payload.body, "pull request body", 256 * 1024);
    const completed = (number: number, nodeId: string): PublisherPublicationInspection => ({ status: "completed", operation_id: id.operation, request_digest: id.requestDigest,
      receipt: { ...this.#base(request), status: "published", pr: { number, node_id: nodeId, url: `https://github.com/${this.config.repo}/pull/${number}`,
        repo: this.config.repo, head, head_sha: sha, base, base_sha: baseSha, draft: true, state: "OPEN", body } } });
    if (intent.phase === "published") return completed(integer(intent.number, "pull request number"), text(intent.node_id, "pull request node ID", 256));
    try {
      const { client, token } = await this.#session();
      const git = new TrustedGit({ root: this.#stateDirectory("trusted-git"), remoteUrl: this.config.remoteUrl,
        ...(this.config.remoteUrl.startsWith("https:") ? { token } : {}), allowLocalRemote: this.config.testOnly === true && this.config.allowLocalRemote === true });
      await git.open();
      try {
        const remoteHead = await git.remoteHead(head), current = await this.#findPull(client, head);
        if (intent.phase === "push_pending" && remoteHead === previousSha && current === null) return { status: "absent", operation_id: id.operation, request_digest: id.requestDigest };
        if (remoteHead !== sha || current === null) return { status: "uncertain", operation_id: id.operation, request_digest: id.requestDigest, error: "pull request publication has no unique exact completed readback" };
        this.#verifyPull(current, expected, title, body, priorNumber);
        await this.#journal(request, "published", { number: current.number, node_id: current.node_id, head, head_sha: sha });
        return completed(integer(current.number, "pull request number"), text(current.node_id, "pull request node ID", 256));
      } finally { await git.close(); }
    } catch (error) { return this.#inspectionFailure(id, error, "uncertain"); }
  }

  #inspectionFailure(id: { action: string; delivery: string; operation: string; requestDigest: string }, error: unknown, status: "failed" | "uncertain"): PublisherPublicationInspection {
    return { status, operation_id: id.operation, request_digest: id.requestDigest,
      error: (error instanceof Error ? error.message : String(error)).replace(/[\r\n\t]+/g, " ").slice(0, 500),
      error_code: error instanceof DeliveryError ? error.code : "DELIVERY_BLOCKED" };
  }
  async #publicationSession(packet: Packet, intent: Intent | null): Promise<{ client: GitHubTransport; token: string; repository: Record<string, unknown> }> {
    try { return await this.#session(); }
    catch (error) {
      if (error instanceof DeliveryError && (error.code === "AUTH_MISMATCH" || error.code === "REPO_MISMATCH")) throw new PublisherRefusal(error.message, error.code, await this.#attestation(packet, intent));
      throw error;
    }
  }
  async #saveIntent(packet: Packet, value: Intent): Promise<void> {
    const path = await this.#intentPath(packet); const temp = `${path}.${process.pid}.tmp`;
    this.#ensureStateRoot();
    const handle = await open(temp, "wx", 0o600);
    try { await handle.writeFile(canonicalJson(value)); await handle.sync(); } finally { await handle.close(); }
    this.#ensureStateRoot();
    await rename(temp, path); const directory = await open(dirname(path), "r"); try { await directory.sync(); } finally { await directory.close(); }
  }
  async #handoffPath(packet: Packet): Promise<string> { const id = this.#identity(packet); const directory = this.#stateDirectory("manual-handoffs"); return join(directory, `${id.delivery}.json`); }
  async #saveHandoff(packet: Packet, value: Record<string, unknown>): Promise<void> {
    const path = await this.#handoffPath(packet), temp = `${path}.${process.pid}.tmp`; this.#ensureStateRoot(); const handle = await open(temp, "wx", 0o600);
    try { await handle.writeFile(canonicalJson(value)); await handle.sync(); } finally { await handle.close(); }
    this.#ensureStateRoot();
    await rename(temp, path);
  }
  async #loadHandoff(packet: Packet): Promise<Record<string, unknown>> {
    const path = await this.#handoffPath(packet); this.#ensureStateRoot(); const info = await lstat(path); const euid = process.geteuid?.();
    requireCondition(info.isFile() && !info.isSymbolicLink() && (euid === undefined || info.uid === euid) && (info.mode & 0o077) === 0, "manual handoff record is unsafe");
    this.#ensureStateRoot();
    return object(JSON.parse(await readFile(path, "utf8")), "manual handoff record");
  }
  async #journal(packet: Packet, phase: string, fields: Record<string, unknown> = {}): Promise<Intent> {
    const id = this.#identity(packet); const prior = await this.#loadIntent(packet);
    requireCondition(!prior || prior.request_digest === id.requestDigest, "publication intent differs from exact authorized request", "INTENT_CONFLICT");
    const publisherIdentityDigest = digest(this.#publisherIdentity());
    requireCondition(!prior || prior.publisher_identity_digest === publisherIdentityDigest, "publication intent differs from exact configured issuer", "INTENT_CONFLICT");
    const value = { ...(prior ?? {}), schema_version: 1, repo: this.config.repo, repository_id: this.config.repositoryId,
      actor_id: this.config.actorId, publisher_identity_digest: publisherIdentityDigest, action: id.action, delivery_id: id.delivery, operation_id: id.operation,
      request_digest: id.requestDigest, phase, ...fields, updated_at: new Date().toISOString() } as Intent;
    await this.#saveIntent(packet, value); return value;
  }
  #authorize(packet: Packet): void { requireCondition(packet.authorized_digest === publicationAuthorizationDigest(packet), "publication requires exact explicit authorization", "AUTHORIZATION_REQUIRED"); }

  async execute(packet: Packet): Promise<Record<string, unknown>> {
    const { action } = this.#identity(packet);
    if (action === "preflight") { await this.#session(); return { ...this.#base(packet), status: "ready", evidence: { repo: this.config.repo, repository_id: this.config.repositoryId, actor_id: this.config.actorId, login: this.config.login } }; }
    if (action === "rank_snapshot") return this.#rankSnapshot(packet);
    if (action === "publish_issue") return this.#publishIssue(packet);
    if (action === "publish_plan" || action === "publish_implementation") return this.#publishPull(packet);
    if (action === "export_handoff") return this.#exportHandoff(packet);
    if (action === "bind_manual_pr") return this.#bindManualPull(packet);
    if (action === "list_reviews") return this.#listReviews(packet);
    if (action === "finalize") return this.#finalizeWithAttestation(packet);
    throw new DeliveryError(`unsupported publisher action: ${action}`);
  }

  async #exportHandoff(packet: Packet): Promise<Record<string, unknown>> {
    return this.#locked(async () => {
    const expected = object(packet.expected, "expected publication"), payload = object(packet.payload, "handoff payload");
    const head = text(expected.head, "head", 256), base = text(expected.base, "base", 256); validateRef(head, "head"); validateRef(base, "base");
    const headSha = lowerSha(expected.head_sha, "candidate SHA"), baseSha = lowerSha(expected.base_sha, "base SHA");
    const title = text(payload.title, "pull request title", 512), body = text(payload.body, "pull request body", 256 * 1024), bundle = text(payload.bundle, "bundle path", 4096);
    const session = await this.#session(); const paths = payload.allowed_paths; requireCondition(Array.isArray(paths) && paths.length > 0 && paths.every((path) => typeof path === "string"), "handoff path allowlist is required");
    const git = new TrustedGit({ root: this.#stateDirectory("trusted-git"), remoteUrl: this.config.remoteUrl, ...(this.config.remoteUrl.startsWith("https:") ? { token: session.token } : {}), allowLocalRemote: this.config.testOnly === true && this.config.allowLocalRemote === true });
    await git.open(); try { requireCondition(await git.remoteHead(base) === baseSha, "remote base branch moved before handoff export"); await git.fetchBase(base, baseSha); await git.importCandidate(bundle, headSha); await git.verifyCandidate(baseSha, headSha, paths as string[]); } finally { await git.close(); }
    const handoff = { repo: this.config.repo, repository_id: this.config.repositoryId,
      remote: this.config.remoteUrl, head, head_sha: headSha, base, base_sha: baseSha, title, body, bundle,
      allowed_paths: paths, request_digest: publicationAuthorizationDigest(packet), instructions: "Publish the exact candidate branch and open a draft pull request, then bind its number." };
    await this.#saveHandoff(packet, handoff);
    return { ...this.#base(packet), status: "manual_handoff", handoff };
    });
  }

  async #bindManualPull(packet: Packet): Promise<Record<string, unknown>> {
    return this.#locked(async () => {
    const expected = object(packet.expected, "expected publication"), payload = object(packet.payload, "manual binding"), handoff = await this.#loadHandoff(packet);
    const number = integer(payload.number, "pull request number"), title = text(payload.title, "pull request title", 512), body = text(payload.body, "pull request body", 256 * 1024);
    for (const [key, value] of Object.entries({ repo: this.config.repo, repository_id: this.config.repositoryId, head: expected.head, head_sha: expected.head_sha, base: expected.base, base_sha: expected.base_sha, title, body })) requireCondition(handoff[key] === value, "manual binding differs from protected exported handoff");
    const { client } = await this.#session(); const pr = await client.object("GET", `/repos/${this.config.repo}/pulls/${number}`);
    this.#verifyPull(pr, expected, title, body, number);
    return { ...this.#base(packet), status: "bound", pr: this.#publicPull(pr), evidence: { mode: "read_only_manual_binding", writes: 0 } };
    });
  }

  async #publishIssue(packet: Packet): Promise<Record<string, unknown>> {
    return this.#locked(async () => {
    this.#authorize(packet); const payload = object(packet.payload, "issue payload");
    const title = text(payload.title, "issue title", 512); const originalBody = typeof payload.body === "string" ? payload.body : "";
    requireCondition(Buffer.byteLength(originalBody) <= 64 * 1024, "issue body exceeds limit");
    const marker = issueMarker(this.config, packet, payload); const body = `${originalBody}${originalBody ? "\n\n" : ""}${marker}`;
    let intent = await this.#loadIntent(packet); const { client } = await this.#publicationSession(packet, intent);
    if (!intent) {
      const existing = await client.pages(`/repos/${this.config.repo}/issues`, { state: "all" });
      requireCondition(!existing.some((row) => typeof row.body === "string" && row.body.includes(marker)), "issue operation marker already exists before intent", "INTENT_CONFLICT");
      intent = await this.#journal(packet, "create_attempted", { marker });
      try { await client.object("POST", `/repos/${this.config.repo}/issues`, { title, body }); }
      catch (error) { if (error instanceof DeliveryError && error.code === "GITHUB_REFUSED") { await this.#journal(packet, "blocked", { marker, reason: "create_refused" }); throw error; } }
    }
    requireCondition(intent.phase === "create_attempted" || intent.phase === "published", "issue intent is not resumable");
    const rows = await client.pages(`/repos/${this.config.repo}/issues`, { state: "all" });
    const matches = rows.filter((row) => typeof row.body === "string" && row.body.includes(marker));
    if (matches.length !== 1) { await this.#journal(packet, "blocked", { marker, reason: "ambiguous_readback", match_count: matches.length }); throw new DeliveryError("issue publication cannot be reconciled uniquely", "PUBLICATION_AMBIGUOUS"); }
    const issue = matches[0]!; const number = integer(issue.number, "issue number");
    const issueUser = object(issue.user, "issue author");
    requireCondition(issue.pull_request === undefined && issue.title === title && issue.body === body
      && issue.repository_url === `https://api.github.com/repos/${this.config.repo}`
      && issue.url === `https://api.github.com/repos/${this.config.repo}/issues/${number}`
      && issue.html_url === `https://github.com/${this.config.repo}/issues/${number}`
      && issueUser.id === this.config.actorId && String(issueUser.login).toLowerCase() === this.config.login.toLowerCase()
      && issueUser.type === "User" && issue.performed_via_github_app == null, "issue readback differs from authorized payload");
    const exact = await client.object("GET", `/repos/${this.config.repo}/issues/${number}`);
    requireCondition(exact.id === issue.id && exact.node_id === issue.node_id && exact.title === title && exact.body === body, "authoritative issue readback changed");
    await this.#journal(packet, "published", { marker, number, node_id: exact.node_id, remote_id: exact.id });
    const publishedIntent = await this.#loadIntent(packet);
    return { ...this.#base(packet), status: "published", issue: { number, node_id: exact.node_id, url: exact.html_url }, attestation: await this.#attestation(packet, publishedIntent) };
    });
  }

  async #findPull(client: GitHubTransport, head: string): Promise<Record<string, unknown> | null> {
    const rows = await client.pages(`/repos/${this.config.repo}/pulls`, { state: "all", head: `${this.config.repo.split("/")[0]}:${head}` });
    requireCondition(rows.length <= 1, "publication branch has conflicting pull requests", "PUBLICATION_AMBIGUOUS");
    if (!rows.length) return null;
    return client.object("GET", `/repos/${this.config.repo}/pulls/${integer(rows[0]!.number, "pull request number")}`);
  }
  #verifyPull(pr: Record<string, unknown>, expected: Record<string, unknown>, title: string, body: string, priorNumber?: number): void {
    const head = object(pr.head, "pull request head"), base = object(pr.base, "pull request base");
    requireCondition((priorNumber === undefined || pr.number === priorNumber) && pr.state === "open" && pr.draft === true && pr.title === title && pr.body === body,
      "pull request state or payload differs from authorized handoff");
    requireCondition(head.ref === expected.head && head.sha === expected.head_sha && base.ref === expected.base && base.sha === expected.base_sha && (head.repo as Record<string, unknown>)?.id === this.config.repositoryId && (base.repo as Record<string, unknown>)?.id === this.config.repositoryId, "pull request Git binding differs from authorized handoff");
    const author = object(pr.user, "pull request author");
    requireCondition(author.id === this.config.actorId && String(author.login).toLowerCase() === this.config.login.toLowerCase(), "pull request author differs from selected publisher");
  }
  #verifyPullBinding(pr: Record<string, unknown>, expected: Record<string, unknown>, number: number, headSha: string | null): void {
    const head = object(pr.head, "pull request head"), base = object(pr.base, "pull request base"), author = object(pr.user, "pull request author");
    requireCondition(headSha !== null && pr.number === number && pr.state === "open" && pr.draft === true
      && head.ref === expected.head && head.sha === headSha && base.ref === expected.base && base.sha === expected.base_sha
      && (head.repo as Record<string, unknown>)?.id === this.config.repositoryId && (base.repo as Record<string, unknown>)?.id === this.config.repositoryId
      && author.id === this.config.actorId && String(author.login).toLowerCase() === this.config.login.toLowerCase(), "bound pull request differs before publication");
  }

  async #publishPull(packet: Packet): Promise<Record<string, unknown>> {
    return this.#locked(async () => {
    this.#authorize(packet); const expected = object(packet.expected, "expected publication"); const payload = object(packet.payload, "pull request payload");
    const head = text(expected.head, "head", 256), base = text(expected.base, "base", 256); validateRef(head, "head"); validateRef(base, "base");
    const sha = lowerSha(expected.head_sha, "candidate SHA"), baseSha = lowerSha(expected.base_sha, "base SHA");
    const previousSha = expected.previous_sha === null || expected.previous_sha === undefined ? null : lowerSha(expected.previous_sha, "previous SHA");
    const priorNumber = expected.number === undefined || expected.number === null ? undefined : integer(expected.number, "bound pull request number");
    const title = text(payload.title, "pull request title", 512); const body = text(payload.body, "pull request body", 256 * 1024);
    const bundle = text(payload.bundle, "bundle path", 4096); const paths = payload.allowed_paths;
    requireCondition(Array.isArray(paths) && paths.length > 0 && paths.every((path) => typeof path === "string"), "pull request path allowlist is required");
    let intent = await this.#loadIntent(packet); const session = await this.#publicationSession(packet, intent), client = session.client;
    const gitToken = this.config.remoteUrl.startsWith("https:") ? session.token : undefined;
    const git = new TrustedGit({ root: this.#stateDirectory("trusted-git"), remoteUrl: this.config.remoteUrl,
      ...(gitToken ? { token: gitToken } : {}), allowLocalRemote: this.config.testOnly === true && this.config.allowLocalRemote === true });
    await git.open();
    try {
      requireCondition(await git.remoteHead(base) === baseSha, "remote base branch moved before publication", "GIT_BASE_MOVED");
      await git.fetchBase(base, baseSha); await git.importCandidate(bundle, sha); await git.requireAncestor(baseSha, sha); await git.verifyCandidate(previousSha ?? baseSha, sha, paths as string[]);
      if (!intent) {
        requireCondition(await git.remoteHead(head) === previousSha, "publication branch changed before intent");
        const existing = await this.#findPull(client, head);
        if (priorNumber === undefined) requireCondition(existing === null, "unbound publication branch already has a pull request");
        else { requireCondition(existing !== null, "bound pull request is missing before publication"); this.#verifyPullBinding(existing, expected, priorNumber, previousSha); }
        intent = await this.#journal(packet, "push_pending", { head, head_sha: sha, previous_sha: previousSha });
      }
      if (intent.phase === "push_pending") {
        if (await git.remoteHead(head) !== sha) await git.push(head, sha, previousSha);
        requireCondition(await git.remoteHead(head) === sha, "branch push cannot be reconciled");
        intent = await this.#journal(packet, "pr_pending", { head, head_sha: sha, previous_sha: previousSha });
      }
      if (intent.phase === "pr_pending") {
        let current = await this.#findPull(client, head);
        if (priorNumber === undefined && current === null) {
          intent = await this.#journal(packet, "create_attempted", { head, head_sha: sha, previous_sha: previousSha });
          try { await client.object("POST", `/repos/${this.config.repo}/pulls`, { title, body, head, base, draft: true }); }
          catch (error) { if (error instanceof DeliveryError && error.code === "GITHUB_REFUSED") { await this.#journal(packet, "blocked", { reason: "create_refused" }); throw error; } }
        } else if (priorNumber !== undefined) {
          requireCondition(current?.number === priorNumber, "bound pull request is missing");
          intent = await this.#journal(packet, "update_attempted", { head, head_sha: sha, previous_sha: previousSha, number: priorNumber });
          try { await client.object("PATCH", `/repos/${this.config.repo}/pulls/${priorNumber}`, { title, body }); }
          catch (error) { if (error instanceof DeliveryError && error.code === "GITHUB_REFUSED") { await this.#journal(packet, "blocked", { reason: "update_refused" }); throw error; } }
        }
      }
      let current: Record<string, unknown> | null;
      try { current = await this.#findPull(client, head); }
      catch (error) { await this.#journal(packet, "blocked", { reason: "ambiguous_readback" }); throw error; }
      if (current === null) { await this.#journal(packet, "blocked", { reason: "missing_readback" }); throw new DeliveryError("pull request publication cannot be reconciled uniquely", "PUBLICATION_AMBIGUOUS"); }
      try { this.#verifyPull(current, expected, title, body, priorNumber); }
      catch (error) { await this.#journal(packet, "blocked", { reason: "mismatched_readback" }); throw error; }
      requireCondition(await git.remoteHead(head) === sha, "publication branch changed during pull request readback");
      await this.#journal(packet, "published", { number: current.number, node_id: current.node_id, head, head_sha: sha });
      const publishedIntent = await this.#loadIntent(packet);
      return { ...this.#base(packet), status: "published", pr: this.#publicPull(current), attestation: await this.#attestation(packet, publishedIntent) };
    } finally { await git.close(); }
    });
  }

  #publicPull(pr: Record<string, unknown>): Record<string, unknown> { const head = object(pr.head, "pull head"), base = object(pr.base, "pull base"); return { number: pr.number, node_id: pr.node_id, url: pr.html_url, repo: this.config.repo, head: head.ref, head_sha: head.sha, base: base.ref, base_sha: base.sha, draft: pr.draft, state: String(pr.state).toUpperCase(), body: pr.body }; }

  async #rankSnapshot(packet: Packet): Promise<Record<string, unknown>> {
    const { client, repository } = await this.#session();
    const issueRows = await client.pages(`/repos/${this.config.repo}/issues`, { state: "all", sort: "created", direction: "asc" });
    const pullRows = await client.pages(`/repos/${this.config.repo}/pulls`, { state: "open" });
    const allIssues = issueRows.filter((row) => row.pull_request === undefined).map((row) => ({
      number: integer(row.number, "issue number"), id: row.id, node_id: row.node_id, title: row.title, body: row.body, state: row.state,
      labels: Array.isArray(row.labels) ? row.labels.map((label) => typeof label === "string" ? { id: null, name: label } : { id: (label as Record<string, unknown>).id, name: (label as Record<string, unknown>).name }) : [],
      author: { id: (row.user as Record<string, unknown>)?.id, login: (row.user as Record<string, unknown>)?.login, type: (row.user as Record<string, unknown>)?.type },
      assignees: Array.isArray(row.assignees) ? row.assignees.map((user) => ({ id: (user as Record<string, unknown>).id, login: (user as Record<string, unknown>).login })) : [],
      milestone: row.milestone, created_at: row.created_at, updated_at: row.updated_at, html_url: row.html_url, pull_request: false,
    }));
    const issues = allIssues.filter((issue) => issue.state === "open"), issuesByNumber = new Map(allIssues.map((issue) => [issue.number, issue]));
    const openPrs = pullRows.map((row) => ({ number: row.number, id: row.id, node_id: row.node_id, title: row.title, body: row.body,
      state: row.state, draft: row.draft, head: { ref: (row.head as Record<string, unknown>)?.ref, sha: (row.head as Record<string, unknown>)?.sha, repo_id: ((row.head as Record<string, unknown>)?.repo as Record<string, unknown>)?.id },
      base: { ref: (row.base as Record<string, unknown>)?.ref, sha: (row.base as Record<string, unknown>)?.sha, repo_id: ((row.base as Record<string, unknown>)?.repo as Record<string, unknown>)?.id },
      author: { id: (row.user as Record<string, unknown>)?.id, login: (row.user as Record<string, unknown>)?.login, type: (row.user as Record<string, unknown>)?.type },
      labels: Array.isArray(row.labels) ? row.labels.map((label) => typeof label === "string" ? label : (label as Record<string, unknown>).name) : [], html_url: row.html_url }));
    const dependencyByIssue = new Map(issues.map((issue) => [issue.number, { issue: issue.number, blocks: [] as number[], blocked_by: [] as number[], related: [] as number[], unresolved: [] as string[] }]));
    for (const source of allIssues) {
      const output = dependencyByIssue.get(source.number), body = typeof source.body === "string" ? source.body : "";
      for (const line of body.split(/\r?\n/)) {
        const direct = /\b(blocked by|depends on|requires)\b/i.test(line), reverse = !direct && /\bblocks\b/i.test(line), related = !direct && !reverse && /\b(related to|relates to|see)\b/i.test(line);
        if (!direct && !reverse && !related) continue;
        const references = [...line.matchAll(/(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+))?#([1-9][0-9]*)/g)];
        if (references.length === 0 && output) output.unresolved.push(line.trim());
        for (const reference of references) {
          const qualifiedRepo = reference[1], number = Number(reference[2]), rendered = reference[0];
          if (qualifiedRepo && qualifiedRepo.toLowerCase() !== this.config.repo.toLowerCase()) { if (output) output.unresolved.push(rendered); continue; }
          const target = issuesByNumber.get(number);
          if (!target) { if (output) output.unresolved.push(`#${number}`); continue; }
          if (related) { if (output) output.related.push(number); continue; }
          if (reverse) {
            if (output) output.blocks.push(number);
            if (source.state === "open" && target.state === "open") dependencyByIssue.get(number)?.blocked_by.push(source.number);
            continue;
          }
          if (target.state === "open" && output) output.blocked_by.push(number);
        }
      }
    }
    const dependencies = [...dependencyByIssue.values()].map((value) => ({ issue: value.issue, blocks: [...new Set(value.blocks)], blocked_by: [...new Set(value.blocked_by)], related: [...new Set(value.related)], unresolved: [...new Set(value.unresolved)] }));
    return { ...this.#base(packet), status: "snapshot", repo: { id: repository.id, full_name: repository.full_name, private: repository.private, default_branch: repository.default_branch },
      issues, open_prs: openPrs, dependencies, coverage: { issues_complete: true, open_prs_complete: true, dependency_parser: "github-keywords-v1", unresolved_count: dependencies.reduce((sum, value) => sum + value.unresolved.length, 0) } };
  }

  async #listReviews(packet: Packet): Promise<Record<string, unknown>> {
    const payload = object(packet.payload, "review request"), expected = object(packet.expected, "review binding"); const number = integer(payload.number, "pull request number"); const { client } = await this.#session();
    const pr = await client.object("GET", `/repos/${this.config.repo}/pulls/${number}`); const reviews = await client.pages(`/repos/${this.config.repo}/pulls/${number}/reviews`, {});
    this.#verifyPull(pr, expected, text(expected.title, "bound title", 512), text(expected.body, "bound body", 256 * 1024), number);
    return { ...this.#base(packet), status: "snapshot", pr: this.#publicPull(pr), reviews: reviews.map((review) => ({
      id: review.id, node_id: review.node_id, state: review.state, submitted_at: review.submitted_at,
      commit_id: review.commit_id, body: review.body, dismissed: review.dismissed,
      performed_via_github_app: review.performed_via_github_app,
      user: { id: (review.user as Record<string, unknown>)?.id, type: (review.user as Record<string, unknown>)?.type,
        login: (review.user as Record<string, unknown>)?.login },
    })) };
  }

  async #finalize(packet: Packet): Promise<Record<string, unknown>> {
    const payload = object(packet.payload, "finalize request"), expected = object(packet.expected, "finalize binding"); const number = integer(payload.number, "pull request number"); const expectedSha = lowerSha(payload.head_sha, "expected head SHA"); const { client } = await this.#session();
    const pr = await client.object("GET", `/repos/${this.config.repo}/pulls/${number}`), head = object(pr.head, "pull request head"), base = object(pr.base, "pull request base"), author = object(pr.user, "pull request author");
    requireCondition(pr.number === number && pr.state === "open" && head.sha === expectedSha && head.ref === expected.head && base.ref === expected.base && base.sha === expected.base_sha
      && (head.repo as Record<string, unknown>)?.id === this.config.repositoryId && (base.repo as Record<string, unknown>)?.id === this.config.repositoryId
      && author.id === this.config.actorId && String(author.login).toLowerCase() === this.config.login.toLowerCase()
      && pr.title === expected.title && pr.body === expected.body, "finalize pull request binding changed");
    const checkpoint = payload.checkpoint === undefined ? "ci_observed" : text(payload.checkpoint, "finalize checkpoint", 64);
    requireCondition(["ci_observed", "ready_requested", "tracking_requested"].includes(checkpoint), "invalid finalize checkpoint");
    const trackingLabel = payload.tracking_label === undefined ? null : text(payload.tracking_label, "tracking label", 128);
    const labels = Array.isArray(pr.labels) ? pr.labels.map((label) => typeof label === "string" ? label : String((label as Record<string, unknown>).name)) : [];
    const hasTracking = trackingLabel !== null && labels.includes(trackingLabel);
    requireCondition(!(pr.draft === false && checkpoint === "ci_observed"), "pull request was marked ready before the requested checkpoint", "HUMAN_ACTION_DRIFT");
    requireCondition(!(hasTracking && checkpoint !== "tracking_requested"), "tracking label was applied before the requested checkpoint", "HUMAN_ACTION_DRIFT");
    const runs = await client.checkRuns(`/repos/${this.config.repo}/commits/${expectedSha}/check-runs`, expectedSha); const status = await client.object("GET", `/repos/${this.config.repo}/commits/${expectedSha}/status`);
    const runStatuses = new Set(["queued", "in_progress", "completed", "waiting", "requested", "pending"]), conclusions = new Set(["success", "failure", "neutral", "cancelled", "skipped", "timed_out", "action_required", "startup_failure", "stale"]);
    requireCondition(runs.every((run) => typeof run.name === "string" && run.name.length > 0 && runStatuses.has(String(run.status))
      && (run.conclusion === null || conclusions.has(String(run.conclusion)))), "GitHub returned a malformed check run");
    const failed = runs.some((run) => run.status === "completed" && !["success", "neutral", "skipped"].includes(String(run.conclusion))) || ["failure", "error"].includes(String(status.state));
    const noChecks = runs.length === 0 && !Array.isArray(status.statuses) || runs.length === 0 && (status.statuses as unknown[]).length === 0;
    const waiting = noChecks || runs.some((run) => run.status !== "completed") || ["pending", "expected"].includes(String(status.state));
    const humanStatus = failed ? "pre_ready_ci_blocked" : waiting ? "pre_ready_ci_waiting" : pr.draft === true ? "manual_ready_pending" : checkpoint !== "tracking_requested" || !hasTracking ? "tracking_pending" : "review_ready";
    return { ...this.#base(packet), status: humanStatus, pr: this.#publicPull(pr), ci: { status: failed ? "failed" : noChecks ? "unknown" : waiting ? "pending" : "success", check_runs: runs.map((run) => ({ id: run.id, name: run.name, status: run.status, conclusion: run.conclusion, head_sha: run.head_sha })), combined_state: status.state }, next_action: pr.draft === true ? "Human marks the pull request ready in GitHub." : hasTracking ? "Human reviews and merges in GitHub." : "Human applies the configured tracking label in GitHub." };
  }
}
