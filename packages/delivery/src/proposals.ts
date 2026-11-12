import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { digest, newToken, requireCondition, utcNow } from "./core.ts";
import type { JsonObject } from "./types.ts";
import { FileStateStore } from "./store.ts";
import { PublisherRefusal, type PublisherPhaseAttestationResolution, type PublisherPort } from "./ports.ts";
import { Publisher, publicationAuthorizationDigest } from "./publisher.ts";

export interface IssueProposal { schema_version: 1; id: string; repo: string; repository_id: number; actor_id: number; title: string; body: string; content_digest: string; status: "queued" | "authorized" | "publishing" | "published" | "uncertain" | "failed" | "removed"; created_at: string; authorization?: { digest: string; at: string }; operation?: JsonObject; remote?: JsonObject; removed_at?: string }
export interface ProposalPublicationReconciliation { status: "absent" | "completed" | "failed" | "uncertain"; operation_id: string; request_digest: string; proposal: IssueProposal; error?: string }

export class ProposalSpool {
  readonly store: FileStateStore;
  constructor(store: FileStateStore) { this.store = store; }
  private path(repo: string, id: string): string { requireCondition(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(id), "invalid proposal ID"); return join(this.store.repoDir(repo), "proposals", id, "proposal.json"); }
  enqueue(input: { repo: string; repositoryId: number; actorId: number; title: string; body: string; id?: string }): IssueProposal {
    requireCondition(Number.isInteger(input.repositoryId) && input.repositoryId > 0 && Number.isInteger(input.actorId) && input.actorId > 0, "proposal identity required");
    requireCondition(input.title.trim().length > 0 && input.title.length <= 256 && input.body.length <= 64 * 1024, "invalid proposal content");
    requireCondition(!/(^|\n)\s*(repo|actor|command|executable|token|state_dir)\s*:/i.test(input.body), "proposal contains reserved control fields");
    const content = { title: input.title.trim(), body: input.body, repo: input.repo, repository_id: input.repositoryId, actor_id: input.actorId };
    const proposal: IssueProposal = { schema_version: 1, id: input.id ?? digest({ ...content, nonce: newToken(8) }).slice(0, 24), repo: input.repo, repository_id: input.repositoryId, actor_id: input.actorId, title: content.title, body: content.body, content_digest: digest(content), status: "queued", created_at: utcNow() };
    const target = this.path(input.repo, proposal.id);
    requireCondition(!existsSync(target), "proposal ID already exists");
    this.store.writeProtected(target, proposal);
    return proposal;
  }
  read(repo: string, id: string): IssueProposal { return this.store.readProtected(this.path(repo, id)) as unknown as IssueProposal; }
  private publicationRequest(proposal: IssueProposal): JsonObject {
    const operationId = digest({ repo: proposal.repo, id: proposal.id, content_digest: proposal.content_digest }).slice(0, 24);
    return { schema_version: 1, action: "publish_issue", repo: proposal.repo, target_repo: proposal.repo, delivery_id: proposal.id, operation_id: operationId, expected_revision: 1, payload: { title: proposal.title, body: proposal.body } };
  }
  authorize(repo: string, id: string, expectedDigest: string): IssueProposal {
    return this.store.withRepoLock(repo, () => { const value = this.read(repo, id); requireCondition(value.content_digest === expectedDigest, "proposal digest mismatch"); requireCondition(value.status === "queued" || value.status === "authorized", "proposal is not publishable"); value.status = "authorized"; value.authorization = { digest: expectedDigest, at: utcNow() }; this.store.writeProtected(this.path(repo, id), value); return value; });
  }
  list(repo: string): IssueProposal[] {
    const root = join(this.store.repoDir(repo), "proposals"); if (!existsSync(root)) return [];
    return readdirSync(root).map((id) => this.read(repo, basename(id))).sort((a, b) => a.created_at.localeCompare(b.created_at));
  }
  retry(repo: string, id: string, expectedDigest: string): IssueProposal {
    return this.store.withRepoLock(repo, () => {
      const value = this.read(repo, id);
      requireCondition(value.status === "uncertain" || value.status === "failed", "only a failed or uncertain proposal can be retried");
      requireCondition(value.content_digest === expectedDigest, "proposal retry requires its exact authorized digest");
      value.status = "authorized";
      value.authorization = { digest: expectedDigest, at: utcNow() };
      value.operation = { ...(value.operation ?? {}), retry_requested_at: utcNow() };
      this.store.writeProtected(this.path(repo, id), value);
      return value;
    });
  }
  remove(repo: string, id: string, expectedDigest: string): IssueProposal {
    return this.store.withRepoLock(repo, () => {
      const value = this.read(repo, id);
      requireCondition(["queued", "authorized", "uncertain", "failed"].includes(value.status), "published or active proposal cannot be removed");
      requireCondition(value.content_digest === expectedDigest, "proposal removal requires its exact content digest");
      value.status = "removed"; value.removed_at = utcNow();
      this.store.writeProtected(this.path(repo, id), value);
      return value;
    });
  }
  async publish(repo: string, id: string, publisher: PublisherPort, mode: "explicit" | "automatic"): Promise<IssueProposal> {
    let proposal = this.read(repo, id);
    requireCondition(proposal.status === "authorized" || proposal.status === "uncertain" || mode === "automatic" && proposal.status === "queued", "proposal lacks exact publication authorization");
    const request = this.publicationRequest(proposal), operationId = String(request.operation_id);
    const authorizedDigest = publicationAuthorizationDigest(request);
    this.store.withRepoLock(repo, () => { proposal = this.read(repo, id); requireCondition(proposal.status === "queued" || proposal.status === "authorized" || proposal.status === "publishing" || proposal.status === "uncertain", "proposal is not publishable"); proposal.status = "publishing"; proposal.operation = { id: operationId, request_digest: authorizedDigest, recorded_at: utcNow() }; this.store.writeProtected(this.path(repo, id), proposal); });
    try {
      const response = await publisher.execute({ ...request, authorized_digest: authorizedDigest });
      requireCondition(response.schema_version === 1 && response.action === "publish_issue" && response.delivery_id === id && response.operation_id === operationId && response.status === "published", "issue publication response identity mismatch");
      this.store.withRepoLock(repo, () => { proposal = this.read(repo, id); proposal.status = "published"; proposal.remote = response.issue as JsonObject; proposal.operation = { ...proposal.operation, completed_at: utcNow() }; this.store.writeProtected(this.path(repo, id), proposal); }); return proposal;
    } catch (error) {
      let phaseProof: PublisherPhaseAttestationResolution | undefined;
      if (error instanceof PublisherRefusal && error.attestation.phase === "pre_effect" && publisher instanceof Publisher) {
        try { phaseProof = await publisher.resolvePhaseAttestation(error.attestation, { repo, delivery_id: id, action: "publish_issue", operation_id: operationId, request_digest: authorizedDigest, request: request as JsonObject }); }
        catch (proofError) { phaseProof = { trusted: false, error: proofError instanceof Error ? proofError.message : String(proofError) }; }
      }
      const terminal = phaseProof?.trusted === true && typeof phaseProof.proof_digest === "string" && /^[0-9a-f]{64}$/.test(phaseProof.proof_digest);
      this.store.withRepoLock(repo, () => { proposal = this.read(repo, id); proposal.status = terminal ? "failed" : "uncertain"; proposal.operation = { ...proposal.operation, error: String(error).slice(0, 500), ...(error instanceof PublisherRefusal ? { attestation: structuredClone(error.attestation) as unknown as JsonObject } : {}), ...(phaseProof?.proof_digest ? { attestation_proof_digest: phaseProof.proof_digest } : {}), ...(phaseProof?.error ? { attestation_error: phaseProof.error.slice(0, 500) } : {}), ...(terminal ? { completed_at: utcNow() } : {}) }; this.store.writeProtected(this.path(repo, id), proposal); }); throw error;
    }
  }

  async reconcilePublication(repo: string, id: string, publisher: PublisherPort, options: { mode: "readback" }): Promise<ProposalPublicationReconciliation> {
    requireCondition(options.mode === "readback", "proposal reconciliation must be readback-only", "INVALID_ARGUMENT");
    let proposal = this.read(repo, id); requireCondition(proposal.repo === repo && proposal.status !== "removed", "proposal is unavailable for publication reconciliation", "REQUEST_CONFLICT");
    const request = this.publicationRequest(proposal), operationId = String(request.operation_id), requestDigest = publicationAuthorizationDigest(request);
    const result = (status: ProposalPublicationReconciliation["status"], error?: string): ProposalPublicationReconciliation => ({ status, operation_id: operationId, request_digest: requestDigest, proposal, ...(error ? { error } : {}) });
    if (proposal.status === "published") return result("completed");
    if (proposal.status === "failed") return result("failed", typeof proposal.operation?.error === "string" ? proposal.operation.error : undefined);
    if (!proposal.operation) return result("absent");
    requireCondition(proposal.operation.id === operationId && proposal.operation.request_digest === requestDigest, "proposal operation differs from exact protected publication", "REQUEST_CONFLICT");
    const persistUncertain = (readbackStatus: "absent" | "uncertain", error?: string) => this.store.withRepoLock(repo, () => { proposal = this.read(repo, id); requireCondition(proposal.operation?.id === operationId && proposal.operation.request_digest === requestDigest, "proposal operation changed during readback", "REQUEST_CONFLICT"); proposal.status = "uncertain"; proposal.operation = { ...proposal.operation, readback_status: readbackStatus, readback_at: utcNow(), ...(error ? { readback_error: error.slice(0, 500) } : {}) }; this.store.writeProtected(this.path(repo, id), proposal); });
    if (!(publisher instanceof Publisher) || !publisher.inspectPublication) { const error = "publisher does not expose trusted concrete readback-only publication inspection"; persistUncertain("uncertain", error); return result("uncertain", error); }
    let inspection;
    try { inspection = await publisher.inspectPublication(request); }
    catch (error) { const message = (error instanceof Error ? error.message : String(error)).replace(/[\r\n\t]+/g, " ").slice(0, 500); persistUncertain("uncertain", message); return result("uncertain", message); }
    requireCondition(inspection.operation_id === operationId && inspection.request_digest === requestDigest, "publisher inspected a different proposal operation", "REQUEST_CONFLICT");
    if (inspection.status === "absent" || inspection.status === "uncertain") {
      persistUncertain(inspection.status, inspection.error);
      return result(inspection.status, inspection.error);
    }
    this.store.withRepoLock(repo, () => {
      proposal = this.read(repo, id); requireCondition(proposal.operation?.id === operationId && proposal.operation.request_digest === requestDigest, "proposal operation changed during terminal readback", "REQUEST_CONFLICT");
      proposal.status = inspection.status === "completed" ? "published" : "failed"; proposal.operation = { ...proposal.operation, readback_status: inspection.status, completed_at: utcNow(), ...(inspection.error ? { error: inspection.error.slice(0, 500) } : {}) };
      if (inspection.status === "completed") { requireCondition(inspection.receipt, "completed proposal readback is missing its exact receipt", "OPERATION_UNRESOLVED"); proposal.remote = structuredClone(inspection.receipt); }
      this.store.writeProtected(this.path(repo, id), proposal);
    });
    return result(inspection.status, inspection.error);
  }
}
