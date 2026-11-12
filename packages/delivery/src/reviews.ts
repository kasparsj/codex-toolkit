import { digest } from "./core.ts";

export function reviewBody(stage: string, generation: number, contextDigest: string, decision: "approve" | "reject"): string {
  return `delivery-review ${stage} ${generation} ${contextDigest} ${decision}`;
}

export interface ReviewContextInput {
  stage: string; generation: number; issue: number; material_hashes: Record<string, string>;
  baseline_sha: string; base_repo: string; base_ref: string; base_sha: string;
  final_repo: string; final_ref: string; policy_digest: string;
}
export function reviewContext(input: ReviewContextInput): string {
  return digest({
    stage: input.stage, generation: input.generation, issue: input.issue,
    material_hashes: input.material_hashes, baseline_sha: input.baseline_sha,
    immediate_base: { repo: input.base_repo, ref: input.base_ref, sha: input.base_sha },
    final_target: { repo: input.final_repo, ref: input.final_ref }, policy_digest: input.policy_digest,
  });
}

export interface EvaluateReviewsInput {
  reviews: Record<string, unknown>[]; stage: string; generation: number; context_digest: string;
  commit_id: string; authorized_ids: number[]; publisher_id: number; minimum: number; require_human?: boolean;
  allow_publisher_review?: boolean;
}
export function evaluateReviews(first: EvaluateReviewsInput | Record<string, unknown>[], second?: Omit<EvaluateReviewsInput, "reviews">): Record<string, unknown> {
  const input: EvaluateReviewsInput = Array.isArray(first) ? { ...second!, reviews: first } : first;
  const expected = new Map([[reviewBody(input.stage, input.generation, input.context_digest, "approve"), "approve"], [reviewBody(input.stage, input.generation, input.context_digest, "reject"), "reject"]]);
  const latest = new Map<number, { submitted: string; id: number; decision: string }>();
  for (const review of input.reviews) {
    const user = review.user as Record<string, unknown> | undefined;
    const rid = user?.id;
    if (typeof rid !== "number" || !input.authorized_ids.includes(rid) || !input.allow_publisher_review && rid === input.publisher_id) continue;
    if (input.require_human && (user?.type !== "User" || review.performed_via_github_app != null)) continue;
    if (review.state !== "COMMENTED" || review.dismissed === true || review.commit_id !== input.commit_id || typeof review.body !== "string" || !expected.has(review.body)) continue;
    if (typeof review.submitted_at !== "string" || typeof review.id !== "number") continue;
    const candidate = { submitted: review.submitted_at, id: review.id, decision: expected.get(review.body)! };
    const prior = latest.get(rid);
    if (!prior || candidate.submitted > prior.submitted || (candidate.submitted === prior.submitted && candidate.id > prior.id)) latest.set(rid, candidate);
  }
  const approvers = [...latest].filter(([, value]) => value.decision === "approve").map(([id]) => id).sort((a, b) => a - b);
  const rejectors = [...latest].filter(([, value]) => value.decision === "reject").map(([id]) => id).sort((a, b) => a - b);
  const result: Record<string, unknown> = { approved: rejectors.length === 0 && approvers.length >= input.minimum, approvers, rejectors, minimum: input.minimum };
  if (input.require_human) result.review_ids = Object.fromEntries([...latest].map(([id, value]) => [String(id), value.id]));
  return result;
}

export function gateRoute(planGate: boolean | undefined, implementationGate: boolean | undefined, options: { planApproved?: boolean; implementationApproved?: boolean } = {}): string {
  if (planGate && !options.planApproved) return "plan_review";
  if (implementationGate && !options.implementationApproved) return "implementation_review";
  return "publication_pending";
}
