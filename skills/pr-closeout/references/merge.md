# Merge and reconcile the issue

Use only with explicit `--merge`. Bind the merge and subsequent issue writes to the verified repository and exact PR or issue identity.

## Merge one verified PR

1. Immediately before submitting, re-read the PR state, head SHA, base ref and tip SHA, stack relationship, effective review decision, required check evidence, and any auto-close effects. If the head or base moved, repeat readiness for the new revision. If the diff materially changed, the base branch name changed, or the intended destination changed, resolve the changed merge scope before submitting. Respect repository protections and any separately required release or deployment authorization.
2. Confirm the operation will merge only the selected PR. If the base requires a merge queue or auto-merge, report the required action and stop. Every native GitHub stack member requires the asynchronous stack API, including the bottom PR. Report that operation and stop. An ordinary branch-based child targeting an open parent's head can use the direct merge. Recheck the [effects on other PRs](snapshot.md#effects-on-other-prs) for the selected method and preserve any branch serving as an open child's base. [GitHub stacked merge API](https://docs.github.com/en/pull-requests/reference/stacked-pull-requests-apis-and-webhooks#merge-api)
3. Use the repo's permitted merge method and a server-side expected-head guard. For a direct merge, GitHub's REST endpoint is `PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge` with `sha` set to the verified head and `merge_method` set explicitly. Bind the host when using `gh api --hostname`. An equivalent guarded direct merge is acceptable. The head guard does not lock the base, so verify the destination immediately before and after merging and let GitHub enforce branch protections. Bypassing checks, retargeting, restacking, deleting branches, and pushing directly are outside this operation. [GitHub direct merge API](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request)
4. Read back the PR's merged state, actual base, merge commit or result SHA, and its presence on the intended destination. Squash and rebase change commit identities. Verify the merge result instead of requiring the original head to be an ancestor. Confirm any recorded dependent branch still exists and each recorded child is still open against its original base repository and ref. If the merge call has an ambiguous result, reconcile the PR and destination before retrying. Report unexpected changes to the destination or affected PRs, or any result that cannot be verified, and withhold completion updates.

## Reconcile the original issue

Update issue tracking only after verifying the merge result. Compare the actual merge destination and retained fix to the recorded final delivery target. If the target is unresolved or conflicting, report the missing decision and withhold completion updates. Check the issue first in case automation has already made the correct change. Apply the repository's documented project or label mapping and preserve unrelated labels and assignment.

| Verified outcome | Issue handling |
| --- | --- |
| Child merged into an open parent, or change has reached an intermediate branch | Keep the issue open. Record the layer merge using an existing intermediate status or label if the repo defines one. Otherwise retain its review status and report the remaining delivery PR or branch. |
| Final intended destination contains the complete fix | Verify any auto-close or project transition. Apply the repo's existing completion status or label if still needed. Manually close the issue only when the repo's closeout policy or the user explicitly calls for it and the full resolution is verified. |
| Merge covers only part of the issue, or delivery remains uncertain | Keep the issue open and report remaining scope or missing evidence. |
| Original issue is missing or ambiguous, or no applicable tracking convention is available | Report the tracking gap. Confirm the issue and mapping before making any tracking write. |

A preview branch can be the final destination if the plan and repo policy establish that. When closing out a parent, count delivery from a child only when the issue is explicitly in scope and the merged result still contains its fix. A prior layer merge or closing keyword alone does not prove delivery. [GitHub's issue-linking rules](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue)

Verify the final issue state, status, or label. Report unexpected automation or a preexisting closed state and leave reopening to a separately authorized action. Report the PR and merge SHA, actual destination, any remaining stack layer, and the observed issue outcome. If merge succeeded but tracking failed, report the exact pending update. On retry, verify the existing merge and resume that update.
