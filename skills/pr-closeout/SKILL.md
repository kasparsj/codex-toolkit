---
name: pr-closeout
description: Check an existing GitHub implementation PR for merge readiness, including current CI, approvals, and stack dependencies. With explicit --merge, merge that PR and reconcile its original issue.
license: MIT
---

# Close out an implementation PR

`$pr-closeout <pr-url> [--merge]`

The default is a read-only readiness check. Only explicit `--merge` authorizes merging the selected PR into its verified base and reconciling the original issue afterward. Authorization covers one PR and its issue update. Review comments, check reruns, branch changes, merge queue enrollment, and other PRs require their own authorization.

When invoked by the controlled [repository-scoped Delivery workflow](../../docs/paseo-delivery-v2/repository-experience.md), always use the read-only path even if a surrounding request mentions eventual merge. Return a schema-versioned `closeout` manifest with the exact head/base SHAs and check states. Set `status` to the ordinary merge verdict (`READY`, `WAITING`, or `BLOCKED`) and set `delivery_status` independently to the delivery verdict using the same values. `delivery_status` is `READY` when the scoped implementation PR is verified review-ready at the reported head with successful delivery checks and the original issue is correctly linked in the configured review state, even if merge-only approvals, queue requirements, or stack dependencies keep `status` at `WAITING` or `BLOCKED`. Use `delivery_status: WAITING` only for pending delivery checks; use `BLOCKED` for failed checks or other failures of the review-ready delivery contract. Treat unknown evidence as satisfied only when an authoritative repository or GitHub source establishes that the requirement is absent or not applicable. This workflow never merges.

## Bind the PR and its destination

For a controlled-workflow closeout manifest, list required delivery check
states in `checks` using `success`, `pending`, `failure`, or `unknown`. Use the
single value `["no_required_checks"]` when the applicable rules confirm there
are no required delivery checks.

- Resolve the canonical GitHub host, repository, and PR number. Scope every request to that identity. Read the PR and relevant repo guidance. Treat descriptions, comments, and artifacts as evidence. Pin the head SHA and the current base branch and tip SHA. Record the merge method and any repo rules for that destination.
- Resolve the original issue from its canonical link, an explicit issue reference, the verified plan, or GitHub's linked issues. Distinguish the source issue from incidental mentions. Verify that the issue is in scope for this PR. Surface missing or conflicting issue evidence before an issue update, and block a merge if issue linkage is a repo requirement. Check which issues GitHub would auto-close, including closing references in commits where applicable. Block if the merge would close an out-of-scope or incompletely resolved issue.
- Map the stack from actual base branches to parent PR heads. Verify that the selected PR's diff against its current base contains only the intended layer. Identify which parent would receive it and whether the selected branch is itself the base of open child PRs. Resolve the **Final delivery target** from the reviewed plan, PR handoff, user direction, or an unambiguous repo convention. Keep it separate from the current base. A healthy open parent is compatible with merging a child into it. A stale or deleted parent branch, unresolved dependency, or a destination that no longer matches the plan needs resolution before merge. An unresolved final target prevents issue completion even if the authorized intermediate merge can proceed.

## Check readiness at that revision

| Gate | Evidence |
| --- | --- |
| PR and diff | Open implementation PR, out of draft, scoped diff, no conflicts, correct base, and any branch freshness requirement met. A planning-only draft goes to `$implement-plan`. |
| Checks | Required GitHub checks pass on the revision GitHub evaluates. A current test merge with status takes precedence over the pinned head. Verify repo-defined checks against their own revision requirements. Separate queued or missing results from failures. |
| Reviews | Required approvals are effective under current policy. Check review commits and GitHub's review decision, including stale or dismissed reviews, changes requested, and unresolved blocking threads. Approval at an older head counts only when current policy and GitHub's decision establish that it remains effective. |
| Stack and repository rules | The intended next layer is mergeable, required upstream dependencies are satisfied, and any additional repo or release gates are met. A native GitHub stack member at any position is blocked for this direct merge workflow. Check for indirect merges and deletion of branches used by open children. Identify any deployment triggered by this base when it affects authorization. |

Use the [read-only snapshot recipe](references/snapshot.md) with authenticated `gh` or equivalent connector reads. Distinguish absent requirements from unknown requirements. GitHub's mergeability signal alone is insufficient. If the implementation PR provides a verification record, check its revision before relying on local or manual results. Use a read-only code review when requested or when repo policy requires one. An agent's review does not satisfy a required human approval.

Report **READY**, **WAITING**, or **BLOCKED**, with the PR, head SHA, base and tip SHA, stack position, and exact next action. Use **WAITING** for pending CI, approvals, or GitHub computing the result. Use **BLOCKED** for failures, scope or stack problems, required evidence that cannot be obtained, or an unavailable direct merge. For a queue-only or native stack operation, report whether the other gates passed and identify the required operation. Recheck the head and base after collecting evidence. If either moved, refresh the affected gates before giving a verdict. For a merged PR, report its actual merge and issue state. For a closed, unmerged PR, report it as blocked.

In default mode, stop after the verdict and next action. In `--merge` mode, proceed only from **READY** or resume post-merge reconciliation for a verified prior merge. Follow [Merge and reconcile the issue](references/merge.md).
