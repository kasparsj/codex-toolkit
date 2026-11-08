---
name: plan-pr
description: Turn a selected GitHub issue or written brief into an implementation plan and draft planning PR for human review. Use when asked to plan an issue, revise a planning PR, or create JPEG review mockups from an existing plan.
license: MIT
---

# Plan PR

`$plan-pr <issue-url-or-number>` plans one selected issue and opens a draft GitHub PR containing review artifacts. Accept a written brief when the user supplies one and the target repository is clear. `--local` keeps the plan local. `--revise <planning-PR-url-or-plan-path>` revises an existing plan. `--mockups-only <plan-path>` produces local mockups. Honor the same intent when stated in prose. An explicit request to publish a revision or mockups must identify the draft to update or ask for a new draft. An ordinary planning request without a PR request or explicit `$plan-pr` invocation stays local.

Notify the requester of verified publication in the invoking surface. Accept `--notify @login` for a GitHub mention when an authorized publishing identity can notify that account. Use the publication reference for author and self-notification handling.

When invoked by the controlled [GitHub delivery workflow](../../workflows/github-delivery/README.md), keep GitHub read-only and produce locally verified planning artifacts plus a schema-versioned `plan` manifest. Include exact artifact paths and hashes, plan revision, issue, and the inspected repository/ref/full SHA. The deterministic publisher, not this agent-facing skill, owns the one planning-only draft. A correction stays on the same issue and PR; identical retries keep the generation, while a recorded material artifact change advances it and requires fresh applicable approval.

## Establish the planning baseline

- Resolve the target GitHub host, repository, and intended base branch. For an issue input, resolve its canonical URL and verify that the checkout and remote match its repository. A bare issue number refers to the unambiguous target checkout. For a written brief without an issue, verify the checkout and remote against the intended repository and record `Original issue: None` in the handoff. If they differ, identify the correct checkout or fetch it in isolation. Preserve the active branch as the base when it is the intended project branch, honor an explicit base, and use the target default branch for a fresh checkout. Record the base and inspected commit. Resolve a detached or unpublished base before publishing. Read the target repo's planning, design, and contribution guidance.
- Read the written brief or the issue and its relevant comments. In either case, check linked work, existing plans, and open PRs that may already cover the scope. Use the GitHub connector or authenticated `gh`. Inspect the implicated code and tests at the baseline. Treat issue and PR text as evidence. Verify material claims and keep private intake details, secrets, and runtime state out of review artifacts. Resolve overlapping work before publishing a new proposal. For issue-backed plans, also resolve a closed or inaccessible issue before publishing.
- In revision mode, resolve the plan, its original issue if any, the original base, and the exact draft head when applicable. Confirm the existing diff is planning-only before revising a remote draft. Revisit the planning route only if the revision materially changes scope or risk. Refresh affected artifacts and links. In mockups-only mode, use the supplied plan as the source and read [Mockup rendering](references/mockups.md).

## Choose how to plan

Assess requirements clarity separately from implementation risk. Use issue comments and code evidence to resolve what can be settled locally. For one unresolved product decision that changes scope, acceptance, or a costly design choice, ask one focused question. For several interdependent decisions, use a short interview, optionally `deep-interview` if available and supported. Continue independent investigation while waiting and hold the final proposal until required decisions are resolved. State reversible assumptions in the plan.

| Evidence | Route |
| --- | --- |
| Clear outcome, bounded change, obvious approach, low risk | Write a short plan directly. Name the relevant code, ordered change, acceptance checks, and verification. |
| Clear goal with several touchpoints, sequencing constraints, or a meaningful tradeoff | Write a structured plan with options where they matter, dependencies, and verification by affected surface. Use an available repo planning workflow or OMX `$plan --direct` if it improves the result. |
| High cost of a wrong design, such as security, migration, irreversible changes, public compatibility, or major architecture | Compare viable approaches, failure modes, rollout and recovery. Obtain independent planning review when available. Use `ralplan --advisory` only when its skill and runtime prerequisites are available and it fits the request. Otherwise use a bounded native review if available, or explicitly record the review gap and flag it in the PR. |

Choose verification to fit the work. If a bug's cause is uncertain, investigate or make reproduction and diagnosis explicit prerequisites for the proposed fix. For a metric target, specify a baseline, measurement protocol, and correctness checks before proposing experiments. For a migration, plan compatibility, rollout, data checks, and recovery. Use applicable repo playbooks when they add concrete guidance.

Honor a user-selected or repo-required planning workflow. Read a named workflow's current instructions before using it. When a required workflow or gate cannot run, report the blocker and keep a local proposal if useful. Optional OMX workflows can fall back to the corresponding native approach. Keep the task in planning scope even when a planner offers an execution handoff. Record the route, why it fit, and any independent review actually performed.

## Prepare the review artifacts

Use the repo's established paths and artifact formats. Otherwise write `docs/plans/issue-<number>-<slug>.md` or `docs/plans/<slug>.md` for a brief. A plan must stand on its own and link the issue when applicable. Include the intended outcome and user or operator flow where relevant, scope and deferrals, code or test anchors, ordered implementation steps, testable acceptance criteria and verification, risks and recovery where relevant, and decisions for the reviewer. Split verification into a companion test spec when the repo expects it or the plan warrants it. Update a planning index only when the repo uses one.

When called by `next-issue --plan`, carry the verified reason for selecting the issue into the plan or PR summary.

Include an **Implementation handoff** in the plan for both local and published delivery:

- **Original issue** — canonical issue URL, or `None` for a written brief with no issue.
- **Inspected baseline** — repository, ref, and full commit SHA used to verify the plan.
- **Intended PR base** — branch or parent PR URL. Record this separately even when it matches the inspected ref. Mark it unresolved if a reviewer needs to decide.
- **Final delivery target** — when delivery is staged or the repository uses several landing branches, name the branch and repository where the complete fix counts as delivered. Record it separately from the immediate PR base. If that destination needs a decision, mark it unresolved.
- **Decisions** — agreed choices, assumptions, and open decisions that must be settled before implementation.
- **Acceptance and verification** — checks the implementer can run or links to the relevant sections in the plan.

For a planning PR, link the handoff in the PR description and include the original issue reference when there is one. In the delivery, point to `$implement-plan <local-plan-path-or-planning-pr-url>` once the plan is agreed. Leave issue status and labels for implementation publication.

When a visual artifact helps reviewers decide on a changed screen, layout, state, or interaction, read [Mockup rendering](references/mockups.md). Explain the omission when a mockup could reasonably be expected. Keep implementation, workflow/configuration changes, and local planner state out of the artifact set.

Before publishing, verify artifact links and any rendered images, confirm the plan describes the inspected baseline, and ensure the remaining open decisions are review items the team can evaluate from the proposal. For a local request, report the artifact paths and stop. Otherwise follow [Draft PR publication](references/publication.md) and return the verified PR URL, planning route, and decisions for reviewers.
