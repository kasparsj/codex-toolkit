export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type Stage = "rank" | "plan" | "implement" | "closeout";
export type ReviewStage = "plan" | "implementation";
export type PublicationMode = "off" | "explicit" | "automatic";
export type DeliveryStatus =
  | "rank_required" | "plan_required" | "plan_review"
  | "implementation_required" | "implementation_review"
  | "publication_pending" | "pre_ready_ci_waiting" | "pre_ready_ci_blocked"
  | "post_ready_ci_waiting" | "post_ready_ci_blocked" | "manual_ready_pending" | "tracking_pending"
  | "review_ready" | "ci_waiting" | "blocked" | "completed" | "cancelled";

export interface PolicySource {
  ref: string;
  sha: string;
  digest: string;
  fetched_at: string;
}

export interface ApprovalPolicy { minimum: number; reviewer_ids: number[] }
export interface DeliveryPolicy {
  version: 1;
  delivery: {
    final_target: string;
    publisher_id: number;
    policy_max_age_seconds?: number;
    require_github_actions?: boolean;
  };
  branches: {
    default_parent: string;
    plan_template: string;
    implementation_template: string;
    allowed_parent_prefixes?: string[];
  };
  eligibility: { required_labels?: string[]; excluded_labels?: string[] };
  tracking?: { review_label?: string };
  approvals: { plan: ApprovalPolicy; implementation: ApprovalPolicy };
  _source: PolicySource;
}

export interface ManifestEnvelope {
  schema_version: 1;
  kind: Stage;
  delivery_id: string;
  repo: string;
  result: Record<string, unknown>;
}

export interface ManifestRecord {
  digest: string;
  material_digest: string;
  generation: number;
  value: ManifestEnvelope;
  accepted_at: string;
  producer_execution_id?: string;
  producer_identity?: string;
}

export interface OperationRecord {
  id: string;
  action: string;
  stage?: string;
  status: "intent" | "accepted" | "completed" | "uncertain" | "failed";
  expected_revision: number;
  request_digest: string;
  request?: JsonObject;
  recorded_at: string;
  completed_at?: string;
  receipt?: JsonObject;
  attestation?: JsonObject;
  attestation_proof_digest?: string;
  error?: string;
  error_code?: string;
}

export interface ExecutionState {
  id: string;
  kind: "agent" | "reviewer";
  stage: string;
  status: "dispatching" | "running" | "completed" | "failed" | "cancelled" | "uncertain";
  provider?: string;
  external_id?: string;
  packet_digest?: string;
  packet?: JsonObject;
  implementer_identity?: string;
  started_at: string;
  finished_at?: string;
  result_digest?: string;
  result?: JsonObject;
  effect?: "none" | "accepted" | "unknown";
  terminal?: "nonterminal" | "completed" | "failed" | "cancelled" | "timeout";
  proof?: { kind: "preflight_refusal" | "run_receipt" | "process_exit" | "archive_ack" | "no_ordinary_run"; reference: string };
  proof_digest?: string;
  outcome_error?: string;
  cancellation?: { epoch: string; status: "intent" | "completed" | "uncertain"; requested_at: string; completed_at?: string };
  review_attempt?: number;
  predecessor_task_id?: string;
  retry_request_id?: string;
}

export interface CancellationIntent {
  epoch: string;
  request_id: string;
  request_digest: string;
  expected_revision: number;
  repository_generation: number;
  phase: "requested" | "reconciling" | "draining" | "complete";
  requested_at: string;
  reconciled_at?: string;
  completed_at?: string;
  outstanding_operation_ids: string[];
  terminal_operation_ids: string[];
}

export interface DeliveryState {
  schema_version: 2;
  repo: string;
  repo_identity: string;
  delivery_id: string;
  issue: number | null;
  status: DeliveryStatus;
  revision: number;
  claim_generation: number;
  claim_token: string;
  claim_status: "active" | "released";
  attempt: number;
  created_at: string;
  updated_at: string;
  policy: PolicySource;
  policy_values: DeliveryPolicy;
  requirements: { plan: number; implementation: number };
  pins: { skills: Record<string, string>; engine: Record<string, string>; locations: Record<string, string>; artifacts: Record<string, string> };
  safeguards: {
    publication: { pr: PublicationMode; issue: PublicationMode };
    allowed_paths: Partial<Record<ReviewStage, string[]>>;
  };
  runner: { status: "idle" | "dispatching" | "running" | "paused" | "failed" | "completed" | "cancelled"; owner_pid: number | null; owner_started_at?: string; current_stage?: string; execution_id?: string };
  manifests: Partial<Record<Stage, ManifestRecord>>;
  receipts: Partial<Record<ReviewStage | "engineering" | "checks", JsonObject>>;
  operations: OperationRecord[];
  executions: ExecutionState[];
  unresolved_effects: string[];
  controls: { paused: boolean; cancelled: boolean; requests: Record<string, JsonObject>; cancellation?: CancellationIntent };
  budget: { max_attempts: number; max_elapsed_seconds: number; max_concurrency: number; attempts_used: number; token_cost: number | null; token_cost_status: "known" | "unknown" };
  history: JsonObject[];
  publication: Record<string, JsonObject>;
  handoffs: Partial<Record<ReviewStage, { expected: JsonObject; payload: JsonObject; digest: string; generation: number; staged_at: string }>>;
  scheduler: { excluded_issue_ids: number[] };
  rank_snapshot?: JsonObject;
}

export interface SafeProjection {
  schema_version: 2;
  repo: string;
  delivery_id: string;
  issue: number | null;
  status: DeliveryStatus;
  revision: number;
  claim_status: "active" | "released";
  attempt: number;
  runner_status: string;
  paused: boolean;
  cancelled: boolean;
  created_at: string;
  updated_at: string;
  evidence_at: string;
  stale: boolean;
  budget: { max_attempts: number; attempts_used: number; max_elapsed_seconds: number; token_cost: number | null; token_cost_status: "known" | "unknown" };
  stages: Record<string, JsonObject>;
  publication: Record<string, JsonObject>;
  unresolved_effects: string[];
}
