import { basename, resolve } from "node:path";
import { canonicalJson, DeliveryError, digest, newToken, repoIdentity, requireCondition, utcNow, validateDeliveryId } from "./core.ts";
import { gitPoint, manifestMaterial, validateManifest } from "./manifest.ts";
import { policyRequirements } from "./policy.ts";
import { evaluateReviews, reviewContext } from "./reviews.ts";
import { safeProjection } from "./projection.ts";
import { AdapterRefusal, PublisherReadOnlyRefusal, PublisherRefusal, type AdapterOutcome, type AdapterOutcomeExpectedContext, type CancellationBeginResult, type CancellationContext, type CancellationFinalizeResult, type CancellationOwnedAdapters, type CancellationReconciliationResult, type ExecutorPort, type PublisherPhaseAttestationResolution, type PublisherPhaseExpectedContext, type PublisherPort, type PublisherReadOnlyAttestationResolution, type RepositoryCancellationFence, type TrustedCheckerPort } from "./ports.ts";
import type { DeliveryPolicy, DeliveryState, ExecutionState, JsonObject, ManifestEnvelope, PublicationMode, ReviewStage, SafeProjection, Stage } from "./types.ts";
import { FileStateStore } from "./store.ts";
import { Publisher, publicationAuthorizationDigest } from "./publisher.ts";
import { hashPackage, runtimeArtifactHashes, skillHashes } from "./pins.ts";
import { GitHubUnavailable } from "./github.ts";

export type ControlAction = "pause" | "resume" | "cancel" | "recover" | "publish_plan" | "publish_implementation" | "retry_review" | "correct" | "recheck_ready" | "export_handoff" | "bind_manual_pr";
export interface ControlInput { repo: string; deliveryId: string; expectedRevision: number; action: ControlAction; requestId: string; grant?: string; draftDigest?: string; stage?: ReviewStage; number?: number }
export interface ControlReconciliationInput extends ControlInput { repositoryInputDigest: string; mode?: "recover" | "readback" }
export interface ControlReconciliationResult { status: "absent" | "completed" | "failed" | "uncertain"; request_digest: string; repository_input_digest: string; revision: number; operation_id?: string; error?: string; error_code?: string }
interface EnginePreEffectTransientReadCommon {
  kind: "engine_pre_effect_transient_read";
  repo: string;
  delivery_id: string;
  expected_revision: number;
  retry_after_ms: number;
  error_code: "GITHUB_UNAVAILABLE";
  message: string;
}
export type EnginePreEffectTransientReadOutcome = EnginePreEffectTransientReadCommon & ({
  transition: "dispatch";
  stage: "rank" | "plan";
} | {
  transition: "recheck_ready";
  stage: "readiness";
  workflow_status: "publication_pending" | "pre_ready_ci_waiting" | "manual_ready_pending" | "tracking_pending";
  operation_id: string;
  request_digest: string;
  checkpoint: "ci_observed" | "ready_requested" | "tracking_requested";
  candidate_sha: string;
});
const enginePreEffectTransientReads = new WeakMap<object, EnginePreEffectTransientReadOutcome>();
class EnginePreEffectTransientRead extends DeliveryError {
  constructor(outcome: EnginePreEffectTransientReadOutcome) {
    super(outcome.message, outcome.error_code); this.name = "EnginePreEffectTransientRead";
    enginePreEffectTransientReads.set(this, Object.freeze({ ...outcome }));
  }
}
export function enginePreEffectTransientReadOutcome(error: unknown): EnginePreEffectTransientReadOutcome | undefined {
  return error !== null && (typeof error === "object" || typeof error === "function") ? enginePreEffectTransientReads.get(error as object) : undefined;
}
export function repositoryCommandInputDigest(input: Pick<ControlInput, "repo" | "deliveryId" | "expectedRevision" | "requestId" | "action" | "draftDigest" | "stage" | "number">): string {
  if (input.action === "export_handoff" || input.action === "bind_manual_pr") {
    const manual = input as Pick<ControlInput, "repo" | "deliveryId" | "expectedRevision" | "requestId" | "action" | "stage" | "number">;
    return digest({ repo: manual.repo, delivery_id: manual.deliveryId, expected_revision: manual.expectedRevision, request_id: manual.requestId,
      action: manual.action, stage: manual.stage ?? null, number: manual.number ?? null });
  }
  return digest({ repo: input.repo, delivery_id: input.deliveryId, expected_revision: input.expectedRevision, request_id: input.requestId, action: input.action, digest: input.draftDigest ?? null });
}
export interface EngineOptions {
  store: FileStateStore;
  publisher?: PublisherPort;
  executor?: ExecutorPort;
  checker?: TrustedCheckerPort;
  reviewer?: ExecutorPort;
  controlGrant?: { token: string; repositories: string[]; actions: ControlAction[] };
  now?: () => Date;
  runtimeLocations?: Record<string, string>;
}

function knownLocalPublicationFailure(error: unknown): boolean {
  return error instanceof DeliveryError && ["AUTHORIZATION_REQUIRED", "STALE_REVISION", "VERIFICATION_REQUIRED", "INVALID_ARGUMENT", "DELIVERY_BLOCKED"].includes(error.code);
}
function boundedError(error: unknown): { error: string; error_code: string } {
  return { error: (error instanceof Error ? error.message : String(error)).replace(/[\r\n\t]+/g, " ").slice(0, 500),
    error_code: error instanceof DeliveryError ? error.code : "DELIVERY_BLOCKED" };
}
export interface StartInput {
  repo: string; issue?: number | null; deliveryId?: string; policy: DeliveryPolicy;
  skillHashes?: Record<string, string>; engineHashes?: Record<string, string>;
  pinLocations?: Record<string, string>;
  safeguards?: { publication?: Partial<{ pr: PublicationMode; issue: PublicationMode }>; allowedPaths?: Partial<Record<ReviewStage, string[]>> };
  excludedIssues?: number[];
  budget?: Partial<{ maxAttempts: number; maxElapsedSeconds: number; maxConcurrency: number }>;
}

function event(name: string, revision: number, detail: JsonObject = {}): JsonObject { return { event: name, revision, at: utcNow(), ...detail }; }
function elapsed(state: DeliveryState, now: Date): number { return Math.floor((now.getTime() - Date.parse(state.created_at)) / 1000); }
function controlRequestDigest(input: ControlInput): string {
  if (input.action === "export_handoff" || input.action === "bind_manual_pr") return digest({ repo: input.repo, delivery_id: input.deliveryId,
    expected_revision: input.expectedRevision, action: input.action, stage: input.stage ?? null, number: input.number ?? null });
  return digest({ repo: input.repo, delivery_id: input.deliveryId, expected_revision: input.expectedRevision, action: input.action, draft_digest: input.draftDigest ?? null });
}

function conservativeOutcome(value: unknown, error = "adapter outcome lacks trusted lifecycle attestation"): AdapterOutcome {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    status: "uncertain", effect: "unknown", terminal: "nonterminal",
    ...(typeof source.execution_id === "string" ? { execution_id: source.execution_id } : typeof source.external_id === "string" ? { execution_id: source.external_id } : {}),
    ...(typeof source.provider === "string" ? { provider: source.provider } : {}), error,
  };
}

function adapterOutcome(value: unknown): AdapterOutcome | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  if (!["running", "completed", "failed", "cancelled", "timeout", "permission", "uncertain"].includes(String(item.status))
    || !["none", "accepted", "unknown"].includes(String(item.effect))
    || !["nonterminal", "completed", "failed", "cancelled", "timeout"].includes(String(item.terminal))) return undefined;
  const outcome = item as unknown as AdapterOutcome;
  const terminalForStatus: Partial<Record<AdapterOutcome["status"], AdapterOutcome["terminal"]>> = { completed: "completed", failed: "failed", cancelled: "cancelled", timeout: "timeout" };
  if (outcome.status === "timeout" ? outcome.terminal !== "timeout" && outcome.terminal !== "nonterminal" : terminalForStatus[outcome.status] && terminalForStatus[outcome.status] !== outcome.terminal) return undefined;
  if ((outcome.status === "running" || outcome.status === "permission" || outcome.status === "uncertain") && outcome.terminal !== "nonterminal") return undefined;
  if (outcome.status === "completed" && outcome.effect !== "accepted") return undefined;
  if (outcome.effect === "none" && outcome.terminal === "completed") return undefined;
  if (outcome.effect === "accepted" && !outcome.execution_id) return undefined;
  if (outcome.proof && (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(outcome.proof.reference)
    || !["preflight_refusal", "run_receipt", "process_exit", "archive_ack", "no_ordinary_run"].includes(outcome.proof.kind))) return undefined;
  return outcome;
}

function protectedAcceptedObservation(resolved: { outcome: AdapterOutcome; proofDigest?: string }): boolean {
  return typeof resolved.proofDigest === "string" && /^[0-9a-f]{64}$/.test(resolved.proofDigest)
    && resolved.outcome.effect === "accepted" && resolved.outcome.terminal === "nonterminal"
    && ["running", "permission", "timeout"].includes(resolved.outcome.status);
}

function protectedPreflightRefusal(resolved: { outcome: AdapterOutcome; proofDigest?: string }): boolean {
  return typeof resolved.proofDigest === "string" && /^[0-9a-f]{64}$/.test(resolved.proofDigest)
    && resolved.outcome.status === "failed" && resolved.outcome.effect === "none" && resolved.outcome.terminal === "failed"
    && resolved.outcome.proof?.kind === "preflight_refusal";
}

interface ReviewBinding {
  deliveryId: string;
  candidate: string;
  manifestDigest: string;
  manifestGeneration: number;
  criteriaDigest: string;
  producerExecutionId: string;
  producerIdentity: string;
  initialTaskId: string;
}

function latestReviewChain(state: DeliveryState, binding: ReviewBinding): ExecutionState | undefined {
  let latest: ExecutionState | undefined;
  const legacyInitialTaskId = digest({ delivery: binding.deliveryId, kind: "engineering_review", candidate: binding.candidate,
    manifest: binding.manifestDigest, criteria_digest: binding.criteriaDigest }).slice(0, 24);
  for (const item of state.executions) {
    if (item.kind !== "reviewer" || item.stage !== "engineering_review" || !item.packet || item.packet_digest !== digest(item.packet)) continue;
    const packet = item.packet, criteria = packet.criteria as JsonObject | undefined, ordinal = item.review_attempt ?? 0;
    if (packet.kind !== "review" || packet.delivery_id !== binding.deliveryId || packet.candidate_sha !== binding.candidate
      || packet.producer_execution_id !== binding.producerExecutionId || packet.producer_identity !== binding.producerIdentity
      || criteria?.manifest_digest !== binding.manifestDigest || criteria.criteria_digest !== binding.criteriaDigest
      || packet.manifest_generation !== undefined && packet.manifest_generation !== binding.manifestGeneration || packet.task_id !== item.id
      || packet.review_attempt !== undefined && packet.review_attempt !== ordinal) continue;
    if (!latest) {
      if (ordinal !== 0 || ![binding.initialTaskId, legacyInitialTaskId].includes(item.id) || item.predecessor_task_id !== undefined) continue;
      latest = item; continue;
    }
    const request = item.retry_request_id ? state.controls.requests[item.retry_request_id] : undefined;
    if (ordinal === (latest.review_attempt ?? 0) + 1 && item.predecessor_task_id === latest.id
      && packet.predecessor_task_id === latest.id && item.retry_request_id === packet.retry_request_id
      && request?.action === "retry_review" && request.status === "completed" && request.review_task_id === item.id
      && request.predecessor_task_id === latest.id && request.review_attempt === ordinal && request.check_digest === packet.check_digest) latest = item;
  }
  return latest;
}

export class DeliveryEngine {
  readonly store: FileStateStore;
  private readonly publisher?: PublisherPort;
  private readonly executor?: ExecutorPort;
  private readonly checker?: TrustedCheckerPort;
  private readonly reviewer?: ExecutorPort;
  private readonly grant?: EngineOptions["controlGrant"];
  private readonly now: () => Date;
  private readonly runtimeLocations?: Record<string, string>;
  constructor(options: EngineOptions) { this.store = options.store; this.publisher = options.publisher; this.executor = options.executor; this.checker = options.checker; this.reviewer = options.reviewer; this.grant = options.controlGrant; this.now = options.now ?? (() => new Date()); this.runtimeLocations = options.runtimeLocations; }
  publisherPort(): PublisherPort | undefined { return this.publisher; }

  start(input: StartInput): DeliveryState {
    repoIdentity(input.repo);
    requireCondition(input.issue === undefined || input.issue === null || Number.isInteger(input.issue) && input.issue > 0, "invalid issue number");
    const deliveryId = input.deliveryId ?? digest({ repo: input.repo, issue: input.issue ?? null, policy: input.policy._source.digest, nonce: newToken(8) }).slice(0, 24);
    validateDeliveryId(deliveryId);
    const at = this.now().toISOString();
    const budget = { max_attempts: input.budget?.maxAttempts ?? 8, max_elapsed_seconds: input.budget?.maxElapsedSeconds ?? 86_400, max_concurrency: input.budget?.maxConcurrency ?? 1 };
    requireCondition(Number.isInteger(budget.max_attempts) && budget.max_attempts > 0 && Number.isInteger(budget.max_elapsed_seconds) && budget.max_elapsed_seconds > 0 && budget.max_concurrency === 1, "invalid execution budget");
    const state: DeliveryState = {
      schema_version: 2, repo: input.repo, repo_identity: repoIdentity(input.repo), delivery_id: deliveryId,
      issue: input.issue ?? null, status: input.issue ? "plan_required" : "rank_required", revision: 1,
      claim_generation: 1, claim_token: newToken(32), claim_status: "active", attempt: 1,
      created_at: at, updated_at: at, policy: input.policy._source, policy_values: input.policy,
      requirements: policyRequirements(input.policy), pins: { skills: input.skillHashes ?? {}, engine: input.engineHashes ?? {}, locations: input.pinLocations ?? {}, artifacts: runtimeArtifactHashes(input.pinLocations ?? {}) },
      safeguards: {
        publication: { pr: input.safeguards?.publication?.pr ?? "off", issue: input.safeguards?.publication?.issue ?? "off" },
        allowed_paths: Object.fromEntries(Object.entries(input.safeguards?.allowedPaths ?? {}).map(([stage, paths]) => [stage, [...new Set(paths)].sort()])),
      },
      runner: { status: "idle", owner_pid: null }, manifests: {}, receipts: {}, operations: [], executions: [], unresolved_effects: [],
      controls: { paused: false, cancelled: false, requests: {} },
      budget: { ...budget, attempts_used: 0, token_cost: null, token_cost_status: "unknown" },
      history: [event("claimed", 1)], publication: {}, handoffs: {}, scheduler: { excluded_issue_ids: [...new Set(input.excludedIssues ?? [])] },
    };
    this.store.claim(input.repo, state);
    return state;
  }
  status(repo: string, deliveryId: string): SafeProjection { return safeProjection(this.store.read(repo, deliveryId), this.now()); }
  list(repo?: string): SafeProjection[] { return this.store.list(repo).map((state) => safeProjection(state, this.now())); }

  private ensureActive(state: DeliveryState): void {
    requireCondition(state.claim_status === "active" && !state.controls.cancelled, "delivery is not active");
    requireCondition(!state.controls.cancellation, "delivery cancellation is pending", "CANCEL_UNCONFIRMED");
    requireCondition(!state.controls.paused, "delivery is paused");
    requireCondition(elapsed(state, this.now()) <= state.budget.max_elapsed_seconds, "elapsed-time budget exhausted", "BUDGET_EXHAUSTED");
    requireCondition(state.budget.attempts_used < state.budget.max_attempts, "attempt budget exhausted", "BUDGET_EXHAUSTED");
    if (Object.keys(state.pins.locations).length) requireCondition(this.runtimeLocations && canonicalJson(this.runtimeLocations) === canonicalJson(state.pins.locations), "run is pinned to a different runtime or absolute source path", "PIN_MISMATCH");
    if (Object.keys(state.pins.skills).length) requireCondition(this.runtimeLocations?.skills_root && canonicalJson(skillHashes(this.runtimeLocations.skills_root)) === canonicalJson(state.pins.skills), "pinned skill source changed", "PIN_MISMATCH");
    if (Object.keys(state.pins.engine).length) requireCondition(this.runtimeLocations?.engine_src && state.pins.engine.delivery_src === hashPackage(this.runtimeLocations.engine_src), "pinned delivery engine source changed", "PIN_MISMATCH");
    if (Object.keys(state.pins.artifacts).length) requireCondition(this.runtimeLocations && canonicalJson(runtimeArtifactHashes(this.runtimeLocations)) === canonicalJson(state.pins.artifacts), "pinned runtime configuration or executable changed", "PIN_MISMATCH");
    const fetched = Date.parse(state.policy.fetched_at), maxAge = state.policy_values.delivery.policy_max_age_seconds ?? 86_400; requireCondition(fetched <= this.now().getTime() && this.now().getTime() - fetched <= maxAge * 1000, "frozen policy provenance is stale or future-dated", "POLICY_STALE");
  }
  private mutate(repo: string, deliveryId: string, expectedRevision: number | undefined, update: (state: DeliveryState) => void): DeliveryState {
    return this.store.mutate(repo, deliveryId, expectedRevision, (state) => { update(state); return state; });
  }

  private ensureGateReconciliationActive(state: DeliveryState): void {
    requireCondition(state.claim_status === "active" && !state.controls.cancelled && !state.controls.cancellation, "gate reconciliation is blocked by cancellation", "CANCEL_UNCONFIRMED");
  }

  private async resolvePublisherPhaseRefusal(error: unknown, expected: PublisherPhaseExpectedContext): Promise<PublisherPhaseAttestationResolution> {
    if (!(error instanceof PublisherRefusal) || error.attestation.phase !== "pre_effect" || !(this.publisher instanceof Publisher)) return { trusted: false, error: "publisher refusal lacks a concrete phase-proof resolver" };
    try {
      const resolution = await this.publisher.resolvePhaseAttestation(error.attestation, expected);
      return resolution.trusted && typeof resolution.proof_digest === "string" && /^[0-9a-f]{64}$/.test(resolution.proof_digest) ? resolution : { trusted: false, error: resolution.error ?? "publisher phase proof was not trusted" };
    } catch (proofError) { return { trusted: false, error: proofError instanceof Error ? proofError.message : String(proofError) }; }
  }

  private async resolvePublisherReadOnlyRefusal(error: unknown, expected: PublisherPhaseExpectedContext): Promise<PublisherReadOnlyAttestationResolution> {
    if (!(error instanceof PublisherReadOnlyRefusal) || !(this.publisher instanceof Publisher)) return { trusted: false, error: "publisher read failure lacks a concrete read-only proof resolver" };
    try {
      const resolution = await this.publisher.resolveReadOnlyAttestation(error.attestation, expected);
      return resolution.trusted && typeof resolution.proof_digest === "string" && /^[0-9a-f]{64}$/.test(resolution.proof_digest)
        ? resolution : { trusted: false, error: resolution.error ?? "publisher read-only proof was not trusted" };
    } catch (proofError) { return { trusted: false, error: proofError instanceof Error ? proofError.message : String(proofError) }; }
  }

  private async resolveAdapterOutcome(port: ExecutorPort, raw: unknown, context: AdapterOutcomeExpectedContext): Promise<{ outcome: AdapterOutcome; proofDigest?: string }> {
    const outcome = adapterOutcome(raw);
    if (!outcome) return { outcome: conservativeOutcome(raw) };
    const proofRequired = outcome.effect !== "unknown" || outcome.terminal !== "nonterminal";
    if (!proofRequired) return { outcome };
    if (!outcome.proof || !port.resolveOutcomeProof) return { outcome: conservativeOutcome(outcome, "adapter lifecycle proof is unavailable") };
    try {
      const resolution = await port.resolveOutcomeProof(outcome, context);
      return resolution.trusted && typeof resolution.proof_digest === "string" && /^[0-9a-f]{64}$/.test(resolution.proof_digest)
        ? { outcome, proofDigest: resolution.proof_digest }
        : { outcome: conservativeOutcome(outcome, resolution.error ?? "adapter lifecycle proof was not trusted") };
    } catch (error) { return { outcome: conservativeOutcome(outcome, String(error).slice(0, 500)) }; }
  }

  private recordOutcome(execution: ExecutionState, outcome: AdapterOutcome, proofDigest?: string): void {
    execution.effect = outcome.effect;
    execution.terminal = outcome.terminal;
    if (outcome.proof) execution.proof = structuredClone(outcome.proof); else delete execution.proof;
    if (proofDigest) execution.proof_digest = proofDigest; else delete execution.proof_digest;
    if (outcome.error) execution.outcome_error = outcome.error; else delete execution.outcome_error;
    if (outcome.provider) execution.provider = outcome.provider;
    if (outcome.execution_id) execution.external_id = outcome.execution_id;
  }


  acceptManifest(repo: string, deliveryId: string, value: unknown, expectedRevision?: number): DeliveryState {
    const manifest = validateManifest(value);
    const next = this.mutate(repo, deliveryId, expectedRevision, (state) => {
      this.ensureActive(state);
      requireCondition(manifest.repo === state.repo && manifest.delivery_id === state.delivery_id, "manifest delivery or repository mismatch");
      const order: Record<Stage, string[]> = { rank: ["rank_required"], plan: ["plan_required"], implement: ["implementation_required"], closeout: ["publication_pending", "ci_waiting", "pre_ready_ci_waiting", "manual_ready_pending", "post_ready_ci_waiting", "tracking_pending"] };
      const correction = (manifest.kind === "plan" && state.status === "plan_required" && Boolean(state.manifests.plan)) || (manifest.kind === "implement" && state.status === "implementation_required" && Boolean(state.manifests.implement));
      requireCondition(order[manifest.kind].includes(state.status), `${manifest.kind} manifest is out of order`);
      const material = manifestMaterial(manifest);
      const prior = state.manifests[manifest.kind];
      let generation = prior?.generation ?? 1;
      if (prior && prior.material_digest !== material.materialDigest) generation += 1;
      if (correction) requireCondition(prior?.material_digest !== material.materialDigest, "correction requires a material change");
      if (manifest.kind === "plan" || manifest.kind === "implement") {
        requireCondition(manifest.result.issue === state.issue, "manifest cannot change the issue");
        if (correction && prior) {
          const priorResult = prior.value.result;
          requireCondition(canonicalJson(manifest.result.base ?? manifest.result.baseline) === canonicalJson(priorResult.base ?? priorResult.baseline), "correction cannot change the publication base");
          const key = manifest.kind === "plan" ? "plan_revision" : "candidate_sha";
          requireCondition(manifest.result[key] !== priorResult[key], "correction requires a new candidate commit");
          delete state.receipts[manifest.kind === "plan" ? "plan" : "implementation"];
          delete state.receipts.engineering;
          delete state.receipts.checks;
          delete state.publication[manifest.kind === "plan" ? "plan" : "implementation"];
          delete state.publication[`${manifest.kind === "plan" ? "plan" : "implementation"}_manual_handoff`];
          delete state.handoffs[manifest.kind === "plan" ? "plan" : "implementation"];
          state.attempt += 1;
        }
      }
      state.manifests[manifest.kind] = { digest: material.digest, material_digest: material.materialDigest, generation, value: manifest, accepted_at: this.now().toISOString() };
      if (manifest.kind === "rank") {
        if (manifest.result.no_candidate === true) { requireCondition(this.eligibleIssueNumbers(state).length === 0, "rank no_candidate conflicts with protected eligible issues"); state.status = "completed"; state.claim_status = "released"; }
        else { const winner = manifest.result.winner as number; const shortlist = manifest.result.shortlist as number[] | undefined; requireCondition(Array.isArray(shortlist) && shortlist[0] === winner && new Set(shortlist).size === shortlist.length, "rank winner must lead a unique shortlist"); requireCondition(!state.scheduler.excluded_issue_ids.includes(winner), "rank winner was already serviced"); this.validateSelectedIssue(state, winner); state.issue = winner; state.status = "plan_required"; }
      } else if (manifest.kind === "plan") state.status = "plan_review";
      else if (manifest.kind === "implement") state.status = "implementation_review";
      else {
        const published = state.publication.final ?? state.publication.implementation;
        requireCondition(published !== undefined, "closeout requires verified publication");
        const bound = (published.pr as JsonObject | undefined) ?? published;
        const result = manifest.result;
        requireCondition(result.head_sha === bound.head_sha && result.base_sha === bound.base_sha, "closeout revisions differ from verified publication");
        const deliveryStatus = result.delivery_status as string;
        state.status = deliveryStatus === "READY" ? "review_ready" : deliveryStatus === "WAITING" ? "ci_waiting" : "blocked";
        if (state.status === "review_ready") { state.claim_status = "released"; }
      }
      state.history.push(event(`${manifest.kind}_manifest`, state.revision + 1, { generation, digest: material.digest }));
    });
    if (next.claim_status === "released") this.store.release(next);
    return next;
  }

  async publishStage(repo: string, deliveryId: string, stage: ReviewStage, expectedRevision: number, authorizedHandoffDigest?: string): Promise<DeliveryState> {
    const current = this.store.read(repo, deliveryId);
    requireCondition(current.safeguards.publication.pr === "automatic", "automatic pull request publication is disabled by protected policy", "AUTHORIZATION_REQUIRED");
    return this.publishStageAuthorized(repo, deliveryId, stage, expectedRevision, authorizedHandoffDigest);
  }

  private async publishStageAuthorized(repo: string, deliveryId: string, stage: ReviewStage, expectedRevision: number, authorizedHandoffDigest?: string, controlRequestId?: string): Promise<DeliveryState> {
    requireCondition(this.publisher, "publisher is not configured");
    const kind: Stage = stage === "plan" ? "plan" : "implement";
    const state = this.store.read(repo, deliveryId); requireCondition(state.revision === expectedRevision, `stale state revision: current ${state.revision}`, "STALE_REVISION"); this.ensureActive(state);
    requireCondition(state.status === `${stage}_review`, `cannot publish ${stage} from ${state.status}`);
    const manifest = state.manifests[kind]; requireCondition(manifest, `${kind} manifest missing`);
    const action = stage === "plan" ? "publish_plan" : "publish_implementation";
    const handoff = state.handoffs[stage]; requireCondition(handoff, `${stage} publication handoff is not staged`);
    requireCondition(authorizedHandoffDigest === handoff.digest, `${stage} publication requires the exact staged draft digest`, "AUTHORIZATION_REQUIRED");
    this.validateCurrentPublicationCandidate(state, stage, handoff);
    return this.publisherOperation(state, action, stage, handoff.payload, (next, response) => {
      next.publication[stage] = response as JsonObject;
      next.status = state.requirements[stage] > 0 ? `${stage}_review` as DeliveryState["status"] : stage === "plan" ? "implementation_required" : "publication_pending";
    }, handoff.expected, controlRequestId);
  }

  stageHandoff(repo: string, deliveryId: string, stage: ReviewStage, handoff: { expected: JsonObject; payload: JsonObject }, expectedRevision: number): DeliveryState {
    return this.mutate(repo, deliveryId, expectedRevision, (state) => {
      requireCondition(state.status === `${stage}_review`, `cannot stage ${stage} handoff from ${state.status}`);
      const manifest = state.manifests[stage === "plan" ? "plan" : "implement"]; requireCondition(manifest, "stage manifest missing");
      const candidate = manifest.value.result[stage === "plan" ? "plan_revision" : "candidate_sha"];
      const point = gitPoint(manifest.value.result[stage === "plan" ? "baseline" : "base"], stage === "plan" ? "baseline" : "base");
      requireCondition(handoff.expected.head_sha === candidate && handoff.expected.base_sha === point.sha && handoff.expected.base === point.ref && repoIdentity(point.repo) === state.repo_identity, "handoff candidate or base mismatch");
      requireCondition(typeof handoff.expected.head === "string" && typeof handoff.expected.base === "string" && typeof handoff.payload.title === "string" && typeof handoff.payload.body === "string" && typeof handoff.payload.bundle === "string" && Array.isArray(handoff.payload.allowed_paths), "invalid publication handoff");
      const trustedPaths = state.safeguards.allowed_paths[stage] ?? [];
      const suppliedPaths = handoff.payload.allowed_paths as unknown[];
      requireCondition(trustedPaths.length > 0 && suppliedPaths.every((path): path is string => typeof path === "string") && canonicalJson([...new Set(suppliedPaths)].sort()) === canonicalJson(trustedPaths), "handoff path allowlist differs from protected policy", "AUTHORIZATION_REQUIRED");
      const handoffDigest = digest({ ...handoff, generation: manifest.generation });
      state.handoffs[stage] = { expected: structuredClone(handoff.expected), payload: structuredClone(handoff.payload), digest: handoffDigest, generation: manifest.generation, staged_at: this.now().toISOString() };
      state.history.push(event(`${stage}_handoff_staged`, state.revision + 1, { digest: handoffDigest }));
    });
  }

  async exportManualHandoff(repo: string, deliveryId: string, stage: ReviewStage, expectedRevision: number, controlRequestId?: string): Promise<DeliveryState> {
    requireCondition(this.publisher, "publisher is not configured"); const state = this.store.read(repo, deliveryId); requireCondition(state.revision === expectedRevision, `stale state revision: current ${state.revision}`, "STALE_REVISION"); const handoff = state.handoffs[stage]; requireCondition(handoff, "staged handoff missing");
    this.validateCurrentPublicationCandidate(state, stage, handoff);
    return this.publisherOperation(state, "export_handoff", stage, handoff.payload, (next, response) => {
      requireCondition(response.status === "manual_handoff", "manual handoff export status mismatch");
      next.publication[`${stage}_manual_handoff`] = response as JsonObject;
      next.history.push(event(`${stage}_manual_handoff_exported`, next.revision + 1, { digest: handoff.digest }));
    }, handoff.expected, controlRequestId);
  }

  async bindManualPullRequest(repo: string, deliveryId: string, stage: ReviewStage, number: number, expectedRevision: number, controlRequestId?: string): Promise<DeliveryState> {
    requireCondition(this.publisher, "publisher is not configured"); requireCondition(Number.isInteger(number) && number > 0, "pull request number must be positive"); const state = this.store.read(repo, deliveryId); requireCondition(state.revision === expectedRevision, `stale state revision: current ${state.revision}`, "STALE_REVISION"); const handoff = state.handoffs[stage]; requireCondition(handoff && state.publication[`${stage}_manual_handoff`], "verified manual handoff export missing");
    this.validateCurrentPublicationCandidate(state, stage, handoff);
    return this.publisherOperation(state, "bind_manual_pr", stage, { number, title: handoff.payload.title as string, body: handoff.payload.body as string }, (next, response) => {
      requireCondition(response.status === "bound", "manual pull request binding status mismatch");
      next.publication[stage] = response as JsonObject;
      next.status = next.requirements[stage] > 0 ? `${stage}_review` as DeliveryState["status"] : stage === "plan" ? "implementation_required" : "publication_pending";
      next.history.push(event(`${stage}_manual_pr_bound`, next.revision + 1, { number }));
    }, handoff.expected, controlRequestId);
  }

  private ensureEngineeringVerified(state: DeliveryState, candidate: string): void {
    const engineering = state.receipts.engineering;
    const checker = engineering?.checker as JsonObject | undefined;
    const review = engineering?.review as JsonObject | undefined;
    requireCondition(engineering?.candidate_sha === candidate && checker?.status === "success" && checker.candidate_sha === candidate
      && review?.status === "approved" && review.candidate_sha === candidate && typeof engineering.producer_execution_id === "string"
      && typeof engineering.producer_identity === "string" && engineering.producer_identity.length > 0
      && typeof review.reviewer_identity === "string" && review.reviewer_identity.length > 0 && review.reviewer_identity !== engineering.producer_identity,
    "current independent engineering verification is required before implementation publication", "VERIFICATION_REQUIRED");
  }

  private validateCurrentPublicationCandidate(state: DeliveryState, stage: ReviewStage, handoff: NonNullable<DeliveryState["handoffs"][ReviewStage]>): void {
    const manifest = state.manifests[stage === "plan" ? "plan" : "implement"];
    requireCondition(manifest && handoff.generation === manifest.generation, "publication handoff generation is stale", "VERIFICATION_REQUIRED");
    const candidate = manifest.value.result[stage === "plan" ? "plan_revision" : "candidate_sha"];
    const point = gitPoint(manifest.value.result[stage === "plan" ? "baseline" : "base"], stage === "plan" ? "baseline" : "base");
    requireCondition(handoff.digest === digest({ expected: handoff.expected, payload: handoff.payload, generation: handoff.generation })
      && handoff.expected.head_sha === candidate && handoff.expected.base_sha === point.sha && handoff.expected.base === point.ref
      && repoIdentity(point.repo) === state.repo_identity, "publication handoff does not match the current accepted manifest", "VERIFICATION_REQUIRED");
    if (stage === "implementation") this.ensureEngineeringVerified(state, candidate as string);
  }

  private readinessWorkflowStatus(state: DeliveryState, checkpoint: "ci_observed" | "ready_requested" | "tracking_requested"): "publication_pending" | "pre_ready_ci_waiting" | "manual_ready_pending" | "tracking_pending" {
    const allowed = ["publication_pending", "pre_ready_ci_waiting", "manual_ready_pending", "tracking_pending"] as const;
    if (allowed.includes(state.status as (typeof allowed)[number])) return state.status as (typeof allowed)[number];
    const prior = state.publication.final?.status;
    if (allowed.includes(prior as (typeof allowed)[number])) return prior as (typeof allowed)[number];
    return checkpoint === "ready_requested" ? "manual_ready_pending" : checkpoint === "tracking_requested" ? "tracking_pending" : "publication_pending";
  }

  private async publisherReadOperation(state: DeliveryState, payload: JsonObject, expected: JsonObject, apply: (state: DeliveryState, response: Record<string, unknown>) => void, controlRequestId?: string): Promise<DeliveryState> {
    requireCondition(this.publisher, "publisher is not configured");
    requireCondition(!state.operations.some((item) => ["intent", "accepted", "uncertain"].includes(item.status)), "another publication effect must be reconciled before a readiness read", "OPERATION_UNRESOLVED");
    const action = "finalize", operationId = digest({ action, repo: state.repo, delivery_id: state.delivery_id, expected, payload }).slice(0, 24);
    const request: JsonObject = { schema_version: 1, action, target_repo: state.repo, repo: state.repo, delivery_id: state.delivery_id, operation_id: operationId,
      expected_revision: state.revision, expected, payload };
    const requestDigest = publicationAuthorizationDigest(request), checkpoint = payload.checkpoint as "ci_observed" | "ready_requested" | "tracking_requested";
    const matching = state.operations.filter((item) => item.id === operationId && item.action === action && item.request_digest === requestDigest);
    if (matching.some((item) => item.status === "completed")) return state;
    requireCondition(matching.length === 0, `readiness operation ${operationId} already requires explicit reconciliation`, "OPERATION_UNRESOLVED");
    let response: Record<string, unknown>;
    try { response = await this.publisher.execute({ ...request, authorized_digest: requestDigest }); }
    catch (error) {
      const expectedContext = { repo: state.repo, delivery_id: state.delivery_id, action, operation_id: operationId, request_digest: requestDigest, request };
      const proof = await this.resolvePublisherReadOnlyRefusal(error, expectedContext);
      if (!proof.trusted || !(error instanceof PublisherReadOnlyRefusal)) throw error;
      const retryAfterMs = Math.ceil(error.attestation.retry_after_seconds * 1000);
      requireCondition(Number.isSafeInteger(retryAfterMs) && retryAfterMs >= 0, "publisher read retry deadline is invalid", "OPERATION_UNRESOLVED");
      throw new EnginePreEffectTransientRead({ kind: "engine_pre_effect_transient_read", transition: "recheck_ready", stage: "readiness",
        workflow_status: this.readinessWorkflowStatus(state, checkpoint), repo: state.repo, delivery_id: state.delivery_id, expected_revision: state.revision,
        retry_after_ms: retryAfterMs, error_code: "GITHUB_UNAVAILABLE", message: error.message.replace(/[\r\n\t]+/g, " ").slice(0, 500), operation_id: operationId,
        request_digest: requestDigest, checkpoint, candidate_sha: error.attestation.candidate_sha });
    }
    requireCondition(response.schema_version === 1 && response.action === action && response.delivery_id === state.delivery_id && response.operation_id === operationId, "publisher readiness response identity mismatch");
    return this.mutate(state.repo, state.delivery_id, state.revision, (next) => {
      requireCondition(!next.controls.cancellation && next.claim_status === "active", "readiness read is blocked by pending cancellation", "CANCEL_UNCONFIRMED");
      requireCondition(!next.operations.some((item) => item.id === operationId), "readiness operation changed before result persistence", "OPERATION_UNRESOLVED");
      if (controlRequestId) {
        const controlRequest = next.controls.requests[controlRequestId];
        requireCondition(controlRequest?.action === "recheck_ready" && controlRequest.status === "intent", "readiness control request changed before result persistence", "REQUEST_CONFLICT");
        controlRequest.operation_id = operationId; controlRequest.operation_request_digest = requestDigest;
      }
      apply(next, response);
      next.operations.push({ id: operationId, action, status: "completed", expected_revision: state.revision, request_digest: requestDigest, request: structuredClone(request),
        recorded_at: this.now().toISOString(), completed_at: this.now().toISOString(), receipt: structuredClone(response) as JsonObject });
      next.history.push(event("finalize_read_completed", next.revision + 1, { operation_id: operationId }));
    });
  }

  private async publisherOperation(state: DeliveryState, action: string, stage: string | undefined, payload: JsonObject, apply: (state: DeliveryState, response: Record<string, unknown>) => void, expected?: JsonObject, controlRequestId?: string): Promise<DeliveryState> {
    requireCondition(this.publisher, "publisher is not configured");
    requireCondition(!state.operations.some((item) => ["intent", "accepted", "uncertain"].includes(item.status)), "another publication effect must be reconciled before a new attempt", "OPERATION_UNRESOLVED");
    const operationBase = digest({ action, repo: state.repo, delivery_id: state.delivery_id, expected, payload }).slice(0, 24);
    const matching = state.operations.filter((item) => item.action === action && canonicalJson(item.request?.expected ?? null) === canonicalJson(expected ?? null) && canonicalJson(item.request?.payload ?? null) === canonicalJson(payload));
    if (matching.some((item) => item.status === "completed")) return state;
    const priorFailure = matching.find((item) => item.status === "failed"); if (priorFailure) throw new DeliveryError(priorFailure.error ?? "publication attempt was previously denied", priorFailure.error_code ?? "DELIVERY_BLOCKED");
    const operationId = operationBase;
    const request = { schema_version: 1, action, target_repo: state.repo, repo: state.repo, delivery_id: state.delivery_id, operation_id: operationId, expected_revision: state.revision + 1, ...(expected ? { expected } : {}), payload };
    const authorizedDigest = publicationAuthorizationDigest(request);
    requireCondition(!state.operations.some((item) => item.id === operationId), `publication operation ${operationId} already exists`, "OPERATION_UNRESOLVED");
    const intent = this.mutate(state.repo, state.delivery_id, state.revision, (next) => {
      requireCondition(!next.controls.cancellation && next.claim_status === "active", "publication is blocked by pending cancellation", "CANCEL_UNCONFIRMED");
      next.operations.push({ id: operationId, action, ...(stage ? { stage } : {}), status: "intent", expected_revision: state.revision, request_digest: authorizedDigest, request: structuredClone(request) as JsonObject, recorded_at: this.now().toISOString() });
      if (controlRequestId) {
        const controlRequest = next.controls.requests[controlRequestId];
        requireCondition(controlRequest && controlRequest.action === (action === "finalize" ? "recheck_ready" : action) && controlRequest.status === "intent", "publication control request changed before operation binding", "REQUEST_CONFLICT");
        controlRequest.operation_id = operationId; controlRequest.operation_request_digest = authorizedDigest;
      }
      next.history.push(event(`${action}_intent`, state.revision + 1, { operation_id: operationId }));
    });
    let response: Record<string, unknown> | undefined;
    try {
      response = await this.publisher.execute({ ...request, expected_revision: intent.revision, authorized_digest: authorizedDigest });
      requireCondition(response.schema_version === 1 && response.action === action && response.delivery_id === state.delivery_id && response.operation_id === operationId, "publisher response identity mismatch");
      const current = this.store.read(state.repo, state.delivery_id); if (current.claim_status === "released") return current;
      return this.mutate(state.repo, state.delivery_id, current.revision, (next) => {
        const op = next.operations.find((item) => item.id === operationId);
        requireCondition(op?.status === "intent" && op.request_digest === authorizedDigest, "publication intent changed before result reconciliation", "OPERATION_UNRESOLVED");
        if (next.controls.cancellation || next.controls.cancelled || next.status === "cancelled") {
          op.status = "completed"; op.receipt = response as JsonObject; op.completed_at = this.now().toISOString();
          next.unresolved_effects = next.unresolved_effects.filter((item) => item !== operationId);
          next.history.push(event(`${action}_completed_after_cancellation`, next.revision + 1, { operation_id: operationId }));
          return;
        }
        if (stage === "plan" || stage === "implementation") {
          const handoff = next.handoffs[stage]; requireCondition(handoff, "publication handoff disappeared before result reconciliation", "OPERATION_UNRESOLVED");
          this.validateCurrentPublicationCandidate(next, stage, handoff);
        }
        apply(next, response!);
        op.status = "completed"; op.receipt = response as JsonObject; op.completed_at = this.now().toISOString();
        next.history.push(event(`${action}_completed`, next.revision + 1, { operation_id: operationId }));
      });
    } catch (error) {
      if (this.store.read(state.repo, state.delivery_id).claim_status === "released") return this.store.read(state.repo, state.delivery_id);
      const phaseProof = !response ? await this.resolvePublisherPhaseRefusal(error, { repo: state.repo, delivery_id: state.delivery_id, action, operation_id: operationId, request_digest: authorizedDigest, request: request as JsonObject }) : { trusted: false };
      if (phaseProof.trusted) { this.markOperationFailed(state.repo, state.delivery_id, operationId, authorizedDigest, error, phaseProof.proof_digest); throw error; }
      return this.markOperationUncertain(state.repo, state.delivery_id, operationId, authorizedDigest, error, response);
    }
  }

  async reconcilePublicationEffects(repo: string, deliveryId: string, expectedRevision: number, mode: "recover" | "readback" = "recover"): Promise<DeliveryState> {
    requireCondition(this.publisher, "publisher is not configured"); let state = this.store.read(repo, deliveryId); requireCondition(state.revision === expectedRevision, `stale state revision: current ${state.revision}`, "STALE_REVISION");
    const operation = state.operations.find((item) => ["intent", "accepted", "uncertain"].includes(item.status)); if (!operation) return state;
    requireCondition(operation.request && publicationAuthorizationDigest(operation.request) === operation.request_digest, "publication recovery packet is missing or changed", "OPERATION_UNRESOLVED");
    requireCondition(["publish_plan", "publish_implementation", "finalize", "export_handoff", "bind_manual_pr"].includes(operation.action), `publication operation ${operation.action} requires explicit manual reconciliation`, "OPERATION_UNRESOLVED");
    requireCondition(state.claim_status === "active" && !state.controls.cancelled, "cancelled or released delivery publication cannot be recovered", "OPERATION_UNRESOLVED");
    if (Object.keys(state.pins.locations).length) requireCondition(this.runtimeLocations && canonicalJson(this.runtimeLocations) === canonicalJson(state.pins.locations), "run is pinned to a different runtime or absolute source path", "PIN_MISMATCH");
    if (Object.keys(state.pins.skills).length) requireCondition(this.runtimeLocations?.skills_root && canonicalJson(skillHashes(this.runtimeLocations.skills_root)) === canonicalJson(state.pins.skills), "pinned skill source changed", "PIN_MISMATCH");
    if (Object.keys(state.pins.engine).length) requireCondition(this.runtimeLocations?.engine_src && state.pins.engine.delivery_src === hashPackage(this.runtimeLocations.engine_src), "pinned delivery engine source changed", "PIN_MISMATCH");
    if (Object.keys(state.pins.artifacts).length) requireCondition(this.runtimeLocations && canonicalJson(runtimeArtifactHashes(this.runtimeLocations)) === canonicalJson(state.pins.artifacts), "pinned runtime configuration or executable changed", "PIN_MISMATCH");
    if (["publish_plan", "publish_implementation", "export_handoff", "bind_manual_pr"].includes(operation.action)) {
      const stage = operation.stage; requireCondition(stage === "plan" || stage === "implementation", "publication recovery stage is missing", "OPERATION_UNRESOLVED");
      const handoff = state.handoffs[stage]; requireCondition(handoff && canonicalJson(operation.request.expected) === canonicalJson(handoff.expected), "publication recovery packet no longer matches the current staged candidate", "OPERATION_UNRESOLVED");
      const requestPayload = operation.request.payload as JsonObject | undefined;
      const expectedPayload = operation.action === "bind_manual_pr" ? { number: requestPayload?.number, title: handoff.payload.title, body: handoff.payload.body } : handoff.payload;
      requireCondition(canonicalJson(operation.request.payload) === canonicalJson(expectedPayload), "publication recovery payload no longer matches the current staged candidate", "OPERATION_UNRESOLVED");
      if (operation.action === "bind_manual_pr") requireCondition(state.publication[`${stage}_manual_handoff`], "verified manual handoff export missing", "OPERATION_UNRESOLVED");
      this.validateCurrentPublicationCandidate(state, stage, handoff);
    } else {
      const handoff = state.handoffs.implementation, publication = state.publication.implementation?.pr as JsonObject | undefined;
      const expected = handoff && publication ? { ...handoff.expected, number: publication.number, title: handoff.payload.title, body: handoff.payload.body } : undefined;
      requireCondition(handoff && publication && state.receipts.engineering?.candidate_sha === publication.head_sha && canonicalJson(operation.request.expected) === canonicalJson(expected), "final publication recovery candidate is no longer exact", "OPERATION_UNRESOLVED");
      this.validateCurrentPublicationCandidate(state, "implementation", handoff);
    }
    await this.publisher.recoverLock?.();
    let response: Record<string, unknown> | undefined;
    if (this.publisher instanceof Publisher && this.publisher.inspectPublication) {
      let inspection;
      try { inspection = await this.publisher.inspectPublication(operation.request); }
      catch (error) {
        if (operation.action === "finalize") {
          const proof = await this.resolvePublisherReadOnlyRefusal(error, { repo: state.repo, delivery_id: state.delivery_id, action: operation.action,
            operation_id: operation.id, request_digest: operation.request_digest, request: operation.request });
          if (proof.trusted && proof.proof_digest && error instanceof PublisherReadOnlyRefusal)
            return this.retireReadOnlyFinalization(repo, deliveryId, operation.id, operation.request_digest, error, proof.proof_digest);
        }
        return this.markOperationUncertain(repo, deliveryId, operation.id, operation.request_digest, error);
      }
      requireCondition(inspection.operation_id === operation.id && inspection.request_digest === operation.request_digest, "publisher inspection identity differs from protected operation", "OPERATION_UNRESOLVED");
      if (inspection.status === "completed") { requireCondition(inspection.receipt, "completed publisher inspection omitted its receipt", "OPERATION_UNRESOLVED"); response = inspection.receipt; }
      else if (inspection.status === "failed") return this.markOperationFailed(repo, deliveryId, operation.id, operation.request_digest,
        new DeliveryError(inspection.error ?? "publisher inspection established terminal failure", inspection.error_code ?? "DELIVERY_BLOCKED"));
      else if (inspection.status === "uncertain") return this.markOperationUncertain(repo, deliveryId, operation.id, operation.request_digest,
        new DeliveryError(inspection.error ?? "publisher inspection remains uncertain", inspection.error_code ?? "OPERATION_UNRESOLVED"));
      else if (mode === "readback") return this.markOperationFailed(repo, deliveryId, operation.id, operation.request_digest,
        new DeliveryError("publisher inspection proved the operation had no effect", "NO_EFFECT"));
    } else if (mode === "readback") return this.markOperationUncertain(repo, deliveryId, operation.id, operation.request_digest,
      new DeliveryError("publisher does not expose trusted readback-only inspection", "OPERATION_UNRESOLVED"));
    if (!response) {
      try { response = await this.publisher.execute({ ...operation.request, authorized_digest: operation.request_digest }); }
      catch (error) {
        if ((operation.action === "export_handoff" || operation.action === "bind_manual_pr") && this.publisher instanceof Publisher) {
          let terminal;
          try { terminal = await this.publisher.inspectPublication(operation.request); }
          catch (inspectionError) { return this.markOperationUncertain(repo, deliveryId, operation.id, operation.request_digest, inspectionError); }
          requireCondition(terminal.operation_id === operation.id && terminal.request_digest === operation.request_digest, "publisher inspection identity differs after manual failure", "OPERATION_UNRESOLVED");
          if (terminal.status === "completed") { requireCondition(terminal.receipt, "completed publisher inspection omitted its receipt", "OPERATION_UNRESOLVED"); response = terminal.receipt; }
          else if (terminal.status === "absent" || terminal.status === "failed") return this.markOperationFailed(repo, deliveryId, operation.id, operation.request_digest,
            new DeliveryError(terminal.error ?? (terminal.status === "absent" ? "manual publication attempt had no durable effect" : "manual publication attempt failed"), terminal.error_code ?? (terminal.status === "absent" ? "NO_EFFECT" : "DELIVERY_BLOCKED")));
          else return this.markOperationUncertain(repo, deliveryId, operation.id, operation.request_digest,
            new DeliveryError(terminal.error ?? "manual publication disposition remains uncertain", terminal.error_code ?? "OPERATION_UNRESOLVED"));
        } else throw error;
      }
    }
    requireCondition(response.schema_version === 1 && response.action === operation.action && response.delivery_id === deliveryId && response.operation_id === operation.id, "publisher recovery response identity mismatch");
    state = this.mutate(repo, deliveryId, undefined, (next) => {
      const current = next.operations.find((item) => item.id === operation.id); requireCondition(current && ["intent", "accepted", "uncertain"].includes(current.status) && current.request_digest === operation.request_digest, "publication recovery intent changed", "OPERATION_UNRESOLVED");
      if (operation.action === "publish_plan" || operation.action === "publish_implementation" || operation.action === "bind_manual_pr") {
        const stage = operation.stage as ReviewStage, handoff = next.handoffs[stage]; requireCondition(handoff, "publication recovery handoff is missing", "OPERATION_UNRESOLVED"); this.validateCurrentPublicationCandidate(next, stage, handoff);
        if (operation.action === "bind_manual_pr") requireCondition(response.status === "bound", "manual pull request binding status mismatch");
        next.publication[stage] = response as JsonObject; next.status = next.requirements[stage] > 0 ? `${stage}_review` as DeliveryState["status"] : stage === "plan" ? "implementation_required" : "publication_pending";
      } else if (operation.action === "export_handoff") {
        const stage = operation.stage as ReviewStage, handoff = next.handoffs[stage]; requireCondition(handoff, "manual handoff recovery candidate is missing", "OPERATION_UNRESOLVED"); this.validateCurrentPublicationCandidate(next, stage, handoff);
        requireCondition(response.status === "manual_handoff", "manual handoff export status mismatch"); next.publication[`${stage}_manual_handoff`] = response as JsonObject;
        next.history.push(event(`${stage}_manual_handoff_exported`, next.revision + 1, { digest: handoff.digest }));
      } else {
        next.publication.final = response as JsonObject;
        const readbackId = (operation.request?.payload as JsonObject | undefined)?.readback_id, controlRequest = typeof readbackId === "string" ? next.controls.requests[readbackId] : undefined;
        if (controlRequest?.action === "recheck_ready") { controlRequest.status = "completed"; controlRequest.completed_at = this.now().toISOString(); controlRequest.result_revision = next.revision + 1; next.unresolved_effects = next.unresolved_effects.filter((item) => item !== readbackId); }
        if (response.status === "review_ready") { next.status = "review_ready"; next.claim_status = "released"; } else if (typeof response.status === "string") next.status = response.status as DeliveryState["status"];
      }
      current.status = "completed"; current.receipt = response as JsonObject; current.completed_at = this.now().toISOString(); next.unresolved_effects = next.unresolved_effects.filter((item) => item !== operation.id); next.history.push(event(`${operation.action}_reconciled`, next.revision + 1, { operation_id: operation.id }));
    });
    if (state.claim_status === "released") this.store.release(state); return state;
  }

  private retireReadOnlyFinalization(repo: string, deliveryId: string, operationId: string, requestDigest: string, refusal: PublisherReadOnlyRefusal, proofDigest: string): DeliveryState {
    const current = this.store.read(repo, deliveryId), operation = current.operations.find((item) => item.id === operationId);
    requireCondition(operation?.action === "finalize" && operation.request_digest === requestDigest && operation.request?.payload, "read-only finalization intent changed", "OPERATION_UNRESOLVED");
    const checkpoint = (operation.request.payload as JsonObject).checkpoint as "ci_observed" | "ready_requested" | "tracking_requested";
    const restoredStatus = this.readinessWorkflowStatus(current, checkpoint), readbackId = (operation.request.payload as JsonObject).readback_id;
    return this.mutate(repo, deliveryId, current.revision, (next) => {
      const found = next.operations.find((item) => item.id === operationId);
      requireCondition(found && ["intent", "accepted", "uncertain"].includes(found.status) && found.request_digest === requestDigest, "read-only finalization intent changed during retirement", "OPERATION_UNRESOLVED");
      found.status = "failed"; found.error = refusal.message.slice(0, 500); found.error_code = "GITHUB_UNAVAILABLE"; found.completed_at = this.now().toISOString();
      found.attestation = structuredClone(refusal.attestation) as unknown as JsonObject; found.attestation_proof_digest = proofDigest;
      next.unresolved_effects = next.unresolved_effects.filter((item) => item !== operationId && item !== readbackId);
      if (next.status === "blocked") next.status = restoredStatus;
      if (typeof readbackId === "string") {
        const controlRequest = next.controls.requests[readbackId];
        if (controlRequest?.action === "recheck_ready" && ["intent", "uncertain"].includes(String(controlRequest.status))) {
          controlRequest.status = "failed"; controlRequest.error = refusal.message.slice(0, 500); controlRequest.error_code = "GITHUB_UNAVAILABLE"; controlRequest.completed_at = this.now().toISOString();
        }
      }
      next.history.push(event("finalize_read_retired", next.revision + 1, { operation_id: operationId, checkpoint, restored_status: restoredStatus, proof_digest: proofDigest }));
    });
  }

  private markOperationUncertain(repo: string, deliveryId: string, operationId: string, requestDigest: string, error: unknown, response?: Record<string, unknown>): DeliveryState {
    const current = this.store.read(repo, deliveryId); if (current.claim_status === "released") return current;
    return this.mutate(repo, deliveryId, current.revision, (next) => {
      const op = next.operations.find((item) => item.id === operationId);
      if (op?.status === "completed") return;
      requireCondition(op?.request_digest === requestDigest, "cannot reconcile a different publication intent", "OPERATION_UNRESOLVED");
      op.status = "uncertain"; op.error = String(error).slice(0, 500); if (response) op.receipt = response as JsonObject; if (error instanceof PublisherRefusal) op.attestation = structuredClone(error.attestation) as unknown as JsonObject;
      if (!next.unresolved_effects.includes(operationId)) next.unresolved_effects.push(operationId);
      next.status = "blocked";
      next.history.push(event("publication_effect_uncertain", next.revision + 1, { operation_id: operationId }));
    });
  }

  private markOperationFailed(repo: string, deliveryId: string, operationId: string, requestDigest: string, error: unknown, attestationProofDigest?: string): DeliveryState {
    const current = this.store.read(repo, deliveryId); if (current.claim_status === "released") return current;
    return this.mutate(repo, deliveryId, current.revision, (next) => {
      const op = next.operations.find((item) => item.id === operationId);
      if (op?.status === "completed") return;
      requireCondition(op?.request_digest === requestDigest, "cannot fail a different publication intent", "OPERATION_UNRESOLVED");
      op.status = "failed"; op.error = String(error).slice(0, 500); op.error_code = error instanceof DeliveryError ? error.code : "DELIVERY_BLOCKED"; if (error instanceof PublisherRefusal) op.attestation = structuredClone(error.attestation) as unknown as JsonObject; if (attestationProofDigest) op.attestation_proof_digest = attestationProofDigest; op.completed_at = this.now().toISOString();
      next.unresolved_effects = next.unresolved_effects.filter((item) => item !== operationId);
      next.history.push(event("publication_effect_failed", next.revision + 1, { operation_id: operationId }));
    });
  }

  async refreshReviews(repo: string, deliveryId: string, stage: ReviewStage, expectedRevision: number): Promise<DeliveryState> {
    requireCondition(this.publisher, "publisher is not configured");
    const state = this.store.read(repo, deliveryId); requireCondition(state.revision === expectedRevision, `stale state revision: current ${state.revision}`, "STALE_REVISION");
    const kind = stage === "plan" ? "plan" : "implement"; const manifest = state.manifests[kind]; requireCondition(manifest, "stage manifest missing");
    const published = state.publication[stage]; requireCondition(published, "stage is not published");
    const publishedPr = published.pr as JsonObject | undefined;
    const result = manifest.value.result; const commit = (publishedPr?.head_sha ?? published.head_sha ?? result[stage === "plan" ? "plan_revision" : "candidate_sha"]) as string;
    const point = gitPoint(result[stage === "plan" ? "baseline" : "base"], stage === "plan" ? "baseline" : "base");
    const context = reviewContext({ stage, generation: manifest.generation, issue: state.issue!, material_hashes: { manifest: manifest.material_digest }, baseline_sha: point.sha, base_repo: point.repo, base_ref: point.ref, base_sha: point.sha, final_repo: state.repo, final_ref: state.policy_values.delivery.final_target, policy_digest: state.policy.digest });
    const number = publishedPr?.number ?? published.number; requireCondition(Number.isInteger(number), "published pull request number missing");
    const handoff = state.handoffs[stage]; requireCondition(handoff, "protected publication handoff missing");
    const expected = { ...handoff.expected, number, title: handoff.payload.title, body: handoff.payload.body };
    const response = await this.publisher.execute({ schema_version: 1, action: "list_reviews", target_repo: state.repo, repo: state.repo, delivery_id: state.delivery_id, operation_id: digest({ stage, context, commit }).slice(0, 24), expected_revision: state.revision, expected, payload: { stage, commit_id: commit, number } });
    requireCondition(Array.isArray(response.reviews), "publisher review evidence missing");
    const latest = this.store.read(repo, deliveryId); if (latest.claim_status === "released" || latest.controls.cancellation) return latest;
    const config = state.policy_values.approvals[stage];
    const verdict = evaluateReviews(response.reviews as Record<string, unknown>[], { stage, generation: manifest.generation, context_digest: context, commit_id: commit, authorized_ids: config.reviewer_ids, publisher_id: state.policy_values.delivery.publisher_id, minimum: state.requirements[stage], require_human: true, allow_publisher_review: true });
    return this.mutate(repo, deliveryId, latest.revision, (next) => {
      this.ensureGateReconciliationActive(next);
      requireCondition(next.manifests[kind]?.digest === manifest.digest, "review manifest changed during reconciliation", "OPERATION_UNRESOLVED");
      next.receipts[stage] = { ...verdict, context_digest: context, commit_id: commit, generation: manifest.generation, checked_at: this.now().toISOString() } as JsonObject;
      if (verdict.approved === true) next.status = stage === "plan" ? "implementation_required" : "publication_pending";
      next.history.push(event(`${stage}_review_checked`, next.revision + 1, { approved: verdict.approved as boolean }));
    });
  }

  async verifyCandidate(repo: string, deliveryId: string, expectedRevision: number): Promise<DeliveryState> {
    requireCondition(this.checker && this.reviewer, "trusted checker and independent reviewer are required");
    let state = this.store.read(repo, deliveryId); requireCondition(state.revision === expectedRevision, `stale state revision: current ${state.revision}`, "STALE_REVISION"); this.ensureActive(state);
    const manifest = state.manifests.implement; requireCondition(manifest, "implementation manifest missing"); const candidate = manifest.value.result.candidate_sha as string;
    if (state.receipts.engineering?.candidate_sha === candidate) return state;
    let check = state.receipts.checks;
    if (check?.candidate_sha !== candidate || check.manifest_digest !== manifest.digest || check.status !== "success") {
      const verified = await this.checker.verify({ repo, delivery_id: deliveryId, candidate_sha: candidate, manifest_digest: manifest.digest });
      const latest = this.store.read(repo, deliveryId); if (latest.claim_status === "released" || latest.controls.cancellation) return latest;
      if (verified.status !== "success" || verified.candidate_sha !== candidate) return this.mutate(repo, deliveryId, latest.revision, (next) => { this.ensureGateReconciliationActive(next); requireCondition(next.manifests.implement?.digest === manifest.digest, "implementation changed during checker reconciliation", "OPERATION_UNRESOLVED"); next.receipts.checks = { ...verified, candidate_sha: candidate, manifest_digest: manifest.digest, checked_at: this.now().toISOString() }; next.status = "implementation_required"; next.history.push(event("candidate_checks_rejected", next.revision + 1, { candidate_sha: candidate })); });
      state = this.mutate(repo, deliveryId, latest.revision, (next) => { this.ensureGateReconciliationActive(next); requireCondition(next.manifests.implement?.digest === manifest.digest, "implementation changed during checker reconciliation", "OPERATION_UNRESOLVED"); next.receipts.checks = { ...verified, candidate_sha: candidate, manifest_digest: manifest.digest, checked_at: this.now().toISOString() }; next.history.push(event("candidate_checks_verified", next.revision + 1, { candidate_sha: candidate })); });
      check = state.receipts.checks;
    }
    requireCondition(typeof manifest.producer_execution_id === "string" && typeof manifest.producer_identity === "string" && manifest.producer_identity.length > 0,
      "accepted implementation manifest is not bound to a trusted producer execution", "VERIFICATION_REQUIRED");
    const producerExecutionId = manifest.producer_execution_id;
    const producerIdentity = manifest.producer_identity;
    const criteriaDigest = digest({ delivery_id: deliveryId, issue: state.issue, candidate_sha: candidate, manifest_digest: manifest.digest, plan_digest: state.manifests.plan?.digest ?? null, producer_execution_id: producerExecutionId, producer_identity: producerIdentity });
    const initialTaskId = digest({ repo: state.repo_identity, delivery: deliveryId, kind: "engineering_review", candidate, manifest: manifest.digest, criteria_digest: criteriaDigest }).slice(0, 24);
    const binding: ReviewBinding = { deliveryId, candidate, manifestDigest: manifest.digest, manifestGeneration: manifest.generation, criteriaDigest, producerExecutionId, producerIdentity, initialTaskId };
    const persistedIntent = latestReviewChain(state, binding);
    const taskId = persistedIntent?.id ?? initialTaskId;
    const reviewPacket = persistedIntent?.packet ?? JSON.parse(JSON.stringify({ schema_version: 1, kind: "review", repo, delivery_id: deliveryId, manifest_generation: manifest.generation, candidate_sha: candidate, criteria: { issue: state.issue, plan_digest: state.manifests.plan?.digest, manifest_digest: manifest.digest, criteria_digest: criteriaDigest }, producer_execution_id: producerExecutionId, producer_identity: producerIdentity, review_attempt: 0, task_id: taskId })) as JsonObject;
    const reviewPacketDigest = persistedIntent?.packet_digest ?? digest(reviewPacket);
    let execution = persistedIntent;
    if (!execution) {
      state = this.mutate(repo, deliveryId, state.revision, (next) => { requireCondition(!next.controls.cancellation && next.claim_status === "active", "review is blocked by pending cancellation", "CANCEL_UNCONFIRMED"); next.executions.push({ id: taskId, kind: "reviewer", stage: "engineering_review", status: "dispatching", review_attempt: 0, packet_digest: reviewPacketDigest, packet: structuredClone(reviewPacket) as unknown as JsonObject, started_at: this.now().toISOString() }); next.history.push(event("engineering_review_intent", next.revision + 1, { task_id: taskId, candidate_sha: candidate, review_attempt: 0 })); });
      execution = state.executions.find((item) => item.id === taskId)!;
    }
    if (!execution.external_id) {
      let dispatchResolution: { outcome: AdapterOutcome; proofDigest?: string } | undefined;
      try {
        const dispatched = dispatchResolution = await this.resolveAdapterOutcome(this.reviewer, await this.reviewer.dispatch(execution.packet ?? reviewPacket), { repo: state.repo_identity, delivery_id: deliveryId, role: "reviewer", task_id: taskId, packet_digest: execution.packet_digest ?? reviewPacketDigest });
        const current = this.store.read(repo, deliveryId); if (current.claim_status === "released") return current;
        state = this.mutate(repo, deliveryId, current.revision, (next) => { const found = next.executions.find((item) => item.id === taskId); requireCondition(found?.status === "dispatching", "reviewer intent changed before dispatch reconciliation", "OPERATION_UNRESOLVED"); this.recordOutcome(found, dispatched.outcome, dispatched.proofDigest); if (dispatched.outcome.effect === "accepted" && dispatched.outcome.execution_id) { found.status = dispatched.outcome.terminal === "completed" ? "completed" : dispatched.outcome.terminal === "nonterminal" ? "running" : dispatched.outcome.terminal === "cancelled" ? "cancelled" : "failed"; if (dispatched.outcome.result) { found.result = structuredClone(dispatched.outcome.result) as JsonObject; found.result_digest = digest(dispatched.outcome.result); } } else if (protectedPreflightRefusal(dispatched)) { found.status = "failed"; found.finished_at = this.now().toISOString(); next.unresolved_effects = next.unresolved_effects.filter((item) => item !== taskId); if (!next.controls.cancellation && !next.controls.cancelled && next.claim_status === "active") next.status = "blocked"; } else { found.status = "uncertain"; if (!next.controls.cancellation) { if (!next.unresolved_effects.includes(taskId)) next.unresolved_effects.push(taskId); next.status = "blocked"; } } next.history.push(event(protectedPreflightRefusal(dispatched) ? "engineering_review_refused_before_effect" : "engineering_review_dispatch_reconciled", next.revision + 1, { task_id: taskId, effect: dispatched.outcome.effect, terminal: dispatched.outcome.terminal })); });
        execution = state.executions.find((item) => item.id === taskId)!;
        if (protectedPreflightRefusal(dispatched)) return state;
        if (execution.status === "uncertain") return state;
      } catch (error) {
        if (error instanceof AdapterRefusal) {
          const refused = await this.resolveAdapterOutcome(this.reviewer, error.outcome, { repo: state.repo_identity, delivery_id: deliveryId, role: "reviewer", task_id: taskId, packet_digest: execution.packet_digest ?? reviewPacketDigest });
          if (protectedPreflightRefusal(refused)) {
            const current = this.store.read(repo, deliveryId); if (current.claim_status === "released") return current;
            return this.mutate(repo, deliveryId, current.revision, (next) => { const found = next.executions.find((item) => item.id === taskId)!; this.recordOutcome(found, refused.outcome, refused.proofDigest); found.status = "failed"; found.finished_at = this.now().toISOString(); next.unresolved_effects = next.unresolved_effects.filter((item) => item !== taskId); if (!next.controls.cancellation && !next.controls.cancelled && next.claim_status === "active") next.status = "blocked"; next.history.push(event("engineering_review_refused_before_effect", next.revision + 1, { task_id: taskId, code: error.code })); });
          }
        }
        return this.markExecutionUncertain(repo, deliveryId, taskId, "engineering_review_dispatch_uncertain", error, dispatchResolution);
      }
    }
    if (execution.status === "failed" && execution.effect === "none" && execution.terminal === "failed" && execution.proof?.kind === "preflight_refusal" && execution.proof_digest) return state;
    let result = execution.result as Record<string, unknown> | undefined;
    if (!result) {
      const context: AdapterOutcomeExpectedContext = { repo: state.repo_identity, delivery_id: deliveryId, role: "reviewer", task_id: taskId, packet_digest: execution.packet_digest ?? reviewPacketDigest, execution_id: execution.external_id };
      const inspected = await this.resolveAdapterOutcome(this.reviewer, await this.reviewer.inspect(execution.external_id!), context);
      if (protectedAcceptedObservation(inspected)) return state;
      const collected = await this.resolveAdapterOutcome(this.reviewer, await this.reviewer.collect(execution.external_id!), context);
      const current = this.store.read(repo, deliveryId); if (current.claim_status === "released") return current;
      if (protectedAcceptedObservation(collected)) return current;
      state = this.mutate(repo, deliveryId, current.revision, (next) => { const found = next.executions.find((item) => item.id === taskId)!; this.recordOutcome(found, collected.outcome, collected.proofDigest); if (collected.outcome.effect === "accepted" && collected.outcome.terminal === "completed" && collected.outcome.result) { found.status = "completed"; found.finished_at = this.now().toISOString(); found.result_digest = digest(collected.outcome.result); found.result = structuredClone(collected.outcome.result) as JsonObject; if (!next.controls.cancellation) next.unresolved_effects = next.unresolved_effects.filter((item) => item !== taskId); } else if (collected.outcome.effect === "accepted" && ["failed", "cancelled", "timeout"].includes(collected.outcome.terminal)) { found.status = collected.outcome.terminal === "cancelled" ? "cancelled" : "failed"; found.finished_at = this.now().toISOString(); if (!next.controls.cancellation) { next.status = "implementation_required"; next.unresolved_effects = next.unresolved_effects.filter((item) => item !== taskId); } } else { found.status = "uncertain"; if (!next.controls.cancellation) { next.status = "blocked"; if (!next.unresolved_effects.includes(taskId)) next.unresolved_effects.push(taskId); } } next.history.push(event("engineering_review_outcome_persisted", next.revision + 1, { task_id: taskId, effect: collected.outcome.effect, terminal: collected.outcome.terminal })); });
      execution = state.executions.find((item) => item.id === taskId)!;
      if (execution.status !== "completed" || !execution.result || state.controls.cancellation || state.controls.cancelled || state.claim_status === "released") return state;
      result = execution.result as Record<string, unknown>;
    }
    const reviewerIdentity = `${execution.provider ?? "unknown"}:${execution.external_id}`;
    const approved = result.status === "approved" && result.delivery_id === deliveryId && result.task_id === taskId
      && result.criteria_digest === criteriaDigest && result.candidate_sha === candidate && reviewerIdentity !== producerIdentity;
    const latest = this.store.read(repo, deliveryId);
    if (latest.claim_status === "released" || latest.controls.cancelled || latest.controls.cancellation) return latest;
    if (!approved) return this.mutate(repo, deliveryId, latest.revision, (next) => { this.ensureGateReconciliationActive(next); requireCondition(next.manifests.implement?.digest === manifest.digest, "implementation changed during review reconciliation", "OPERATION_UNRESOLVED"); next.status = "implementation_required"; next.history.push(event("engineering_review_rejected", next.revision + 1, { candidate_sha: candidate, task_id: taskId })); });
    return this.mutate(repo, deliveryId, latest.revision, (next) => { this.ensureGateReconciliationActive(next); requireCondition(next.manifests.implement?.digest === manifest.digest, "implementation changed during review reconciliation", "OPERATION_UNRESOLVED"); next.receipts.engineering = { candidate_sha: candidate, producer_execution_id: producerExecutionId, producer_identity: producerIdentity, criteria_digest: criteriaDigest, checker: check!, review: { ...result!, reviewer_identity: reviewerIdentity }, checked_at: this.now().toISOString() } as unknown as JsonObject; next.history.push(event("engineering_verified", next.revision + 1, { candidate_sha: candidate, producer_execution_id: producerExecutionId })); });
  }

  async drainAcceptedExecution(repo: string, deliveryId: string, expectedRevision: number): Promise<DeliveryState> {
    let state = this.store.read(repo, deliveryId); requireCondition(state.revision === expectedRevision, `stale state revision: current ${state.revision}`, "STALE_REVISION");
    const primary = state.executions.find((item) => item.kind === "agent" && item.id === state.runner.execution_id && typeof item.external_id === "string" && ["running", "completed", "uncertain"].includes(item.status));
    if (primary) return this.executor ? this.collect(repo, deliveryId, expectedRevision) : state;
    if (!this.reviewer) return state;
    const manifest = state.manifests.implement, check = state.receipts.checks;
    if (!manifest || typeof manifest.producer_execution_id !== "string" || typeof manifest.producer_identity !== "string") return state;
    const candidate = manifest.value.result.candidate_sha as string, producerExecutionId = manifest.producer_execution_id, producerIdentity = manifest.producer_identity;
    if (check?.status !== "success" || check.candidate_sha !== candidate || check.manifest_digest !== manifest.digest) return state;
    const criteriaDigest = digest({ delivery_id: deliveryId, issue: state.issue, candidate_sha: candidate, manifest_digest: manifest.digest,
      plan_digest: state.manifests.plan?.digest ?? null, producer_execution_id: producerExecutionId, producer_identity: producerIdentity });
    const accepted = state.executions.filter((item) => {
      if (item.kind !== "reviewer" || item.stage !== "engineering_review" || typeof item.external_id !== "string" || !["running", "completed", "uncertain"].includes(item.status)
        || !item.packet || item.packet_digest !== digest(item.packet)) return false;
      const criteria = item.packet.criteria as JsonObject | undefined;
      return item.packet.kind === "review" && item.packet.repo === repo && item.packet.delivery_id === deliveryId && item.packet.candidate_sha === candidate
        && item.packet.producer_execution_id === producerExecutionId && item.packet.producer_identity === producerIdentity && item.packet.task_id === item.id
        && criteria?.manifest_digest === manifest.digest && criteria.criteria_digest === criteriaDigest
        && (item.packet.manifest_generation === undefined || item.packet.manifest_generation === manifest.generation);
    });
    if (accepted.length !== 1) return state;
    let execution = accepted[0]!, result = execution.result as Record<string, unknown> | undefined;
    if (!result) {
      const context: AdapterOutcomeExpectedContext = { repo: state.repo_identity, delivery_id: deliveryId, role: "reviewer", task_id: execution.id,
        packet_digest: execution.packet_digest!, execution_id: execution.external_id };
      try {
        const inspected = await this.resolveAdapterOutcome(this.reviewer, await this.reviewer.inspect(execution.external_id!), context);
        // Explicit drain must progress the original owned adapter even while inspection is still running.
        const collected = await this.resolveAdapterOutcome(this.reviewer, await this.reviewer.collect(execution.external_id!), context);
        const current = this.store.read(repo, deliveryId); if (current.claim_status === "released") return current;
        if (protectedAcceptedObservation(collected)) return current;
        state = this.mutate(repo, deliveryId, current.revision, (next) => {
          const found = next.executions.find((item) => item.id === execution.id); requireCondition(found, "accepted reviewer disappeared during drain", "OPERATION_UNRESOLVED");
          requireCondition(found.external_id === execution.external_id && found.packet_digest === execution.packet_digest, "accepted reviewer identity changed during drain", "OPERATION_UNRESOLVED");
          this.recordOutcome(found, collected.outcome, collected.proofDigest);
          if (collected.outcome.effect === "accepted" && collected.outcome.terminal === "completed" && collected.outcome.result) {
            found.status = "completed"; found.finished_at = this.now().toISOString(); found.result_digest = digest(collected.outcome.result); found.result = structuredClone(collected.outcome.result) as JsonObject; next.unresolved_effects = next.unresolved_effects.filter((item) => item !== found.id);
          } else if (collected.outcome.effect === "accepted" && ["failed", "cancelled", "timeout"].includes(collected.outcome.terminal)) {
            found.status = collected.outcome.terminal === "cancelled" ? "cancelled" : "failed"; found.finished_at = this.now().toISOString(); next.status = "implementation_required"; next.unresolved_effects = next.unresolved_effects.filter((item) => item !== found.id);
          } else { found.status = "uncertain"; next.status = "blocked"; if (!next.unresolved_effects.includes(found.id)) next.unresolved_effects.push(found.id); }
          next.history.push(event("engineering_review_drain_persisted", next.revision + 1, { task_id: found.id, effect: collected.outcome.effect, terminal: collected.outcome.terminal }));
        });
      } catch (error) { return this.markExecutionUncertain(repo, deliveryId, execution.id, "engineering_review_drain_uncertain", error); }
      execution = state.executions.find((item) => item.id === execution.id)!; result = execution.result as Record<string, unknown> | undefined;
    }
    if (execution.status !== "completed" || !result || state.controls.cancellation || state.controls.cancelled || state.claim_status === "released") return state;
    const reviewerIdentity = `${execution.provider ?? "unknown"}:${execution.external_id}`;
    const approved = result.status === "approved" && result.delivery_id === deliveryId && result.task_id === execution.id
      && result.criteria_digest === criteriaDigest && result.candidate_sha === candidate && reviewerIdentity !== producerIdentity;
    const latest = this.store.read(repo, deliveryId); if (latest.claim_status === "released" || latest.controls.cancelled || latest.controls.cancellation) return latest;
    if (!approved) return this.mutate(repo, deliveryId, latest.revision, (next) => { this.ensureGateReconciliationActive(next); next.status = "implementation_required"; next.history.push(event("engineering_review_rejected_during_drain", next.revision + 1, { candidate_sha: candidate, task_id: execution.id })); });
    return this.mutate(repo, deliveryId, latest.revision, (next) => {
      this.ensureGateReconciliationActive(next); requireCondition(next.manifests.implement?.digest === manifest.digest && next.receipts.checks?.manifest_digest === manifest.digest, "implementation changed during reviewer drain", "OPERATION_UNRESOLVED");
      next.receipts.engineering = { candidate_sha: candidate, producer_execution_id: producerExecutionId, producer_identity: producerIdentity, criteria_digest: criteriaDigest,
        checker: check, review: { ...result!, reviewer_identity: reviewerIdentity }, checked_at: this.now().toISOString() } as unknown as JsonObject;
      next.history.push(event("engineering_verified_during_drain", next.revision + 1, { candidate_sha: candidate, producer_execution_id: producerExecutionId }));
    });
  }

  advanceFromReceipt(repo: string, deliveryId: string, stage: ReviewStage, expectedRevision: number): DeliveryState {
    return this.mutate(repo, deliveryId, expectedRevision, (state) => {
      requireCondition(state.status === `${stage}_review`, `cannot advance ${stage} from ${state.status}`);
      const receipt = state.receipts[stage]; requireCondition(receipt?.approved === true, `current ${stage} approval is required`);
      const manifest = state.manifests[stage === "plan" ? "plan" : "implement"]; requireCondition(manifest, "stage manifest missing");
      requireCondition(receipt.generation === manifest.generation, "review receipt generation is stale");
      state.status = stage === "plan" ? "implementation_required" : "publication_pending";
      state.history.push(event(`${stage}_gate_completed`, state.revision + 1));
    });
  }

  async dispatch(repo: string, deliveryId: string, expectedRevision: number): Promise<DeliveryState> {
    requireCondition(this.executor, "executor is not configured");
    let state = this.store.read(repo, deliveryId); requireCondition(state.revision === expectedRevision, `stale state revision: current ${state.revision}`, "STALE_REVISION"); this.ensureActive(state);
    const resumingIntent = state.runner.status === "dispatching";
    requireCondition(state.runner.status === "idle" || resumingIntent, "existing execution must be reconciled before dispatch");
    const stage = resumingIntent ? state.runner.current_stage : state.status === "rank_required" ? "rank" : state.status === "plan_required" ? "plan" : state.status === "implementation_required" ? "implement" : null;
    requireCondition(stage, `no executable stage for ${state.status}`);
    if (!resumingIntent && (stage === "rank" || stage === "plan") && !state.rank_snapshot) {
      try { state = await this.refreshRankSnapshot(repo, deliveryId, state.revision); }
      catch (error) {
        const retryAfterSeconds = error instanceof GitHubUnavailable ? error.retryAfterSeconds : -1;
        if (this.publisher instanceof Publisher && Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0 && Number.isSafeInteger(Math.ceil(retryAfterSeconds * 1000))) {
          throw new EnginePreEffectTransientRead({ kind: "engine_pre_effect_transient_read", transition: "dispatch", stage, repo, delivery_id: deliveryId,
            expected_revision: state.revision, retry_after_ms: Math.ceil(retryAfterSeconds * 1000), error_code: "GITHUB_UNAVAILABLE",
            message: error instanceof Error ? error.message.replace(/[\r\n\t]+/g, " ").slice(0, 500) : "GitHub is temporarily unavailable" });
        }
        throw error;
      }
    }
    if (stage === "plan") this.validateSelectedIssue(state, state.issue!);
    const id = resumingIntent ? state.runner.execution_id! : digest({ repo: state.repo_identity, delivery: deliveryId, stage, attempt: state.budget.attempts_used + 1, revision: state.revision }).slice(0, 24);
    const priorExecution = state.executions.find((item) => item.id === id);
    const packet = resumingIntent && priorExecution?.packet ? priorExecution.packet : JSON.parse(JSON.stringify(this.executionPacket(state, stage, id))) as JsonObject, packetDigest = priorExecution?.packet_digest ?? digest(packet);
    if (!resumingIntent) state = this.mutate(repo, deliveryId, state.revision, (next) => { requireCondition(!next.controls.cancellation && next.claim_status === "active", "dispatch is blocked by pending cancellation", "CANCEL_UNCONFIRMED"); next.runner = { status: "dispatching", owner_pid: process.pid, owner_started_at: this.now().toISOString(), current_stage: stage, execution_id: id }; next.executions.push({ id, kind: "agent", stage, status: "dispatching", packet_digest: packetDigest, packet: structuredClone(packet) as JsonObject, started_at: this.now().toISOString() }); next.budget.attempts_used += 1; });
    let dispatchResolution: { outcome: AdapterOutcome; proofDigest?: string } | undefined;
    try {
      const raw = await this.executor.dispatch(packet);
      const resolved = dispatchResolution = await this.resolveAdapterOutcome(this.executor, raw, { repo: state.repo_identity, delivery_id: deliveryId, role: "agent", task_id: id, packet_digest: packetDigest });
      const current = this.store.read(repo, deliveryId); if (current.claim_status === "released") return current;
      return this.mutate(repo, deliveryId, current.revision, (next) => {
        const execution = next.executions.find((item) => item.id === id); requireCondition(execution?.status === "dispatching" && next.runner.execution_id === id, "execution intent changed before dispatch reconciliation", "OPERATION_UNRESOLVED");
        this.recordOutcome(execution, resolved.outcome, resolved.proofDigest);
        if (resolved.outcome.effect === "accepted" && resolved.outcome.execution_id) {
          execution.status = resolved.outcome.terminal === "completed" ? "completed" : resolved.outcome.terminal === "cancelled" ? "cancelled" : resolved.outcome.terminal === "failed" || resolved.outcome.terminal === "timeout" ? "failed" : "running";
          execution.implementer_identity = `${execution.provider ?? "unknown"}:${resolved.outcome.execution_id}`;
          if (!next.controls.cancellation) next.runner.status = execution.status === "running" || execution.status === "completed" ? "running" : "failed";
          if (resolved.outcome.result) { execution.result = structuredClone(resolved.outcome.result) as JsonObject; execution.result_digest = digest(resolved.outcome.result); }
          if (resolved.outcome.terminal !== "nonterminal") execution.finished_at = this.now().toISOString();
          if (resolved.outcome.terminal === "failed" || resolved.outcome.terminal === "cancelled" || resolved.outcome.terminal === "timeout") next.unresolved_effects = next.unresolved_effects.filter((item) => item !== id);
        } else if (resolved.outcome.effect === "none" && resolved.outcome.terminal !== "nonterminal") {
          execution.status = "failed"; execution.finished_at = this.now().toISOString(); next.runner.status = "failed"; next.unresolved_effects = next.unresolved_effects.filter((item) => item !== id);
        } else {
          execution.status = "uncertain"; next.runner.status = "failed"; next.status = "blocked"; if (!next.unresolved_effects.includes(id)) next.unresolved_effects.push(id);
        }
        next.history.push(event("execution_dispatch_reconciled", next.revision + 1, { task_id: id, effect: resolved.outcome.effect, terminal: resolved.outcome.terminal }));
      });
    } catch (error) {
      if (error instanceof AdapterRefusal) {
        const resolved = await this.resolveAdapterOutcome(this.executor, error.outcome, { repo: state.repo_identity, delivery_id: deliveryId, role: "agent", task_id: id, packet_digest: packetDigest });
        if (resolved.outcome.effect === "none" && resolved.outcome.terminal !== "nonterminal") return this.mutate(repo, deliveryId, undefined, (next) => { const execution = next.executions.find((item) => item.id === id)!; this.recordOutcome(execution, resolved.outcome, resolved.proofDigest); execution.status = "failed"; execution.finished_at = this.now().toISOString(); next.runner.status = "failed"; next.unresolved_effects = next.unresolved_effects.filter((item) => item !== id); next.history.push(event("dispatch_refused_before_effect", next.revision + 1, { task_id: id, code: error.code })); });
      }
      return this.markExecutionUncertain(repo, deliveryId, id, "dispatch_uncertain", error, dispatchResolution);
    }
  }

  private markExecutionUncertain(repo: string, deliveryId: string, taskId: string, eventName: string, error: unknown, resolved?: { outcome: AdapterOutcome; proofDigest?: string }): DeliveryState {
    const current = this.store.read(repo, deliveryId); if (current.claim_status === "released") return current;
    return this.mutate(repo, deliveryId, current.revision, (next) => {
      const execution = next.executions.find((item) => item.id === taskId);
      if (execution?.status === "completed" || execution?.status === "cancelled") return;
      requireCondition(execution, `execution ${taskId} is missing during reconciliation`, "OPERATION_UNRESOLVED");
      if (resolved) this.recordOutcome(execution, resolved.outcome, resolved.proofDigest);
      execution.status = "uncertain";
      if (!next.controls.cancellation) {
        next.runner.status = next.runner.execution_id === taskId ? "failed" : next.runner.status;
        next.status = "blocked";
        if (!next.unresolved_effects.includes(taskId)) next.unresolved_effects.push(taskId);
      }
      next.history.push(event(eventName, next.revision + 1, { task_id: taskId, error: String(error).slice(0, 500) }));
    });
  }

  private executionPacket(state: DeliveryState, stage: string, id: string): Record<string, unknown> {
    const selectedIssue = state.issue === null ? undefined : (state.rank_snapshot?.issues as JsonObject[] | undefined)?.find((item) => item.number === state.issue);
    const plan = state.manifests.plan;
    const implementationContext = stage === "implement" && plan ? {
      selected_issue: selectedIssue,
      approved_plan: plan.value,
      approved_plan_digest: plan.digest,
      approved_plan_generation: plan.generation,
      approved_plan_review: state.receipts.plan,
      approved_plan_publication: state.publication.plan,
      expected_base: plan.value.result.baseline,
      allowed_paths: state.safeguards.allowed_paths.implementation ?? [],
    } : undefined;
    const outputContract = stage === "implement" ? {
      skill: "implement-plan",
      manifest_kind: "implement",
      manifest_required: ["issue", "candidate_sha", "base", "artifact_paths", "verification"],
      base_must_equal: plan?.value.result.baseline,
      handoff_allowed_paths: state.safeguards.allowed_paths.implementation ?? [],
      instruction: "Execute the approved plan with the pinned implement-plan skill. Return the implementation manifest and staged handoff only; do not publish, merge, deploy, or change issues.",
    } : stage === "plan" ? {
      skill: "plan-pr",
      manifest_kind: "plan",
      manifest_required: ["issue", "plan_revision", "baseline", "artifact_paths", "artifact_hashes"],
      handoff_allowed_paths: state.safeguards.allowed_paths.plan ?? [],
      instruction: "Plan the selected protected issue with the pinned plan-pr skill. Return the plan manifest and staged handoff only; do not publish or modify GitHub.",
    } : undefined;
    return { schema_version: 1, kind: stage, repo: state.repo, delivery_id: state.delivery_id, issue: state.issue, excluded_issue_ids: state.scheduler.excluded_issue_ids, protected_snapshot: stage === "rank" || stage === "plan" ? state.rank_snapshot : undefined, selected_issue: selectedIssue, ...(implementationContext ? { implementation_context: implementationContext } : {}), ...(outputContract ? { output_contract: outputContract } : {}), policy_digest: state.policy.digest, pins: state.pins, task_id: id };
  }

  async refreshRankSnapshot(repo: string, deliveryId: string, expectedRevision: number): Promise<DeliveryState> {
    requireCondition(this.publisher, "protected GitHub reader is not configured"); const state = this.store.read(repo, deliveryId); requireCondition(state.revision === expectedRevision, `stale state revision: current ${state.revision}`, "STALE_REVISION");
    const operationId = digest({ action: "rank_snapshot", repo, deliveryId, expectedRevision }).slice(0, 24);
    const response = await this.publisher.execute({ schema_version: 1, action: "rank_snapshot", target_repo: repo, repo, delivery_id: deliveryId, operation_id: operationId, expected_revision: expectedRevision, payload: { issue_state: "open" } });
    requireCondition(response.schema_version === 1 && response.action === "rank_snapshot" && response.delivery_id === deliveryId && response.operation_id === operationId && response.status === "snapshot", "rank snapshot identity mismatch");
    const coverage = response.coverage as Record<string, unknown> | undefined;
    requireCondition(Array.isArray(response.issues) && Array.isArray(response.open_prs) && Array.isArray(response.dependencies) && coverage?.issues_complete === true && coverage.open_prs_complete === true && Number.isInteger(coverage.unresolved_count), "protected rank coverage is incomplete");
    return this.mutate(repo, deliveryId, expectedRevision, (next) => { next.rank_snapshot = { ...(response as JsonObject), checked_at: this.now().toISOString() }; next.history.push(event("rank_snapshot", next.revision + 1, { issue_count: (response.issues as unknown[]).length, open_pr_count: (response.open_prs as unknown[]).length })); });
  }

  private validateSelectedIssue(state: DeliveryState, issueNumber: number): void {
    const snapshot = state.rank_snapshot; requireCondition(snapshot, "protected rank snapshot is required"); const coverage = snapshot.coverage as JsonObject;
    requireCondition(coverage.issues_complete === true && coverage.open_prs_complete === true, "protected rank coverage is incomplete");
    const issue = (snapshot.issues as JsonObject[]).find((item) => item.number === issueNumber); requireCondition(issue && issue.state === "open" && issue.pull_request !== true, "selected issue is absent or ineligible in the protected snapshot");
    const labels = new Set((issue.labels as JsonObject[]).map((label) => label.name as string));
    requireCondition((state.policy_values.eligibility.required_labels ?? []).every((label) => labels.has(label)), "selected issue lacks a required label");
    requireCondition(!(state.policy_values.eligibility.excluded_labels ?? []).some((label) => labels.has(label)), "selected issue has an excluded label");
    const dependency = (snapshot.dependencies as JsonObject[]).find((item) => item.issue === issueNumber); requireCondition(dependency && Array.isArray(dependency.blocked_by) && dependency.blocked_by.length === 0 && Array.isArray(dependency.unresolved) && dependency.unresolved.length === 0, "selected issue dependencies are blocked or unresolved");
    const overlap = (snapshot.open_prs as JsonObject[]).some((pr) => new RegExp(`(?:#|issues/)${issueNumber}(?:\\b|$)`, "i").test(`${String(pr.title ?? "")}\n${String(pr.body ?? "")}`)); requireCondition(!overlap, "selected issue already overlaps an open pull request");
  }
  private eligibleIssueNumbers(state: DeliveryState): number[] {
    const snapshot = state.rank_snapshot; requireCondition(snapshot && Array.isArray(snapshot.issues), "protected rank snapshot is required");
    const result: number[] = [];
    for (const issue of snapshot.issues as JsonObject[]) {
      if (!Number.isInteger(issue.number) || state.scheduler.excluded_issue_ids.includes(issue.number as number)) continue;
      try { this.validateSelectedIssue(state, issue.number as number); result.push(issue.number as number); } catch (error) { if (!(error instanceof DeliveryError)) throw error; }
    }
    return result;
  }

  async collect(repo: string, deliveryId: string, expectedRevision: number): Promise<DeliveryState> {
    requireCondition(this.executor, "executor is not configured"); const state = this.store.read(repo, deliveryId); requireCondition(state.revision === expectedRevision, `stale state revision: current ${state.revision}`, "STALE_REVISION");
    const execution = state.executions.find((item) => item.id === state.runner.execution_id); requireCondition(execution?.external_id, "persisted execution identity missing");
    let durable = state;
    let result = execution.result as Record<string, unknown> | undefined;
    if (!result) {
      const context: AdapterOutcomeExpectedContext = { repo: state.repo_identity, delivery_id: deliveryId, role: "agent", task_id: execution.id, packet_digest: execution.packet_digest ?? digest(execution.packet ?? { task_id: execution.id }), execution_id: execution.external_id };
      const inspected = await this.resolveAdapterOutcome(this.executor, await this.executor.inspect(execution.external_id), context);
      if (protectedAcceptedObservation(inspected)) return state;
      const collected = await this.resolveAdapterOutcome(this.executor, await this.executor.collect(execution.external_id), context);
      const current = this.store.read(repo, deliveryId); if (current.claim_status === "released") return current;
      if (protectedAcceptedObservation(collected)) return current;
      durable = this.mutate(repo, deliveryId, current.revision, (next) => {
        const found = next.executions.find((item) => item.id === execution.id); requireCondition(found, "execution disappeared before result reconciliation", "OPERATION_UNRESOLVED");
        this.recordOutcome(found, collected.outcome, collected.proofDigest);
        if (collected.outcome.effect === "accepted" && collected.outcome.terminal === "completed" && collected.outcome.result) {
          found.status = "completed"; found.finished_at = this.now().toISOString(); found.result_digest = digest(collected.outcome.result); found.result = structuredClone(collected.outcome.result) as JsonObject; next.unresolved_effects = next.unresolved_effects.filter((item) => item !== execution.id);
        } else if (collected.outcome.effect === "accepted" && ["failed", "cancelled", "timeout"].includes(collected.outcome.terminal)) {
          found.status = collected.outcome.terminal === "cancelled" ? "cancelled" : "failed"; found.finished_at = this.now().toISOString(); next.runner.status = "failed"; next.unresolved_effects = next.unresolved_effects.filter((item) => item !== execution.id);
        } else {
          found.status = "uncertain"; next.runner.status = "failed"; next.status = "blocked"; if (!next.unresolved_effects.includes(execution.id)) next.unresolved_effects.push(execution.id);
        }
        next.history.push(event("execution_outcome_persisted", next.revision + 1, { task_id: execution.id, effect: collected.outcome.effect, terminal: collected.outcome.terminal }));
      });
      const persisted = durable.executions.find((item) => item.id === execution.id)!;
      if (persisted.status !== "completed" || !persisted.result) return durable;
      result = persisted.result as Record<string, unknown>;
    }
    if (durable.controls.cancellation || durable.controls.cancelled || durable.claim_status === "released") return durable;
    const manifest = result.manifest ?? (result.schema_version === 1 && result.kind ? result : undefined);
    requireCondition(manifest !== undefined, "executor completed without a manifest");
    const envelope = validateManifest(manifest);
    let accepted = durable;
    if (accepted.manifests[envelope.kind]?.digest !== digest(envelope)) accepted = this.acceptManifest(repo, deliveryId, envelope, accepted.revision);
    if (envelope.kind === "implement") {
      const producerIdentity = `${execution.provider ?? "unknown"}:${execution.external_id}`;
      accepted = this.mutate(repo, deliveryId, accepted.revision, (next) => {
        const acceptedManifest = next.manifests.implement;
        requireCondition(acceptedManifest?.digest === digest(envelope), "accepted implementation manifest changed before producer binding", "STALE_REVISION");
        acceptedManifest.producer_execution_id = execution.id;
        acceptedManifest.producer_identity = producerIdentity;
        const found = next.executions.find((item) => item.id === execution.id);
        if (found) found.implementer_identity = producerIdentity;
        next.history.push(event("implementation_producer_bound", next.revision + 1, { task_id: execution.id }));
      });
    }
    if (result.handoff && typeof result.handoff === "object" && (accepted.status === "plan_review" || accepted.status === "implementation_review")) {
      const reviewStage = accepted.status === "plan_review" ? "plan" : "implementation";
      if (accepted.handoffs[reviewStage]?.digest !== digest(result.handoff)) accepted = this.stageHandoff(repo, deliveryId, reviewStage, result.handoff as { expected: JsonObject; payload: JsonObject }, accepted.revision);
    }
    return this.mutate(repo, deliveryId, accepted.revision, (next) => { next.runner = { status: "idle", owner_pid: null }; next.history.push(event("execution_result_accepted", next.revision + 1, { task_id: execution.id })); });
  }

  async recheckReady(repo: string, deliveryId: string, expectedRevision: number, readbackId = `readback_${newToken(8)}`, controlRequestId?: string): Promise<DeliveryState> {
    requireCondition(this.publisher, "publisher is not configured"); const current = this.store.read(repo, deliveryId); requireCondition(current.revision === expectedRevision, `stale state revision: current ${current.revision}`, "STALE_REVISION");
    const publication = current.publication.implementation; const pr = publication?.pr as JsonObject | undefined; requireCondition(pr && Number.isInteger(pr.number) && typeof pr.head_sha === "string", "bound implementation pull request missing"); requireCondition(current.receipts.engineering?.candidate_sha === pr.head_sha, "fresh independent engineering verification is required");
    const checkpoint = current.status === "manual_ready_pending" ? "ready_requested" : current.status === "tracking_pending" ? "tracking_requested" : "ci_observed";
    const handoff = current.handoffs.implementation; requireCondition(handoff, "protected implementation handoff missing"); this.validateCurrentPublicationCandidate(current, "implementation", handoff);
    const expected: JsonObject = { ...handoff.expected, number: pr.number as number, title: handoff.payload.title as string, body: handoff.payload.body as string };
    const payload = { number: pr.number as number, head_sha: pr.head_sha as string, checkpoint, readback_id: readbackId, ...(current.policy_values.tracking?.review_label ? { tracking_label: current.policy_values.tracking.review_label } : {}) };
    const next = await this.publisherReadOperation(current, payload, expected, (state, response) => {
      state.publication.final = response as JsonObject;
      const controlRequest = controlRequestId ? state.controls.requests[controlRequestId] : undefined;
      if (controlRequest?.action === "recheck_ready") { controlRequest.status = "completed"; controlRequest.completed_at = this.now().toISOString(); controlRequest.result_revision = state.revision + 1; state.unresolved_effects = state.unresolved_effects.filter((item) => item !== controlRequestId); }
      if (response.status === "review_ready") { state.status = "review_ready"; state.claim_status = "released"; }
      else if (typeof response.status === "string") state.status = response.status as DeliveryState["status"];
    }, controlRequestId);
    if (next.claim_status === "released") this.store.release(next);
    return next;
  }

  beginCancellation(context: CancellationContext): CancellationBeginResult {
    requireCondition(this.grant && context.grant === this.grant.token && this.grant.repositories.includes(context.repo) && this.grant.actions.includes("cancel"), "operator cancellation is disabled or unauthorized", "UNAUTHORIZED");
    requireCondition(/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(context.request_id) && /^[0-9a-f]{64}$/.test(context.input_digest), "invalid cancellation request identity");
    const current = this.store.read(context.repo, context.delivery_id), prior = current.controls.cancellation;
    const repositoryGeneration = context.repository_generation ?? current.claim_generation;
    requireCondition(Number.isInteger(repositoryGeneration) && repositoryGeneration > 0, "invalid repository cancellation generation", "CANCEL_UNCONFIRMED");
    if (prior) {
      requireCondition(prior.request_id === context.request_id && prior.request_digest === context.input_digest, "a different cancellation request already owns this delivery", "REQUEST_CONFLICT");
      return { epoch: prior.epoch, request_digest: prior.request_digest, outstanding_operation_ids: [...prior.outstanding_operation_ids] };
    }
    const priorRequest = current.controls.requests[context.request_id];
    if (priorRequest) requireCondition(priorRequest.action === "cancel" && priorRequest.request_digest === context.input_digest, "request ID was already used for different control input", "REQUEST_CONFLICT");
    const outstanding = [...new Set([
      ...current.executions.filter((item) => ["dispatching", "running", "uncertain"].includes(item.status)).map((item) => item.id),
      ...current.operations.filter((item) => ["intent", "accepted", "uncertain"].includes(item.status)).map((item) => item.id),
      ...current.unresolved_effects,
    ])].sort();
    const epoch = digest({ repo: current.repo_identity, delivery_id: current.delivery_id, request_id: context.request_id, input_digest: context.input_digest, repository_generation: repositoryGeneration, claim_generation: current.claim_generation, nonce: newToken(16) });
    const next = this.mutate(context.repo, context.delivery_id, context.expected_revision, (state) => {
      requireCondition(state.claim_status === "active" && !state.controls.cancelled, "delivery is already released or cancelled", "CANCEL_UNCONFIRMED");
      state.controls.cancellation = { epoch, request_id: context.request_id, request_digest: context.input_digest, expected_revision: context.expected_revision, repository_generation: repositoryGeneration, phase: "requested", requested_at: this.now().toISOString(), outstanding_operation_ids: outstanding, terminal_operation_ids: [] };
      state.controls.requests[context.request_id] = { action: "cancel", request_digest: context.input_digest, status: "pending", epoch, at: this.now().toISOString() };
      state.history.push(event("cancellation_requested", state.revision + 1, { request_id: context.request_id, epoch }));
    });
    return { epoch, request_digest: context.input_digest, outstanding_operation_ids: [...next.controls.cancellation!.outstanding_operation_ids] };
  }

  async reconcileCancellation(context: CancellationContext, ownedAdapters: CancellationOwnedAdapters): Promise<CancellationReconciliationResult> {
    let state = this.store.read(context.repo, context.delivery_id), cancellation = state.controls.cancellation;
    requireCondition(cancellation && cancellation.request_id === context.request_id && cancellation.request_digest === context.input_digest, "matching cancellation intent is missing", "REQUEST_CONFLICT");
    if (cancellation.phase === "complete") return { epoch: cancellation.epoch, request_digest: cancellation.request_digest, status: "complete", outstanding_operation_ids: [], terminal_operation_ids: [...cancellation.terminal_operation_ids] };
    state = this.mutate(context.repo, context.delivery_id, state.revision, (next) => { const intent = next.controls.cancellation!; requireCondition(intent.epoch === cancellation!.epoch, "cancellation epoch changed", "REQUEST_CONFLICT"); intent.phase = "reconciling"; next.history.push(event("cancellation_reconciling", next.revision + 1, { epoch: intent.epoch })); });
    for (const execution of state.executions.filter((item) => ["dispatching", "running", "uncertain"].includes(item.status))) {
      const port = execution.kind === "reviewer" ? ownedAdapters.reviewer : ownedAdapters.executor;
      if (!port || !execution.external_id) continue;
      state = this.mutate(context.repo, context.delivery_id, state.revision, (next) => { const intent = next.controls.cancellation, found = next.executions.find((item) => item.id === execution.id); requireCondition(intent?.epoch === cancellation!.epoch && found, "cancellation or execution changed before adapter cancellation", "REQUEST_CONFLICT"); if (!found.cancellation) found.cancellation = { epoch: intent.epoch, status: "intent", requested_at: this.now().toISOString() }; else requireCondition(found.cancellation.epoch === intent.epoch, "execution belongs to a different cancellation epoch", "REQUEST_CONFLICT"); });
      const expected: AdapterOutcomeExpectedContext = { repo: state.repo_identity, delivery_id: state.delivery_id, role: execution.kind, task_id: execution.id, packet_digest: execution.packet_digest ?? digest(execution.packet ?? { task_id: execution.id }), execution_id: execution.external_id };
      let resolved: { outcome: AdapterOutcome; proofDigest?: string };
      try { resolved = await this.resolveAdapterOutcome(port, await port.cancel(execution.external_id), expected); }
      catch (error) { resolved = { outcome: conservativeOutcome(error, String(error).slice(0, 500)) }; }
      const current = this.store.read(context.repo, context.delivery_id); if (current.claim_status === "released") break;
      state = this.mutate(context.repo, context.delivery_id, current.revision, (next) => {
        const intent = next.controls.cancellation, found = next.executions.find((item) => item.id === execution.id);
        requireCondition(intent?.epoch === cancellation!.epoch && found, "cancellation or execution changed during reconciliation", "REQUEST_CONFLICT");
        this.recordOutcome(found, resolved.outcome, resolved.proofDigest);
        const terminal = resolved.outcome.effect === "accepted" && ["completed", "failed", "cancelled", "timeout"].includes(resolved.outcome.terminal)
          || resolved.outcome.effect === "none" && resolved.outcome.terminal !== "nonterminal";
        if (terminal) {
          found.status = resolved.outcome.terminal === "cancelled" ? "cancelled" : resolved.outcome.terminal === "completed" ? "completed" : "failed"; found.finished_at = this.now().toISOString();
          found.cancellation = { epoch: intent.epoch, status: "completed", requested_at: found.cancellation?.requested_at ?? this.now().toISOString(), completed_at: this.now().toISOString() };
          intent.terminal_operation_ids = [...new Set([...intent.terminal_operation_ids, execution.id])].sort(); intent.outstanding_operation_ids = intent.outstanding_operation_ids.filter((id) => id !== execution.id); next.unresolved_effects = next.unresolved_effects.filter((id) => id !== execution.id);
        } else { found.status = "uncertain"; found.cancellation = { epoch: intent.epoch, status: "uncertain", requested_at: found.cancellation?.requested_at ?? this.now().toISOString() }; if (!next.unresolved_effects.includes(execution.id)) next.unresolved_effects.push(execution.id); if (!intent.outstanding_operation_ids.includes(execution.id)) intent.outstanding_operation_ids.push(execution.id); }
        next.history.push(event("cancellation_execution_reconciled", next.revision + 1, { epoch: intent.epoch, task_id: execution.id, effect: resolved.outcome.effect, terminal: resolved.outcome.terminal }));
      });
    }
    state = this.store.read(context.repo, context.delivery_id); cancellation = state.controls.cancellation!;
    const unresolvedOperations = state.operations.filter((item) => ["intent", "accepted", "uncertain"].includes(item.status)).map((item) => item.id);
    const liveExecutions = state.executions.filter((item) => ["dispatching", "running", "uncertain"].includes(item.status)).map((item) => item.id);
    const outstanding = [...new Set([...unresolvedOperations, ...liveExecutions, ...state.unresolved_effects])].sort();
    state = this.mutate(context.repo, context.delivery_id, state.revision, (next) => { const intent = next.controls.cancellation!; requireCondition(intent.epoch === cancellation!.epoch, "cancellation epoch changed", "REQUEST_CONFLICT"); intent.outstanding_operation_ids = outstanding; intent.phase = outstanding.length ? "reconciling" : "draining"; if (!outstanding.length) intent.reconciled_at = this.now().toISOString(); next.history.push(event(outstanding.length ? "cancellation_waiting" : "cancellation_reconciled", next.revision + 1, { epoch: intent.epoch, outstanding: outstanding.length })); });
    cancellation = state.controls.cancellation!;
    return { epoch: cancellation.epoch, request_digest: cancellation.request_digest, status: outstanding.length ? "uncertain" : "draining", outstanding_operation_ids: [...outstanding], terminal_operation_ids: [...cancellation.terminal_operation_ids] };
  }

  async reconcileCancellationExecutionReadback(context: CancellationContext, operationId: string, ownedAdapters: CancellationOwnedAdapters): Promise<CancellationReconciliationResult> {
    let state = this.store.read(context.repo, context.delivery_id), cancellation = state.controls.cancellation;
    requireCondition(cancellation && cancellation.request_id === context.request_id && cancellation.request_digest === context.input_digest, "matching cancellation intent is missing", "REQUEST_CONFLICT");
    const wasComplete = cancellation.phase === "complete";
    const execution = state.executions.find((item) => item.id === operationId);
    requireCondition(execution?.external_id, "cancellation execution readback identity is missing", "OPERATION_UNRESOLVED");
    const port = execution.kind === "reviewer" ? ownedAdapters.reviewer : ownedAdapters.executor;
    requireCondition(port, "cancellation execution readback adapter is unavailable", "OPERATION_UNRESOLVED");
    const expected: AdapterOutcomeExpectedContext = { repo: state.repo_identity, delivery_id: state.delivery_id, role: execution.kind, task_id: execution.id, packet_digest: execution.packet_digest ?? digest(execution.packet ?? { task_id: execution.id }), execution_id: execution.external_id };
    const resolved = await this.resolveAdapterOutcome(port, await port.inspect(execution.external_id), expected);
    const current = this.store.read(context.repo, context.delivery_id);
    state = this.mutate(context.repo, context.delivery_id, current.revision, (next) => {
      const intent = next.controls.cancellation, found = next.executions.find((item) => item.id === operationId);
      requireCondition(intent?.epoch === cancellation!.epoch && intent.request_id === context.request_id && intent.request_digest === context.input_digest, "cancellation changed during protected readback", "REQUEST_CONFLICT");
      requireCondition(found !== undefined, "cancellation execution disappeared during protected readback", "REQUEST_CONFLICT");
      requireCondition(found.external_id === execution.external_id && found.packet_digest === execution.packet_digest, "cancellation execution changed during protected readback", "REQUEST_CONFLICT");
      this.recordOutcome(found, resolved.outcome, resolved.proofDigest);
      const terminal = resolved.outcome.effect === "accepted" && ["completed", "failed", "cancelled", "timeout"].includes(resolved.outcome.terminal)
        || resolved.outcome.effect === "none" && resolved.outcome.terminal !== "nonterminal";
      if (terminal) {
        found.status = resolved.outcome.terminal === "cancelled" ? "cancelled" : resolved.outcome.terminal === "completed" ? "completed" : "failed";
        found.finished_at ??= this.now().toISOString();
        found.cancellation = { epoch: intent.epoch, status: "completed", requested_at: found.cancellation?.requested_at ?? intent.requested_at, completed_at: found.cancellation?.completed_at ?? this.now().toISOString() };
        intent.terminal_operation_ids = [...new Set([...intent.terminal_operation_ids, found.id])].sort();
        intent.outstanding_operation_ids = intent.outstanding_operation_ids.filter((id) => id !== found.id);
        next.unresolved_effects = next.unresolved_effects.filter((id) => id !== found.id);
      } else {
        found.status = "uncertain";
        found.cancellation = { epoch: intent.epoch, status: "uncertain", requested_at: found.cancellation?.requested_at ?? intent.requested_at };
        if (!intent.outstanding_operation_ids.includes(found.id)) intent.outstanding_operation_ids.push(found.id);
        if (!next.unresolved_effects.includes(found.id)) next.unresolved_effects.push(found.id);
      }
      const outstanding = [...new Set([
        ...next.operations.filter((item) => ["intent", "accepted", "uncertain"].includes(item.status)).map((item) => item.id),
        ...next.executions.filter((item) => ["dispatching", "running", "uncertain"].includes(item.status)).map((item) => item.id),
        ...next.unresolved_effects,
      ])].sort();
      intent.outstanding_operation_ids = outstanding;
      if (!wasComplete) {
        intent.phase = outstanding.length ? "reconciling" : "draining";
        if (!outstanding.length) intent.reconciled_at ??= this.now().toISOString();
      }
      next.history.push(event("cancellation_execution_readback", next.revision + 1, { epoch: intent.epoch, task_id: found.id, effect: resolved.outcome.effect, terminal: resolved.outcome.terminal }));
    });
    cancellation = state.controls.cancellation!;
    return { epoch: cancellation.epoch, request_digest: cancellation.request_digest, status: cancellation.outstanding_operation_ids.length ? "uncertain" : wasComplete ? "complete" : "draining", outstanding_operation_ids: [...cancellation.outstanding_operation_ids], terminal_operation_ids: [...cancellation.terminal_operation_ids] };
  }

  finalizeCancellation(context: CancellationContext, fence: RepositoryCancellationFence): CancellationFinalizeResult {
    const current = this.store.read(context.repo, context.delivery_id), cancellation = current.controls.cancellation;
    requireCondition(cancellation && cancellation.request_id === context.request_id && cancellation.request_digest === context.input_digest, "matching cancellation intent is missing", "REQUEST_CONFLICT");
    requireCondition(/^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/.test(fence.reservation_token) && /^[0-9a-f]{64}$/.test(fence.owner_token_digest) && /^[0-9a-f]{64}$/.test(fence.stopped_drained_ack_digest), "repository cancellation fence is malformed", "CANCEL_UNCONFIRMED");
    requireCondition(fence.repo === context.repo && fence.delivery_id === context.delivery_id && fence.request_id === context.request_id && fence.input_digest === context.input_digest && fence.epoch === cancellation.epoch
      && fence.generation === cancellation.repository_generation && fence.claim_generation === current.claim_generation, "repository cancellation fence differs from engine intent", "CANCEL_UNCONFIRMED");
    requireCondition(cancellation.phase === "draining" || cancellation.phase === "complete", "cancellation effects have not drained", "CANCEL_UNCONFIRMED");
    if (cancellation.phase === "complete") return { epoch: cancellation.epoch, request_digest: cancellation.request_digest, released: true };
    const next = this.mutate(context.repo, context.delivery_id, current.revision, (state) => {
      const intent = state.controls.cancellation!; requireCondition(intent.epoch === fence.epoch && intent.repository_generation === fence.generation && state.claim_generation === fence.claim_generation && intent.outstanding_operation_ids.length === 0, "cancellation has outstanding operations", "CANCEL_UNCONFIRMED");
      requireCondition(!state.executions.some((item) => ["dispatching", "running", "uncertain"].includes(item.status)) && !state.operations.some((item) => ["intent", "accepted", "uncertain"].includes(item.status)) && state.unresolved_effects.length === 0, "external effects remain unresolved", "CANCEL_UNCONFIRMED");
      intent.phase = "complete"; intent.completed_at = this.now().toISOString(); state.controls.cancelled = true; state.controls.paused = true; state.status = "cancelled"; state.runner.status = "cancelled"; state.claim_status = "released";
      const request = state.controls.requests[context.request_id] ?? { action: "cancel", request_digest: context.input_digest, at: this.now().toISOString() }; request.status = "completed"; request.completed_at = this.now().toISOString(); request.repository_fence_digest = digest(fence); state.controls.requests[context.request_id] = request;
      state.history.push(event("cancellation_finalized", state.revision + 1, { epoch: intent.epoch, fence_digest: digest(fence) }));
    });
    this.store.release(next); return { epoch: cancellation.epoch, request_digest: cancellation.request_digest, released: true };
  }

  private async authorizeReviewRetry(input: ControlInput, requestDigest: string): Promise<DeliveryState> {
    requireCondition(this.reviewer, "independent reviewer is required", "VERIFICATION_REQUIRED");
    const state = this.store.read(input.repo, input.deliveryId);
    requireCondition(state.revision === input.expectedRevision, `stale state revision: current ${state.revision}`, "STALE_REVISION");
    this.ensureActive(state);
    requireCondition(state.status === "blocked" && !state.controls.paused && state.unresolved_effects.length === 0, "review retry requires an explained clean preflight block", "DELIVERY_BLOCKED");
    requireCondition(!state.executions.some((item) => item.kind === "reviewer" && ["dispatching", "running", "uncertain"].includes(item.status)), "a reviewer attempt is still live or unresolved", "OPERATION_UNRESOLVED");
    const manifest = state.manifests.implement, check = state.receipts.checks;
    requireCondition(manifest && check && check.status === "success" && check.candidate_sha === manifest.value.result.candidate_sha && check.manifest_digest === manifest.digest,
      "exact successful candidate checks are required", "VERIFICATION_REQUIRED");
    requireCondition(typeof manifest.producer_execution_id === "string" && typeof manifest.producer_identity === "string" && manifest.producer_identity.length > 0,
      "accepted implementation manifest is not bound to a trusted producer execution", "VERIFICATION_REQUIRED");
    const candidate = manifest.value.result.candidate_sha as string, producerExecutionId = manifest.producer_execution_id, producerIdentity = manifest.producer_identity;
    const producer = state.executions.find((item) => item.id === producerExecutionId);
    requireCondition(producer?.kind === "agent" && producer.stage === "implement" && producer.status === "completed" && producer.implementer_identity === producerIdentity,
      "implementation producer execution identity is not protected", "VERIFICATION_REQUIRED");
    requireCondition(!state.receipts.engineering, "an existing engineering approval cannot authorize a review retry", "VERIFICATION_REQUIRED");
    const criteriaDigest = digest({ delivery_id: input.deliveryId, issue: state.issue, candidate_sha: candidate, manifest_digest: manifest.digest, plan_digest: state.manifests.plan?.digest ?? null, producer_execution_id: producerExecutionId, producer_identity: producerIdentity });
    const initialTaskId = digest({ repo: state.repo_identity, delivery: input.deliveryId, kind: "engineering_review", candidate, manifest: manifest.digest, criteria_digest: criteriaDigest }).slice(0, 24);
    const binding: ReviewBinding = { deliveryId: input.deliveryId, candidate, manifestDigest: manifest.digest, manifestGeneration: manifest.generation, criteriaDigest, producerExecutionId, producerIdentity, initialTaskId };
    const predecessor = latestReviewChain(state, binding);
    requireCondition(predecessor?.status === "failed" && predecessor.effect === "none" && predecessor.terminal === "failed"
      && predecessor.proof?.kind === "preflight_refusal" && typeof predecessor.proof_digest === "string" && typeof predecessor.outcome_error === "string" && predecessor.outcome_error.length > 0,
      "latest review attempt is not an eligible protected preflight refusal", "VERIFICATION_REQUIRED");
    const ordinal = (predecessor.review_attempt ?? 0) + 1;
    requireCondition(ordinal < state.budget.max_attempts, "review retry budget exhausted", "BUDGET_EXHAUSTED");
    const context: AdapterOutcomeExpectedContext = { repo: state.repo_identity, delivery_id: input.deliveryId, role: "reviewer", task_id: predecessor.id,
      packet_digest: predecessor.packet_digest! };
    const proof = await this.resolveAdapterOutcome(this.reviewer, { status: "failed", effect: "none", terminal: "failed", ...(predecessor.external_id ? { execution_id: predecessor.external_id } : {}),
      ...(predecessor.provider ? { provider: predecessor.provider } : {}), proof: predecessor.proof, error: predecessor.outcome_error }, context);
    requireCondition(protectedPreflightRefusal(proof) && proof.proofDigest === predecessor.proof_digest, "reviewer preflight proof no longer resolves to the protected refusal", "VERIFICATION_REQUIRED");
    const checkDigest = digest(check), taskId = digest({ repo: state.repo_identity, delivery: input.deliveryId, kind: "engineering_review_retry", candidate,
      manifest: manifest.digest, generation: manifest.generation, criteria_digest: criteriaDigest, check_digest: checkDigest, predecessor: predecessor.id, review_attempt: ordinal }).slice(0, 24);
    const packet = JSON.parse(JSON.stringify({ schema_version: 1, kind: "review", repo: input.repo, delivery_id: input.deliveryId, manifest_generation: manifest.generation,
      candidate_sha: candidate, criteria: { issue: state.issue, plan_digest: state.manifests.plan?.digest, manifest_digest: manifest.digest, criteria_digest: criteriaDigest },
      producer_execution_id: producerExecutionId, producer_identity: producerIdentity, check_digest: checkDigest, review_attempt: ordinal,
      predecessor_task_id: predecessor.id, retry_request_id: input.requestId, task_id: taskId })) as JsonObject;
    const packetDigest = digest(packet);
    return this.mutate(input.repo, input.deliveryId, input.expectedRevision, (next) => {
      this.ensureActive(next);
      requireCondition(next.status === "blocked" && !next.controls.paused && next.unresolved_effects.length === 0, "review retry eligibility changed", "OPERATION_UNRESOLVED");
      requireCondition(next.manifests.implement?.digest === manifest.digest && next.manifests.implement.generation === manifest.generation
        && next.manifests.implement.value.result.candidate_sha === candidate && digest(next.receipts.checks) === checkDigest, "review candidate or check evidence changed", "OPERATION_UNRESOLVED");
      const protectedProducer = next.executions.find((item) => item.id === producerExecutionId);
      requireCondition(protectedProducer?.status === "completed" && protectedProducer.implementer_identity === producerIdentity && !next.receipts.engineering,
        "review producer or approval state changed", "OPERATION_UNRESOLVED");
      const protectedPredecessor = latestReviewChain(next, binding);
      requireCondition(protectedPredecessor?.id === predecessor.id && protectedPredecessor.proof_digest === predecessor.proof_digest && protectedPredecessor.status === "failed",
        "review attempt chain changed", "OPERATION_UNRESOLVED");
      next.executions.push({ id: taskId, kind: "reviewer", stage: "engineering_review", status: "dispatching", review_attempt: ordinal,
        predecessor_task_id: predecessor.id, retry_request_id: input.requestId, packet_digest: packetDigest, packet, started_at: this.now().toISOString() });
      next.status = "implementation_review";
      next.controls.requests[input.requestId] = { action: input.action, request_digest: requestDigest, status: "completed", at: this.now().toISOString(), completed_at: this.now().toISOString(),
        result_revision: next.revision + 1, review_task_id: taskId, predecessor_task_id: predecessor.id, review_attempt: ordinal,
        ...(predecessor.proof_digest ? { failed_proof_digest: predecessor.proof_digest } : {}),
        ...(predecessor.packet_digest ? { failed_packet_digest: predecessor.packet_digest } : {}), check_digest: checkDigest };
      next.history.push(event("control_retry_review", next.revision + 1, { request_id: input.requestId, task_id: taskId, predecessor_task_id: predecessor.id, review_attempt: ordinal }));
    });
  }

  async control(input: ControlInput): Promise<SafeProjection> {
    requireCondition(this.grant && input.grant === this.grant.token && this.grant.repositories.includes(input.repo) && this.grant.actions.includes(input.action), "operator control is disabled or unauthorized", "UNAUTHORIZED");
    requireCondition(/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(input.requestId), "invalid request ID");
    if (input.action === "export_handoff" || input.action === "bind_manual_pr") {
      requireCondition(input.stage === "plan" || input.stage === "implementation", "manual publication stage is required", "INVALID_ARGUMENT");
      requireCondition(input.action === "export_handoff" && input.number === undefined || input.action === "bind_manual_pr" && Number.isInteger(input.number) && input.number! > 0,
        "manual pull request binding requires a positive number", "INVALID_ARGUMENT");
    }
    const requestDigest = controlRequestDigest(input);
    let current = this.store.read(input.repo, input.deliveryId);
    const prior = current.controls.requests[input.requestId];
    const retryPendingCancel = prior?.status === "pending" && input.action === "cancel";
    if (prior) {
      requireCondition(prior.action === input.action && prior.request_digest === requestDigest, "request ID was already used for different control input", "REQUEST_CONFLICT");
      if (!retryPendingCancel) {
        if (["intent", "uncertain"].includes(String(prior.status)) && ["publish_plan", "publish_implementation", "recheck_ready", "export_handoff", "bind_manual_pr"].includes(input.action)) {
          await this.reconcileControlRequest({ ...input, repositoryInputDigest: repositoryCommandInputDigest(input) });
          return safeProjection(this.store.read(input.repo, input.deliveryId), this.now());
        }
        return safeProjection(current, this.now());
      }
    }
    requireCondition(current.claim_status !== "released" && !["review_ready", "completed", "cancelled"].includes(current.status), "terminal or released delivery does not accept new controls", "DELIVERY_BLOCKED");
    if (input.action === "retry_review") return safeProjection(await this.authorizeReviewRetry(input, requestDigest), this.now());
    if (["publish_plan", "publish_implementation", "recheck_ready", "export_handoff", "bind_manual_pr", "cancel"].includes(input.action)) {
      if (!retryPendingCancel) current = this.mutate(input.repo, input.deliveryId, input.expectedRevision, (state) => {
        state.controls.requests[input.requestId] = { action: input.action, request_digest: requestDigest, status: "intent", at: this.now().toISOString(),
          ...((input.action === "export_handoff" || input.action === "bind_manual_pr") ? { previous_status: state.status, stage: input.stage!, ...(input.number === undefined ? {} : { number: input.number }) } : {}) };
        state.history.push(event(`control_${input.action}_intent`, state.revision + 1, { request_id: input.requestId, request_digest: requestDigest }));
      });
    }
    if (input.action === "publish_plan" || input.action === "publish_implementation") {
      requireCondition(current.safeguards.publication.pr === "explicit", "explicit pull request publication is disabled by protected policy", "AUTHORIZATION_REQUIRED");
      const stage = input.action === "publish_plan" ? "plan" : "implementation";
      try {
        const published = await this.publishStageAuthorized(input.repo, input.deliveryId, stage, current.revision, input.draftDigest, input.requestId);
        const completed = this.mutate(input.repo, input.deliveryId, published.revision, (state) => { const request = state.controls.requests[input.requestId]!; request.status = state.status === "blocked" ? "uncertain" : "completed"; request.completed_at = this.now().toISOString(); request.result_revision = state.revision + 1; });
        return safeProjection(completed, this.now());
      } catch (error) {
        const completed = this.completePublishedControl(input, requestDigest); if (completed) return safeProjection(completed, this.now());
        const latest = this.store.read(input.repo, input.deliveryId), operations = this.publicationControlOperations(latest, input);
        const terminal = operations.length === 1 ? operations[0]!.status === "failed" : operations.length === 0 && !this.hasControlOperationLink(latest, input) && knownLocalPublicationFailure(error);
        return safeProjection(terminal ? this.controlFailed(input, requestDigest, error) : this.controlUncertain(input, requestDigest, error), this.now());
      }
    }
    if (input.action === "recheck_ready") {
      try {
        const checked = await this.recheckReady(input.repo, input.deliveryId, current.revision, input.requestId, input.requestId);
        const request = checked.controls.requests[input.requestId]; if (checked.claim_status === "released" || request?.status === "completed") return safeProjection(checked, this.now());
        const completed = this.mutate(input.repo, input.deliveryId, checked.revision, (state) => { const request = state.controls.requests[input.requestId]!; request.status = "completed"; request.completed_at = this.now().toISOString(); request.result_revision = state.revision + 1; });
        return safeProjection(completed, this.now());
      } catch (error) {
        if (enginePreEffectTransientReadOutcome(error)?.transition === "recheck_ready") return safeProjection(this.store.read(input.repo, input.deliveryId), this.now());
        return safeProjection(knownLocalPublicationFailure(error) ? this.controlFailed(input, requestDigest, error) : this.controlUncertain(input, requestDigest, error), this.now());
      }
    }
    if (input.action === "export_handoff" || input.action === "bind_manual_pr") {
      try {
        const changed = input.action === "export_handoff"
          ? await this.exportManualHandoff(input.repo, input.deliveryId, input.stage!, current.revision, input.requestId)
          : await this.bindManualPullRequest(input.repo, input.deliveryId, input.stage!, input.number!, current.revision, input.requestId);
        const completed = this.mutate(input.repo, input.deliveryId, changed.revision, (state) => {
          const request = state.controls.requests[input.requestId]!; request.status = state.status === "blocked" ? "uncertain" : "completed";
          request.completed_at = this.now().toISOString(); request.result_revision = state.revision + 1;
        });
        return safeProjection(completed, this.now());
      } catch (error) {
        const completed = this.completePublishedControl(input, requestDigest); if (completed) return safeProjection(completed, this.now());
        const latest = this.store.read(input.repo, input.deliveryId), operations = this.publicationControlOperations(latest, input);
        const terminal = operations.length === 1 ? operations[0]!.status === "failed" : operations.length === 0 && !this.hasControlOperationLink(latest, input) && knownLocalPublicationFailure(error);
        return safeProjection(terminal ? this.controlFailed(input, requestDigest, error) : this.controlUncertain(input, requestDigest, error), this.now());
      }
    }
    if (input.action === "cancel") { this.beginCancellation({ repo: input.repo, delivery_id: input.deliveryId, expected_revision: current.revision, request_id: input.requestId, input_digest: requestDigest, grant: input.grant }); return safeProjection(this.store.read(input.repo, input.deliveryId), this.now()); }
    const next = this.mutate(input.repo, input.deliveryId, input.expectedRevision, (state) => {
      if (input.action === "pause") { state.controls.paused = true; if (state.runner.status === "idle") state.runner.status = "paused"; }
      else if (input.action === "resume") { requireCondition(!state.controls.cancelled, "cancelled delivery cannot resume"); state.controls.paused = false; if (state.runner.status === "paused") state.runner.status = "idle"; }
      else if (input.action === "recover") { requireCondition(state.runner.status === "failed" || state.runner.status === "running", "recover requires stranded running state"); if (state.runner.owner_pid) { try { process.kill(state.runner.owner_pid, 0); throw new DeliveryError("old runner process is still alive"); } catch (error) { if (error instanceof DeliveryError) throw error; if ((error as NodeJS.ErrnoException).code === "EPERM") throw new DeliveryError("old runner process may still be alive"); } } const execution = state.executions.find((item) => item.id === state.runner.execution_id); requireCondition(!execution || ["failed", "completed", "cancelled"].includes(execution.status), "remote execution outcome must be reconciled before recovery"); state.runner = { status: "idle", owner_pid: null }; state.attempt += 1; }
      else if (input.action === "correct") { requireCondition(state.status === "plan_review" || state.status === "implementation_review", "correction requires a review stage"); const stage = state.status === "plan_review" ? "plan" : "implementation"; state.status = stage === "plan" ? "plan_required" : "implementation_required"; delete state.handoffs[stage]; delete state.publication[stage]; delete state.publication[`${stage}_manual_handoff`]; delete state.receipts[stage]; if (stage === "implementation") { delete state.receipts.engineering; delete state.receipts.checks; } state.runner = { status: "idle", owner_pid: null }; }
      state.controls.requests[input.requestId] = { action: input.action, request_digest: requestDigest, status: "completed", at: this.now().toISOString(), completed_at: this.now().toISOString() }; state.history.push(event(`control_${input.action}`, state.revision + 1, { request_id: input.requestId, request_digest: requestDigest }));
    });
    return safeProjection(next, this.now());
  }

  async reconcileControlRequest(input: ControlReconciliationInput): Promise<ControlReconciliationResult> {
    requireCondition(this.grant && input.grant === this.grant.token && this.grant.repositories.includes(input.repo) && this.grant.actions.includes(input.action), "operator control reconciliation is disabled or unauthorized", "UNAUTHORIZED");
    requireCondition(/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(input.requestId) && /^[0-9a-f]{64}$/.test(input.repositoryInputDigest), "invalid control reconciliation identity", "INVALID_ARGUMENT");
    requireCondition(["publish_plan", "publish_implementation", "retry_review", "recheck_ready", "correct", "export_handoff", "bind_manual_pr"].includes(input.action), "control action does not support command reconciliation", "INVALID_ARGUMENT");
    if (input.action === "export_handoff" || input.action === "bind_manual_pr") {
      requireCondition(input.stage === "plan" || input.stage === "implementation", "manual publication stage is required", "INVALID_ARGUMENT");
      requireCondition(input.action === "export_handoff" && input.number === undefined || input.action === "bind_manual_pr" && Number.isInteger(input.number) && input.number! > 0,
        "manual pull request binding requires a positive number", "INVALID_ARGUMENT");
    }
    const repositoryInputDigest = repositoryCommandInputDigest(input); requireCondition(input.repositoryInputDigest === repositoryInputDigest, "repository command digest differs from reconciliation input", "REQUEST_CONFLICT");
    const requestDigest = controlRequestDigest(input);
    const result = (state: DeliveryState, status: ControlReconciliationResult["status"], operationId?: string, error?: unknown): ControlReconciliationResult => ({ status, request_digest: requestDigest, repository_input_digest: repositoryInputDigest, revision: state.revision, ...(operationId ? { operation_id: operationId } : {}), ...(error !== undefined ? boundedError(error) : {}) });
    const historicalCausalOperations = (current: DeliveryState) => input.action === "publish_plan" || input.action === "publish_implementation"
      ? this.historicalPublicationControlOperations(current, input)
      : input.action === "export_handoff" || input.action === "bind_manual_pr" ? this.historicalManualControlOperations(current, input)
      : current.operations.filter((operation) => operation.action === "finalize" && operation.request?.payload && (operation.request.payload as JsonObject).readback_id === input.requestId);
    let state = this.store.read(input.repo, input.deliveryId), request = state.controls.requests[input.requestId];
    if (input.action === "retry_review") {
      if (!request) return result(state, "absent");
      const taskId = request.review_task_id, predecessorId = request.predecessor_task_id, ordinal = request.review_attempt;
      const execution = typeof taskId === "string" ? state.executions.find((item) => item.id === taskId) : undefined;
      const packet = execution?.packet;
      const exact = request.action === input.action && request.request_digest === requestDigest && request.status === "completed"
        && typeof taskId === "string" && typeof predecessorId === "string" && Number.isInteger(ordinal) && Number(ordinal) > 0
        && execution?.kind === "reviewer" && execution.stage === "engineering_review" && execution.predecessor_task_id === predecessorId
        && execution.review_attempt === ordinal && execution.retry_request_id === input.requestId && execution.packet_digest === digest(packet)
        && packet?.task_id === taskId && packet.predecessor_task_id === predecessorId && packet.review_attempt === ordinal && packet.retry_request_id === input.requestId
        && request.failed_proof_digest === state.executions.find((item) => item.id === predecessorId)?.proof_digest;
      return result(state, exact ? "completed" : "uncertain");
    }
    if (!request) {
      const historical = historicalCausalOperations(state);
      if ((input.action === "export_handoff" || input.action === "bind_manual_pr") && historical.length === 1) {
        const operation = historical[0]!;
        state = this.mutate(input.repo, input.deliveryId, state.revision, (next) => {
          const exact = this.historicalManualControlOperations(next, input); requireCondition(exact.length === 1 && exact[0]!.id === operation.id, "legacy manual publication operation changed during adoption", "REQUEST_CONFLICT");
          next.controls.requests[input.requestId] = { action: input.action, request_digest: requestDigest, status: operation.status === "failed" ? "failed" : operation.status === "completed" ? "completed" : "uncertain",
            at: this.now().toISOString(), operation_id: operation.id, operation_request_digest: operation.request_digest, stage: input.stage!, ...(input.number === undefined ? {} : { number: input.number }),
            previous_status: `${input.stage}_review` };
          next.history.push(event(`control_${input.action}_adopted`, next.revision + 1, { request_id: input.requestId, operation_id: operation.id }));
        });
        request = state.controls.requests[input.requestId];
      } else if (historical.length) return result(state, "uncertain", historical.length === 1 ? historical[0]!.id : undefined);
      if (state.claim_status === "released" || state.controls.cancellation || state.controls.cancelled) return result(state, "absent");
      if (input.mode === "readback") return result(state, "absent");
      if (!request) {
        await this.control(input); state = this.store.read(input.repo, input.deliveryId); request = state.controls.requests[input.requestId];
        const status = request?.status; return result(state, status === "completed" ? "completed" : status === "failed" ? "failed" : "uncertain");
      }
    }
    requireCondition(request.action === input.action && request.request_digest === requestDigest, "control reconciliation input differs from protected request", "REQUEST_CONFLICT");
    if (request.status === "completed") return result(state, "completed");
    if (state.claim_status === "released" || state.controls.cancelled) return result(state, "uncertain");
    if (input.action === "correct") return result(state, "uncertain");

    const causalOperations = (current: DeliveryState) => {
      if (input.action === "publish_plan" || input.action === "publish_implementation" || input.action === "export_handoff" || input.action === "bind_manual_pr") return this.publicationControlOperations(current, input);
      const protectedRequest = current.controls.requests[input.requestId], linkedId = protectedRequest?.operation_id, linkedDigest = protectedRequest?.operation_request_digest;
      if (typeof linkedId === "string" || typeof linkedDigest === "string") {
        if (typeof linkedId !== "string" || typeof linkedDigest !== "string") return [];
        return current.operations.filter((operation) => operation.id === linkedId && operation.action === (input.action === "recheck_ready" ? "finalize" : input.action) && operation.request_digest === linkedDigest);
      }
      return historicalCausalOperations(current);
    };
    const locateOperation = (current: DeliveryState) => { const candidates = causalOperations(current); return candidates.length === 1 ? candidates[0] : undefined; };
    const hasProtectedLink = (current: DeliveryState) => this.hasControlOperationLink(current, input) || causalOperations(current).length > 0;
    let operation = locateOperation(state), recoveryError: unknown;
    if (request.status === "failed" && !operation) return result(state, "failed");
    if (!operation) {
      if (state.controls.cancellation) return result(state, "uncertain");
      if (input.mode === "readback") {
        state = this.mutate(input.repo, input.deliveryId, state.revision, (next) => {
          const protectedRequest = next.controls.requests[input.requestId]; requireCondition(protectedRequest?.action === input.action && protectedRequest.request_digest === requestDigest && !locateOperation(next), "control request changed during pre-effect retirement", "REQUEST_CONFLICT");
          protectedRequest.status = "failed"; protectedRequest.error = "publisher operation was never durably admitted"; protectedRequest.error_code = "NO_EFFECT"; protectedRequest.completed_at = this.now().toISOString();
          if ((input.action === "export_handoff" || input.action === "bind_manual_pr") && next.status === "blocked" && typeof protectedRequest.previous_status === "string") next.status = protectedRequest.previous_status as DeliveryState["status"];
          next.unresolved_effects = next.unresolved_effects.filter((item) => item !== input.requestId); next.history.push(event(`control_${input.action}_reconciled`, next.revision + 1, { request_id: input.requestId, status: "failed", effect: "none" }));
        });
        return result(state, "failed", undefined, new DeliveryError("publisher operation was never durably admitted", "NO_EFFECT"));
      }
      if (hasProtectedLink(state)) return result(state, "uncertain");
      try {
        if (input.action === "publish_plan" || input.action === "publish_implementation") {
          const stage = input.action === "publish_plan" ? "plan" : "implementation";
          state = await this.publishStageAuthorized(input.repo, input.deliveryId, stage, state.revision, input.draftDigest, input.requestId);
        } else if (input.action === "export_handoff") state = await this.exportManualHandoff(input.repo, input.deliveryId, input.stage!, state.revision, input.requestId);
        else if (input.action === "bind_manual_pr") state = await this.bindManualPullRequest(input.repo, input.deliveryId, input.stage!, input.number!, state.revision, input.requestId);
        else state = await this.recheckReady(input.repo, input.deliveryId, state.revision, input.requestId, input.requestId);
      } catch (error) { recoveryError = error; state = this.store.read(input.repo, input.deliveryId); }
      operation = locateOperation(state);
    } else if (["intent", "accepted", "uncertain"].includes(operation.status) && input.mode !== "readback") {
      try { state = await this.reconcilePublicationEffects(input.repo, input.deliveryId, state.revision, "recover"); }
      catch (error) { recoveryError = error; state = this.store.read(input.repo, input.deliveryId); }
      operation = locateOperation(state);
    } else if (["intent", "accepted", "uncertain"].includes(operation.status) && input.mode === "readback") {
      try { state = await this.reconcilePublicationEffects(input.repo, input.deliveryId, state.revision, "readback"); }
      catch (error) { recoveryError = error; state = this.store.read(input.repo, input.deliveryId); }
      operation = locateOperation(state);
    }
    if (!operation) {
      if (recoveryError !== undefined && knownLocalPublicationFailure(recoveryError)) {
        state = this.mutate(input.repo, input.deliveryId, state.revision, (next) => {
          const protectedRequest = next.controls.requests[input.requestId];
          requireCondition(protectedRequest?.action === input.action && protectedRequest.request_digest === requestDigest && !locateOperation(next), "control request changed during no-effect reconciliation", "REQUEST_CONFLICT");
          protectedRequest.status = "failed"; protectedRequest.error = boundedError(recoveryError).error; protectedRequest.completed_at = this.now().toISOString(); protectedRequest.result_revision = next.revision + 1;
          next.unresolved_effects = next.unresolved_effects.filter((item) => item !== input.requestId);
          next.history.push(event(`control_${input.action}_reconciled`, next.revision + 1, { request_id: input.requestId, status: "failed", effect: "none" }));
        });
        return result(state, "failed", undefined, recoveryError);
      }
      return result(state, "uncertain", undefined, recoveryError);
    }
    if (operation.status === "intent" || operation.status === "accepted" || operation.status === "uncertain") return result(state, "uncertain", operation.id, recoveryError);

    if (state.claim_status === "released") return result(state, "uncertain", operation.id);
    state = this.mutate(input.repo, input.deliveryId, state.revision, (next) => {
      const protectedRequest = next.controls.requests[input.requestId], protectedOperation = next.operations.find((item) => item.id === operation!.id);
      requireCondition(protectedRequest?.action === input.action && protectedRequest.request_digest === requestDigest, "control request changed during reconciliation", "REQUEST_CONFLICT");
      requireCondition(protectedOperation?.status === operation!.status && ["completed", "failed"].includes(protectedOperation.status), "control operation changed during reconciliation", "OPERATION_UNRESOLVED");
      protectedRequest.status = protectedOperation.status; protectedRequest.completed_at = this.now().toISOString(); protectedRequest.result_revision = next.revision + 1;
      next.unresolved_effects = next.unresolved_effects.filter((item) => item !== input.requestId);
      if (protectedOperation.status === "completed" && !next.controls.cancellation) {
        if (input.action === "publish_plan") next.status = next.requirements.plan > 0 ? "plan_review" : "implementation_required";
        else if (input.action === "publish_implementation") next.status = next.requirements.implementation > 0 ? "implementation_review" : "publication_pending";
        else if (input.action === "export_handoff" && typeof protectedRequest.previous_status === "string") next.status = protectedRequest.previous_status as DeliveryState["status"];
        else if (input.action !== "bind_manual_pr" && protectedOperation.receipt && typeof protectedOperation.receipt.status === "string") next.status = protectedOperation.receipt.status as DeliveryState["status"];
      } else if (protectedOperation.status === "failed" && (input.action === "export_handoff" || input.action === "bind_manual_pr") && next.status === "blocked" && typeof protectedRequest.previous_status === "string") {
        next.status = protectedRequest.previous_status as DeliveryState["status"];
      }
      next.history.push(event(`control_${input.action}_reconciled`, next.revision + 1, { request_id: input.requestId, operation_id: protectedOperation.id, status: protectedOperation.status }));
    });
    return result(state, operation.status, operation.id);
  }

  private controlUncertain(input: ControlInput, requestDigest: string, error: unknown): DeliveryState {
    const current = this.store.read(input.repo, input.deliveryId);
    return this.mutate(input.repo, input.deliveryId, current.revision, (state) => { const request = state.controls.requests[input.requestId] ?? { action: input.action, request_digest: requestDigest, at: this.now().toISOString() }; request.status = "uncertain"; request.error = String(error).slice(0, 500); state.controls.requests[input.requestId] = request; state.status = "blocked"; if (!state.unresolved_effects.includes(input.requestId)) state.unresolved_effects.push(input.requestId); state.history.push(event(`control_${input.action}_uncertain`, state.revision + 1, { request_id: input.requestId })); });
  }

  private controlFailed(input: ControlInput, requestDigest: string, error: unknown): DeliveryState {
    const current = this.store.read(input.repo, input.deliveryId);
    return this.mutate(input.repo, input.deliveryId, current.revision, (state) => {
      const request = state.controls.requests[input.requestId] ?? { action: input.action, request_digest: requestDigest, at: this.now().toISOString() };
      request.status = "failed"; request.error = String(error).slice(0, 500); request.completed_at = this.now().toISOString(); state.controls.requests[input.requestId] = request;
      state.unresolved_effects = state.unresolved_effects.filter((item) => item !== input.requestId);
      state.history.push(event(`control_${input.action}_failed`, state.revision + 1, { request_id: input.requestId }));
    });
  }

  private completePublishedControl(input: ControlInput, requestDigest: string): DeliveryState | undefined {
    if (!["publish_plan", "publish_implementation", "export_handoff", "bind_manual_pr"].includes(input.action)) return undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const current = this.store.read(input.repo, input.deliveryId), operations = this.publicationControlOperations(current, input);
      if (operations.length !== 1 || operations[0]!.status !== "completed") return undefined;
      const operationId = operations[0]!.id;
      try {
        return this.mutate(input.repo, input.deliveryId, current.revision, (next) => {
          const request = next.controls.requests[input.requestId], protectedOperations = this.publicationControlOperations(next, input), protectedOperation = protectedOperations.length === 1 ? protectedOperations[0] : undefined;
          requireCondition(request?.action === input.action && request.request_digest === requestDigest && protectedOperation?.id === operationId && protectedOperation.status === "completed", "completed publication control changed during reconciliation", "OPERATION_UNRESOLVED");
          request.status = "completed"; request.completed_at = this.now().toISOString(); request.result_revision = next.revision + 1; next.unresolved_effects = next.unresolved_effects.filter((item) => item !== input.requestId);
          next.history.push(event(`control_${input.action}_completed_after_cas`, next.revision + 1, { request_id: input.requestId, operation_id: operationId }));
        });
      } catch (error) { if (!(error instanceof DeliveryError) || error.code !== "STALE_REVISION" || attempt === 1) throw error; }
    }
    return undefined;
  }

  private hasControlOperationLink(state: DeliveryState, input: ControlInput): boolean {
    const request = state.controls.requests[input.requestId];
    return typeof request?.operation_id === "string" || typeof request?.operation_request_digest === "string";
  }

  private historicalPublicationControlOperations(state: DeliveryState, input: ControlInput) {
    return state.operations.filter((operation) => operation.action === input.action && operation.expected_revision === input.expectedRevision + 1);
  }

  private historicalManualControlOperations(state: DeliveryState, input: ControlInput) {
    if ((input.action !== "export_handoff" && input.action !== "bind_manual_pr") || (input.stage !== "plan" && input.stage !== "implementation")) return [];
    const handoff = state.handoffs[input.stage]; if (!handoff) return [];
    const payload = input.action === "export_handoff" ? handoff.payload : { number: input.number, title: handoff.payload.title, body: handoff.payload.body };
    return state.operations.filter((operation) => operation.action === input.action && operation.stage === input.stage && operation.expected_revision === input.expectedRevision
      && canonicalJson(operation.request?.expected ?? null) === canonicalJson(handoff.expected) && canonicalJson(operation.request?.payload ?? null) === canonicalJson(payload));
  }

  private publicationControlOperations(state: DeliveryState, input: ControlInput) {
    const request = state.controls.requests[input.requestId], linkedId = request?.operation_id, linkedDigest = request?.operation_request_digest;
    if (typeof linkedId === "string" || typeof linkedDigest === "string") {
      if (typeof linkedId !== "string" || typeof linkedDigest !== "string") return [];
      return state.operations.filter((operation) => operation.id === linkedId && operation.action === input.action && operation.request_digest === linkedDigest);
    }
    const historical = this.historicalPublicationControlOperations(state, input); if (historical.length) return historical;
    if (input.action === "export_handoff" || input.action === "bind_manual_pr") return this.historicalManualControlOperations(state, input);
    if (input.action !== "publish_plan" && input.action !== "publish_implementation") return [];
    const stage = input.action === "publish_plan" ? "plan" : "implementation", handoff = state.handoffs[stage];
    if (!handoff || input.draftDigest !== handoff.digest) return [];
    const operationId = digest({ action: input.action, repo: state.repo, delivery_id: state.delivery_id, expected: handoff.expected, payload: handoff.payload }).slice(0, 24);
    return state.operations.filter((operation) => operation.id === operationId && operation.action === input.action);
  }

}
