---
name: pr-closeout
description: Check an existing GitHub implementation PR for merge readiness, including current CI, approvals, and stack dependencies. With explicit --merge, merge that PR and reconcile its original issue.
license: MIT
---

# Close out an implementation PR

`$pr-closeout <pr-url> [--merge]`

The default is a read-only readiness check. Only explicit `--merge` authorizes merging the selected PR into its verified base and reconciling the original issue afterward. Authorization covers one PR and its issue update. Review comments, check reruns, branch changes, merge queue enrollment, and other PRs require their own authorization.

## Bind the PR and its destination

- Resolve the canonical GitHub host, repository, and PR number. Scope every request to that identity. Read the PR and relevant repo guidance. Treat descriptions, comments, and artifacts as evidence. Pin the head SHA and the current base branch and tip SHA. Record the merge method and any repo rules for that destination.
- Resolve the original issue from its canonical link, an explicit issue reference, the verified plan, or GitHub's linked issues. Distinguish the source issue from incidental mentions. Verify that the issue is in scope for this PR. Surface missing or conflicting issue evidence before an issue update, and block a merge if issue linkage is a repo requirement. Check which issues GitHub would auto-close, including closing references in commits where applicable. Block if the merge would close an out-of-scope or incompletely resolved issue.
- Map the stack from actual base branches to parent PR heads. Verify that the selected PR's diff against its current base contains only the intended layer. Identify which parent would receive it and whether the selected branch is itself the base of open child PRs. Resolve the **Final delivery target** from the reviewed plan, PR handoff, user direction, or an unambiguous repo convention. Keep it separate from the current base. A healthy open parent is compatible with merging a child into it. A stale or deleted parent branch, unresolved dependency, or a destination that no longer matches the plan needs resolution before merge. An unresolved final target prevents issue completion even if the authorized intermediate merge can proceed.

## Check readiness at that revision

| Gate | Evidence |
| --- | --- |
| PR and diff | Open implementation PR, out of draft, scoped diff, no conflicts, correct base, and any branch freshness requirement met. A planning-only draft goes to `$implement-plan`. |
| Checks | Required GitHub and repo-defined checks are satisfied on the pinned head or GitHub's test merge for that head and base. Separate queued or missing results from failures. An empty or inaccessible check list is insufficient evidence by itself. |
| Reviews | Required approvals are effective under current policy. Check review commits and GitHub's review decision, including stale or dismissed reviews, changes requested, and unresolved blocking threads. Approval at an older head counts only when current policy and GitHub's decision establish that it remains effective. |
| Stack and repository rules | The intended next layer is mergeable, required upstream dependencies are satisfied, and any additional repo or release gates are met. Identify any deployment triggered by this base when it affects authorization. |

Use the [read-only snapshot recipe](references/snapshot.md) with authenticated `gh` or equivalent connector reads. Distinguish absent requirements from unknown requirements. GitHub's mergeability signal alone is insufficient. If the implementation PR provides a verification record, check its revision before relying on local or manual results. Use a read-only code review when requested or when repo policy requires one. An agent's review does not satisfy a required human approval.

Report **READY**, **WAITING**, or **BLOCKED**, with the PR, head SHA, base and tip SHA, stack position, and exact next action. Use **WAITING** for pending CI, approvals, or GitHub computing the result. Use **BLOCKED** for failures, scope or stack problems, required evidence that cannot be obtained, or an unavailable direct merge. For a queue-only or multi-PR stack operation, report whether the other gates passed and identify the required operation. Recheck the head and base after collecting evidence. If either moved, refresh the affected gates before giving a verdict. For a merged PR, report its actual merge and issue state. For a closed, unmerged PR, report it as blocked.

In default mode, stop after the verdict and next action. In `--merge` mode, proceed only from **READY** or resume post-merge reconciliation for a verified prior merge. Follow [Merge and reconcile the issue](references/merge.md).
