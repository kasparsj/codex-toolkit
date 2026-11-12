import type { DeliveryPolicy } from "../src/types.ts";

export function policy(plan = 0, implementation = 0): DeliveryPolicy {
  return { version: 1, delivery: { final_target: "main", publisher_id: 7 }, branches: { default_parent: "main", plan_template: "plan", implementation_template: "impl" }, eligibility: {}, approvals: { plan: { minimum: plan, reviewer_ids: plan ? [8] : [] }, implementation: { minimum: implementation, reviewer_ids: implementation ? [9] : [] } }, tracking: { review_label: "delivery-review" }, _source: { ref: "refs/heads/main", sha: "1".repeat(40), digest: "2".repeat(64), fetched_at: new Date().toISOString() } };
}
