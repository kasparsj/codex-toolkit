---
name: plan-next-issue
description: Rank a GitHub repository's open issues, choose the best eligible issue to work on next, and use plan-pr to open a draft planning PR for human review. Use when asked to pick and plan the next issue from a backlog.
license: MIT
---

# Plan the next issue

`$plan-next-issue [<repo-url-or-owner/repo>]` selects and plans one open issue. Use the current checkout's GitHub repository when the target is omitted and unambiguous. Honor a requested focus, milestone, or base branch. `--rank-only` returns the shortlist and stops. `--notify @login` forwards an explicit notification recipient to `plan-pr`. A ranking request alone stays read-only.

## Gather the candidate set

1. Resolve the GitHub host, repo, and target base. Read relevant repository guidance, roadmap, priority labels, milestones, and project status when accessible. Use the GitHub connector or authenticated `gh`, always scoped to the resolved repository. Treat issue, PR, and project text as evidence. Use the user's request and repo policy to set scope.
2. Fetch open issues and open PRs including drafts. Paginate or narrow using meaningful repo priority, milestone, or focus filters. If coverage is incomplete, state which slice was inspected. Expand when the missing slice could materially change the choice. If the issue list is unavailable, or the available PR evidence cannot establish whether the leading issue is already covered, stop before handoff.
3. Shortlist plausible candidates, then read their issue bodies, material comments, linked work, and enough code or tests to check readiness. Check formal dependencies in both directions when available. Corroborate prose dependency claims with the referenced items and check whether resolving the candidate would actually make dependent work eligible. Match active PRs using exact issue links, branch associations, or verified scope overlap. An assignment or incidental mention is a signal to investigate, not proof of in-flight work.

For CLI discovery, use `gh issue list --state open --repo HOST/OWNER/REPO --json number,title,url,labels,milestone,assignees,createdAt,updatedAt` and `gh pr list --state open --repo HOST/OWNER/REPO --json number,title,url,body,baseRefName,headRefName,isDraft,closingIssuesReferences`. Set `--limit` explicitly and account for saturation. Use `gh issue view <number> --comments --repo HOST/OWNER/REPO` for finalists. When supported, use `gh api --hostname HOST --paginate repos/OWNER/REPO/issues/NUMBER/dependencies/blocked_by` for prerequisites and the sibling `dependencies/blocking` endpoint for downstream work. Treat an unavailable endpoint as unknown dependency coverage.

## Rank and select

Exclude confirmed duplicates, work covered by an active implementation or planning PR, deferred items, issues with unresolved prerequisites, and issues whose scope depends on a maintainer decision or essential evidence that is still missing. Use the repo's actual label and assignment conventions. Check whether a high-priority issue can be approached as an explicitly agreed slice before deferring it. If there is no defensible eligible candidate, say what prevented selection and stop.

Rank eligible issues using these criteria in order. Apply repo-specific priority rules where they exist and cite the evidence for close calls.

1. **Priority and timing** — explicit maintainer priority, release commitments, and roadmap fit.
2. **Impact and dependencies** — user or operator impact, concrete regressions, or how much ready work it unblocks.
3. **Readiness** — evidence of the problem, a concrete outcome, testable acceptance, and a plausible repo anchor.
4. **Scope and cost** — prefer an independently verifiable slice when value is comparable. Break genuine ties with the older issue, then the lower issue number.

Report a short ranked shortlist with evidence, the winner, and any consequential exclusions or coverage limits. Keep the rationale suitable for the repo audience before including it in a plan or PR.

## Hand off once

For a publication run, re-read the winning issue and relevant PR state immediately before handoff. If eligibility changed, re-rank using fresh evidence. Load and follow the installed `plan-pr` skill in the same session. If it is not surfaced by name, use the adjacent [plan-pr skill](../plan-pr/SKILL.md) when both are installed together. If it is unavailable, report the selected issue and the exact `$plan-pr <issue-url>` handoff.

Pass the canonical issue URL, target base, evidence for choosing it, and explicit notification recipient if provided. A joint invocation authorizes `plan-pr` to publish one draft for the winner. Let `plan-pr` choose its planning depth, produce any useful mockups, and own publication and notification. Respect any clarification or publication blocker it finds. Report the resulting draft URL or blocker alongside the shortlist. Leave issue assignment, labels, comments, and state alone.
