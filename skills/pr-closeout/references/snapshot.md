# Read-only closeout snapshot

Use the PR URL to resolve and verify `host`, `owner`, `repo`, and `number`. Use those values in the reads below. This recipe works without checking out the PR. Equivalent GitHub connector reads are fine.

## Revisions and checks

```bash
gh pr view "$number" --repo "$host/$owner/$repo" \
  --json url,state,isDraft,baseRefName,headRefName,headRefOid,mergeable,mergeStateStatus,reviewDecision,mergeCommit,closingIssuesReferences
```

Set `base` to the returned base branch. Resolve its current tip independently, even when the PR summary includes a base SHA.

```bash
gh api graphql --hostname "$host" -f owner="$owner" -f repo="$repo" \
  -f ref="refs/heads/$base" -f query='
  query($owner: String!, $repo: String!, $ref: String!) {
    repository(owner: $owner, name: $repo) {
      ref(qualifiedName: $ref) { name target { oid } }
    }
  }'
```

```bash
gh pr checks "$number" --repo "$host/$owner/$repo" --required --json name,workflow,bucket,state,link
```

```bash
gh pr checks "$number" --repo "$host/$owner/$repo" --json name,workflow,bucket,state,link
```

Read the check output and CLI outcome. Pending checks can return a nonzero exit. Distinguish missing required checks, queued or running checks, failing checks, and optional failures. Confirm what is required using the applicable branch rulesets, classic branch protection, and repo policy. With REST, use `GET /repos/{owner}/{repo}/rules/branches/{branch}` and the branch protection endpoint as applicable, URL-encoding the branch segment. Permission or feature errors leave the affected requirements unknown. An empty or inaccessible check list alone cannot establish that no checks are required. [GitHub branch rules](https://docs.github.com/en/rest/repos/rules#get-rules-for-a-branch) · [Branch protection](https://docs.github.com/en/rest/branches/branch-protection#get-branch-protection)

When GitHub requires status checks, identify the revision it evaluates. Read the PR checks box if available and use the test merge OID and its parents to bind the evidence to the pinned head and base.

```bash
gh api graphql --hostname "$host" -f owner="$owner" -f repo="$repo" \
  -F number="$number" -f query='
  query($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        headRefOid
        potentialMergeCommit { oid parents(first: 2) { nodes { oid } } }
      }
    }
  }'
```

Verify that the test merge parents match the pinned base tip and head. Use SHA-scoped check runs and commit statuses if the CLI output leaves the revision or source unclear. When the current test merge has a status, evaluate required checks there. A green head cannot satisfy a failed, pending, or missing required result on the test merge. Use the head only when evidence establishes that GitHub is evaluating the head, such as a current test merge with no status. A null test merge while GitHub is computing mergeability, a stale test merge, or an inaccessible status read does not establish that fallback. Refresh pending computation and block if the applicable revision or required evidence remains unknown. If a required name exists as both a check run and a legacy status, require both to pass. Honor any configured source app. [GitHub’s status precedence](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks#conflicts-between-head-commit-and-test-merge-commit)

## Reviews and stack membership

Read review threads with pagination. Flat PR comments cannot establish which threads are resolved. The snapshot needs thread IDs and state. Fetch thread content only when needed to decide whether an unresolved thread blocks the merge.

```bash
gh api graphql --hostname "$host" --paginate --slurp -f owner="$owner" -f repo="$repo" \
  -F number="$number" -f query='
  query($owner: String!, $repo: String!, $number: Int!, $endCursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        headRefOid
        reviewThreads(first: 100, after: $endCursor) {
          nodes { id isResolved isOutdated }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }'
```

Check all returned pages and require the same pinned head throughout. An outdated thread can still be unresolved. Read review submissions and their commit OIDs when needed to confirm effective approvals. Apply repo rules for mandatory conversation resolution. [GitHub review fields](https://docs.github.com/en/graphql/reference/pulls#pullrequest) · [CLI pagination](https://cli.github.com/manual/gh_api)

Query native stack membership separately so a server without these fields can still return review threads.

```bash
gh api graphql --hostname "$host" -f owner="$owner" -f repo="$repo" \
  -F number="$number" -f query='
  query($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        headRefOid
        stack { number baseRefName size }
        stackEntry { position }
      }
    }
  }'
```

An error-free result with both fields null indicates no native membership. If the fields are unavailable, use the REST PR `stack` object on a host that supports it or establish that the host does not support native stacks. Otherwise membership is unknown. Any confirmed native membership blocks this direct merge workflow, including position one. Report the position and required asynchronous stack operation. Confirm ordinary branch-based parents and children from live PR heads and bases, matching repository identity as well as branch name. [GitHub stack APIs](https://docs.github.com/en/pull-requests/reference/stacked-pull-requests-apis-and-webhooks)

## Effects on other PRs

- For a merge commit, paginate open PRs targeting the same destination ref in the same repository. Exclude the selected PR and check each candidate's head SHA. A head reachable from the selected head but not already reachable from the pinned base tip would become reachable through this merge, even if the other PR uses a different branch name. Use `git merge-base --is-ancestor` or a SHA comparison API to establish ancestry. Block if another PR could be indirectly merged or if the required reads are inconclusive. Squash and rebase generate new commits, so the selected head's existing ancestry alone does not predict that effect for those methods. [GitHub indirect merges](https://docs.github.com/en/pull-requests/reference/pull-request-merges#indirect-merges)
- Include references that could close another PR in the auto-close audit. Resolve the referenced object, and account for closing text in the PR description and the commit messages that the chosen merge method would land, including any generated message. Block if another PR would close. [GitHub closing keywords](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue#linking-a-pull-request-to-an-issue-using-a-keyword)
- For open children, record their PR identities and current base repository and ref. Check `delete_branch_on_merge` on the selected PR's **head repository**, including forks. For a fork, also check whether the merging actor has write access there. If automatic deletion could apply, require evidence that the dependent branch is protected from deletion for this operation. Block if preservation cannot be established. [GitHub automatic branch deletion](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-the-automatic-deletion-of-branches)

Re-read the PR head, base branch and its tip after collecting evidence and again at the merge gate. If a revision changed or a page failed, refresh affected reads before using the snapshot. Include the pinned revisions, evaluated check SHA, required and optional check outcomes, review blockers, stack relationship, affected PRs, final delivery target, and evidence gaps in the verdict.
