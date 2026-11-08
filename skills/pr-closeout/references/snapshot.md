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

Read the check output and CLI outcome. Pending checks can return a nonzero exit. Distinguish missing required checks, queued or running checks, failing checks, and optional failures. Confirm what is required using the applicable branch rulesets, classic branch protection, and repo policy. With REST, use `GET /repos/{owner}/{repo}/rules/branches/{branch}` and the branch protection endpoint as applicable, URL-encoding the branch segment. Permission or feature errors leave the affected requirements unknown. When check identity is unclear, verify it against check runs or commit statuses on the pinned head, or against a verified GitHub test merge for that head and base. A passing result for an older revision is historical evidence. [GitHub branch rules](https://docs.github.com/en/rest/repos/rules#get-rules-for-a-branch) · [Branch protection](https://docs.github.com/en/rest/branches/branch-protection#get-branch-protection)

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

When native stack membership is reported, enumerate the relevant entries with pagination to determine the affected layers. A successful null result indicates no native membership. If the fields are unavailable, record that limitation. Confirm ordinary branch-based parents and children from live PR heads and bases, including repository identity for fork branches. When the available evidence cannot establish a one-PR merge, withhold readiness for `--merge`. [GitHub stack fields](https://docs.github.com/en/graphql/reference/pulls#pullrequest)

Re-read the PR head, base branch and its tip after collecting evidence and again at the merge gate. If a revision changed or a page failed, refresh affected reads before using the snapshot. Include the pinned revisions, required and optional check outcomes, review blockers, stack relationship, final delivery target, and evidence gaps in the verdict.
