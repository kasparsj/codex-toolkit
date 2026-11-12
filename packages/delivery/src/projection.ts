import { utcNow } from "./core.ts";
import type { DeliveryState, JsonObject, SafeProjection } from "./types.ts";
import { reviewBody, reviewContext } from "./reviews.ts";

const URL_KEYS = new Set(["url", "html_url"]);
function publicRecord(value: JsonObject): JsonObject {
  const allowed = new Set(["number", "head_sha", "base_sha", "draft", "state", "status", "conclusion", "name", "summary", "created_at", "updated_at", "url", "html_url", "generation", "approved", "approvers", "rejectors", "minimum"]);
  const result = Object.fromEntries(Object.entries(value).filter(([key, item]) => allowed.has(key) && (typeof item !== "string" || item.length <= 2048) && (!URL_KEYS.has(key) || /^https:\/\//.test(item as string)))) as JsonObject;
  if (value.pr && typeof value.pr === "object" && !Array.isArray(value.pr)) result.pr = publicRecord(value.pr as JsonObject);
  if (value.ci && typeof value.ci === "object" && !Array.isArray(value.ci)) result.ci = publicRecord(value.ci as JsonObject);
  return result;
}
export function safeProjection(state: DeliveryState, now = new Date()): SafeProjection {
  const stale = now.getTime() - Date.parse(state.updated_at) > 5 * 60_000;
  const stages: Record<string, JsonObject> = {};
  for (const [kind, record] of Object.entries(state.manifests)) if (record) stages[kind] = { generation: record.generation, digest: record.digest, material_digest: record.material_digest, accepted_at: record.accepted_at };
  const publication = Object.fromEntries(Object.entries(state.publication).map(([key, value]) => [key, publicRecord(value)]));
  return {
    schema_version: 2, repo: state.repo, delivery_id: state.delivery_id, issue: state.issue,
    status: state.status, revision: state.revision, claim_status: state.claim_status,
    attempt: state.attempt, runner_status: state.runner.status, paused: state.controls.paused,
    cancelled: state.controls.cancelled, created_at: state.created_at, updated_at: state.updated_at,
    evidence_at: state.updated_at, stale,
    budget: { max_attempts: state.budget.max_attempts, attempts_used: state.budget.attempts_used, max_elapsed_seconds: state.budget.max_elapsed_seconds, token_cost: state.budget.token_cost, token_cost_status: state.budget.token_cost_status },
    stages, publication, unresolved_effects: [...state.unresolved_effects],
  };
}

function availableActions(state: DeliveryState): string[] {
  if (state.controls.cancelled || state.claim_status === "released" || ["review_ready", "completed", "cancelled"].includes(state.status)) return [];
  const result: string[] = state.controls.paused ? ["resume"] : ["pause", "cancel"];
  if (state.runner.status === "failed") result.push("recover");
  if (reviewPreflightRefusal(state) && state.claim_status === "active" && !state.controls.paused && !state.controls.cancellation
    && state.unresolved_effects.length === 0 && !state.executions.some((item) => item.kind === "reviewer" && ["dispatching", "running", "uncertain"].includes(item.status))) result.push("retry_review");
  if (state.runner.status === "idle" && state.status === "plan_review" && state.handoffs.plan && !state.publication.plan) result.push("publish_plan");
  if (state.runner.status === "idle" && state.status === "implementation_review" && state.handoffs.implementation && state.receipts.engineering && !state.publication.implementation) result.push("publish_implementation");
  if (state.status === "plan_review" || state.status === "implementation_review") result.push("correct");
  if (["publication_pending", "pre_ready_ci_waiting", "manual_ready_pending", "post_ready_ci_waiting", "tracking_pending"].includes(state.status)) result.push("recheck_ready");
  return result;
}

function reviewPreflightRefusal(state: DeliveryState): boolean {
  const execution = [...state.executions].reverse().find((item) => item.kind === "reviewer" && item.stage === "engineering_review");
  return state.status === "blocked" && execution?.status === "failed" && execution.effect === "none" && execution.terminal === "failed"
    && execution.proof?.kind === "preflight_refusal" && typeof execution.proof_digest === "string" && /^[0-9a-f]{64}$/.test(execution.proof_digest)
    && typeof execution.outcome_error === "string" && execution.outcome_error.length > 0
    && (execution.review_attempt ?? 0) + 1 < state.budget.max_attempts;
}

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function sha(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const point = object(value);
  return typeof point?.sha === "string" ? point.sha : undefined;
}

function publicationIdentity(value: JsonObject | undefined): JsonObject | undefined {
  return object(value?.pr) ?? value;
}
function checkStatus(value: unknown): string {
  const status = String(value ?? "unknown").toLowerCase();
  if (["success", "successful", "passed", "completed"].includes(status)) return "completed";
  if (["queued", "in_progress", "pending", "waiting"].includes(status)) return "waiting";
  if (["failure", "failed", "error", "cancelled", "timed_out"].includes(status)) return "failed";
  return "unknown";
}

function activeReviewStage(state: DeliveryState): "plan" | "implementation" | undefined {
  if (state.status === "plan_review") return "plan";
  if (state.status === "implementation_review") return "implementation";
  if (state.receipts.implementation || state.publication.implementation) return "implementation";
  if (state.receipts.plan || state.publication.plan) return "plan";
  return undefined;
}

export function dashboardProjection(state: DeliveryState, now = new Date()): Record<string, unknown> {
  const safe = safeProjection(state, now);
  const displayStatus = state.controls.cancelled ? "cancelled" : state.status === "blocked" ? "blocked" : state.runner.status === "failed" ? "failed" : state.status === "review_ready" || state.status === "completed" ? "completed" : state.runner.status === "running" || state.runner.status === "dispatching" ? "running" : state.controls.paused || state.status.includes("review") || state.status.includes("waiting") || state.status.includes("pending") ? "waiting" : "pending";
  const stages = ["rank", "plan", "implementation", "verification", "publication"].map((id) => {
    const record = id === "implementation" ? state.manifests.implement : state.manifests[id as "rank" | "plan"];
    const complete = id === "verification" ? Boolean(state.receipts.engineering) : id === "publication" ? ["review_ready", "completed"].includes(state.status) : Boolean(record);
    const current = id === "verification" ? state.status === "publication_pending" && !state.receipts.engineering : id === "publication" ? ["publication_pending", "pre_ready_ci_waiting", "manual_ready_pending", "post_ready_ci_waiting", "tracking_pending"].includes(state.status) && Boolean(state.receipts.engineering) : state.status.includes(id === "implementation" ? "implementation" : id);
    return { id, label: id[0]!.toUpperCase() + id.slice(1), status: complete ? "completed" : current ? (displayStatus === "waiting" ? "waiting" : "running") : "pending", ...(record ? { summary: `generation ${record.generation}`, attempts: record.generation } : {}) };
  });
  const piNoOrdinaryRun = state.status === "blocked" && state.executions.some((execution) => execution.provider === "pi" && execution.effect === "unknown" && execution.terminal === "failed"
    && execution.proof?.kind === "no_ordinary_run" && typeof execution.proof_digest === "string" && /^[0-9a-f]{64}$/.test(execution.proof_digest) && state.unresolved_effects.includes(execution.id));
  const blockers = reviewPreflightRefusal(state)
    ? [{ code: "REVIEW_PREFLIGHT_REFUSED", message: "Reviewer could not start. No review work began." }]
    : piNoOrdinaryRun ? [{ code: "PI_NO_ORDINARY_RUN", message: "Pi did not start an ordinary run. Effects after input submission are unknown; inspect them before explicit recovery." }]
    : state.status === "blocked" || state.runner.status === "failed" ? [{ code: "DELIVERY_BLOCKED", message: "Inspect the local run evidence and continue explicitly." }] : [];
  const history = state.history.slice(-100).map((entry) => ({ revision: entry.revision, at: entry.at, event: entry.event, ...(entry.summary ? { summary: entry.summary } : {}) }));
  const planResult = state.manifests.plan?.value.result;
  const implementationResult = state.manifests.implement?.value.result;
  const sourceRevision = sha(planResult?.baseline) ?? sha(implementationResult?.base);
  const currentRevision = implementationResult?.candidate_sha ?? planResult?.plan_revision ?? sourceRevision;
  const reviewStage = activeReviewStage(state);
  const receipt = reviewStage ? state.receipts[reviewStage] : undefined;
  const handoff = reviewStage ? state.handoffs[reviewStage] : undefined;
  const published = reviewStage ? publicationIdentity(state.publication[reviewStage]) : undefined;
  const activePublication = published ?? publicationIdentity(state.publication.implementation);
  const prUrl = typeof activePublication?.html_url === "string" ? activePublication.html_url : typeof activePublication?.url === "string" ? activePublication.url : undefined;
  const issueUrl = state.issue ? `https://github.com/${state.repo}/issues/${state.issue}` : undefined;
  const reviewReceipts = receipt ? [...((receipt.approvers as number[] | undefined) ?? []).map((id) => ({ login: `id:${id}`, state: "approved", commitId: receipt.commit_id })), ...((receipt.rejectors as number[] | undefined) ?? []).map((id) => ({ login: `id:${id}`, state: "rejected", commitId: receipt.commit_id }))] : [];
  const evidence = Object.entries(state.manifests).flatMap(([id, record]) => record ? [{ id: record.digest, kind: "manifest", label: `${id} manifest`, summary: `generation ${record.generation}`, createdAt: record.accepted_at }] : []);
  const reviewManifest = reviewStage ? state.manifests[reviewStage === "plan" ? "plan" : "implement"] : undefined;
  const reviewResult = reviewManifest?.value.result, reviewPoint = reviewResult?.[reviewStage === "plan" ? "baseline" : "base"] as JsonObject | undefined;
  const reviewDigest = reviewStage && reviewManifest && reviewPoint && state.issue ? reviewContext({ stage: reviewStage, generation: reviewManifest.generation, issue: state.issue, material_hashes: { manifest: reviewManifest.material_digest }, baseline_sha: reviewPoint.sha as string, base_repo: reviewPoint.repo as string, base_ref: reviewPoint.ref as string, base_sha: reviewPoint.sha as string, final_repo: state.repo, final_ref: state.policy_values.delivery.final_target, policy_digest: state.policy.digest }) : undefined;
  const review = published && handoff && reviewStage && reviewManifest && reviewDigest ? {
    fresh: published.head_sha === handoff.expected.head_sha && published.base_sha === handoff.expected.base_sha,
    ...(typeof published.head_sha === "string" ? { headSha: published.head_sha } : {}),
    ...(typeof published.base_sha === "string" ? { baseSha: published.base_sha } : {}),
    instructions: [`Approve with this exact review body: ${reviewBody(reviewStage, reviewManifest.generation, reviewDigest, "approve")}`, `Reject with this exact review body: ${reviewBody(reviewStage, reviewManifest.generation, reviewDigest, "reject")}`], receipts: reviewReceipts,
  } : undefined;
  const draftStage = state.status === "plan_review" && state.handoffs.plan ? "plan" : state.handoffs.implementation ? "implementation" : state.handoffs.plan ? "plan" : undefined;
  const draftHandoff = draftStage ? state.handoffs[draftStage] : undefined;
  const draft = draftStage && draftHandoff ? {
    kind: draftStage === "plan" ? "plan_pr" : "implementation_pr",
    id: `${state.delivery_id}:${draftStage}`,
    digest: draftHandoff.digest,
    status: state.publication[draftStage] ? "published" : "staged",
    ...(typeof draftHandoff.payload.title === "string" ? { title: draftHandoff.payload.title } : {}),
    bodyAvailableInCli: true,
    publicationMode: state.safeguards.publication.pr,
  } : undefined;
  const finalCi = object(state.publication.final?.ci);
  const localChecks: JsonObject[] = [];
  const candidateChecks = object(state.receipts.checks), implementation = state.manifests.implement;
  if (candidateChecks) {
    const exact = implementation && typeof candidateChecks.candidate_sha === "string" && /^[0-9a-f]{40}$/.test(candidateChecks.candidate_sha)
      && candidateChecks.candidate_sha === implementation.value.result.candidate_sha && candidateChecks.manifest_digest === implementation.digest;
    localChecks.push({ name: "Configured candidate checks", status: exact ? checkStatus(candidateChecks.status) : "stale",
      summary: exact ? `Exact candidate ${candidateChecks.candidate_sha}` : "Checks do not match the current candidate." });
  }
  if (state.receipts.engineering) localChecks.push({ name: "Independent engineering review", status: "completed" });
  const actionsChecks = finalCi ? [{ name: typeof finalCi.name === "string" ? finalCi.name : "GitHub Actions", status: checkStatus(finalCi.conclusion ?? finalCi.status), ...(typeof finalCi.summary === "string" ? { summary: finalCi.summary } : {}), ...(typeof finalCi.html_url === "string" ? { url: finalCi.html_url } : typeof finalCi.url === "string" ? { url: finalCi.url } : {}) }] : [];
  return {
    schemaVersion: 2, generatedAt: utcNow(), repositories: [{ id: state.repo, label: state.repo }],
    runs: [{
      repo: state.repo, deliveryId: state.delivery_id, status: displayStatus, workflowStatus: state.status, revision: state.revision,
      sourceRevision, currentRevision, updatedAt: state.updated_at, stale: false, evidenceAt: safe.evidence_at, evidenceStale: safe.stale,
      ...(prUrl ? { prUrl } : {}), ...(issueUrl ? { issueUrl } : {}),
      objective: state.issue ? `Deliver issue #${state.issue}` : "Select the next eligible issue",
      selectedStage: state.status, stages, blockers,
      ...(review ? { review } : {}), ...(draft ? { draft } : {}),
      checks: { local: localChecks, actions: actionsChecks }, evidence, history, availableActions: availableActions(state),
      ...(state.status === "review_ready" || state.status === "completed" ? { finalReport: "Reviewed pull request is ready for human delivery." } : {}),
      unresolvedEffects: safe.unresolved_effects,
    }],
  };
}
