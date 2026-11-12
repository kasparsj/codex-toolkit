import type { JsonObject } from "./types.ts";
import { DeliveryError } from "./core.ts";

export type EffectDisposition = "none" | "accepted" | "unknown";
export type TerminalDisposition = "nonterminal" | "completed" | "failed" | "cancelled" | "timeout";
export type AdapterOutcomeStatus = "running" | "completed" | "failed" | "cancelled" | "timeout" | "permission" | "uncertain";
export type AdapterRole = "agent" | "reviewer";

export interface AdapterOutcomeProof {
  kind: "preflight_refusal" | "run_receipt" | "process_exit" | "archive_ack" | "no_ordinary_run";
  reference: string;
}

export interface AdapterOutcome {
  status: AdapterOutcomeStatus;
  effect: EffectDisposition;
  terminal: TerminalDisposition;
  execution_id?: string;
  provider?: string;
  proof?: AdapterOutcomeProof;
  result?: Record<string, unknown>;
  error?: string;
}

export interface AdapterOutcomeExpectedContext {
  repo: string;
  delivery_id: string;
  role: AdapterRole;
  task_id: string;
  packet_digest: string;
  execution_id?: string;
}

export interface AdapterOutcomeProofResolution {
  trusted: boolean;
  proof_digest?: string;
  error?: string;
}

export class AdapterRefusal extends DeliveryError {
  readonly outcome: AdapterOutcome;
  constructor(message: string, code: string, outcome: AdapterOutcome) {
    super(message, code);
    this.name = "AdapterRefusal";
    this.outcome = outcome;
  }
}

export type PublicationEffectPhase = "pre_effect" | "effect_possible";

export interface PublisherPhaseAttestation {
  phase: PublicationEffectPhase;
  operation_id: string;
  request_digest: string;
  publisher_identity_digest?: string;
  intent_digest?: string;
  pushed_ref_receipts: string[];
  proof?: string;
}

export type PublisherExecutionResult = Record<string, unknown> & { attestation?: PublisherPhaseAttestation };

export interface PublisherPhaseExpectedContext {
  repo: string;
  delivery_id: string;
  action: string;
  operation_id: string;
  request_digest: string;
  request: JsonObject;
}

export interface PublisherPhaseAttestationResolution {
  trusted: boolean;
  proof_digest?: string;
  error?: string;
}

export interface PublisherReadOnlyAttestation {
  phase: "read_only";
  action: "finalize";
  operation_id: string;
  request_digest: string;
  publisher_identity_digest: string;
  checkpoint: "ci_observed" | "ready_requested" | "tracking_requested";
  candidate_sha: string;
  retry_after_seconds: number;
  proof: string;
}

export interface PublisherReadOnlyAttestationResolution {
  trusted: boolean;
  proof_digest?: string;
  error?: string;
}

export interface PublisherPublicationInspection {
  status: "absent" | "completed" | "failed" | "uncertain";
  operation_id: string;
  request_digest: string;
  receipt?: JsonObject;
  error?: string;
  error_code?: string;
}

export class PublisherRefusal extends DeliveryError {
  readonly attestation: PublisherPhaseAttestation;
  constructor(message: string, code: string, attestation: PublisherPhaseAttestation) {
    super(message, code);
    this.name = "PublisherRefusal";
    this.attestation = attestation;
  }
}

export class PublisherReadOnlyRefusal extends DeliveryError {
  readonly attestation: PublisherReadOnlyAttestation;
  constructor(message: string, attestation: PublisherReadOnlyAttestation) {
    super(message, "GITHUB_UNAVAILABLE"); this.name = "PublisherReadOnlyRefusal"; this.attestation = attestation;
  }
}

export interface CancellationContext {
  repo: string;
  delivery_id: string;
  expected_revision: number;
  request_id: string;
  input_digest: string;
  repository_generation?: number;
  grant?: string;
}

export interface CancellationBeginResult {
  epoch: string;
  request_digest: string;
  outstanding_operation_ids: string[];
}

export interface CancellationOwnedAdapters {
  executor?: ExecutorPort;
  reviewer?: ExecutorPort;
}

export interface CancellationReconciliationResult {
  epoch: string;
  request_digest: string;
  status: "reconciling" | "draining" | "complete" | "uncertain";
  outstanding_operation_ids: string[];
  terminal_operation_ids: string[];
}

export interface RepositoryCancellationFence {
  repo: string;
  delivery_id: string;
  request_id: string;
  input_digest: string;
  epoch: string;
  reservation_token: string;
  generation: number;
  claim_generation: number;
  owner_token_digest: string;
  stopped_drained_ack_digest: string;
}

export interface CancellationFinalizeResult {
  epoch: string;
  request_digest: string;
  released: boolean;
}

export interface PublisherPort {
  execute(packet: Record<string, unknown>): Promise<PublisherExecutionResult>;
  inspectPublication?(request: JsonObject): Promise<PublisherPublicationInspection>;
  recoverLock?(): Promise<void>;
  resolvePhaseAttestation?(attestation: PublisherPhaseAttestation, expectedContext: PublisherPhaseExpectedContext): Promise<PublisherPhaseAttestationResolution>;
  resolveReadOnlyAttestation?(attestation: PublisherReadOnlyAttestation, expectedContext: PublisherPhaseExpectedContext): Promise<PublisherReadOnlyAttestationResolution>;
}

export interface ExecutorPort {
  dispatch(packet: Record<string, unknown>): Promise<Record<string, unknown>>;
  inspect(executionId: string): Promise<Record<string, unknown>>;
  collect(executionId: string): Promise<Record<string, unknown>>;
  cancel(executionId: string): Promise<Record<string, unknown>>;
  resolveOutcomeProof?(outcome: AdapterOutcome, expectedContext: AdapterOutcomeExpectedContext): Promise<AdapterOutcomeProofResolution>;
}

export interface TrustedCheckerPort {
  verify(packet: JsonObject): Promise<JsonObject>;
}
