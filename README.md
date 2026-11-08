# Codex Toolkit

Reusable Codex skills and executable workflows.

## Install

Use Node.js 22.20 or later to install all skills in this repository for Codex.

```bash
npx skills add kasparsj/codex-toolkit --skill '*' -a codex -g
```

Omit `-g` to install for the current project. [Skills CLI reference](https://github.com/vercel-labs/skills/blob/main/docs/commands.md#skills-add)

## Handoff

`$handoff` turns an implementation request into a brief, dispatches one fresh Codex executor, and brings the result back to the parent chat for verification. It requires Codex with native subagent support.

In a Codex chat, invoke the skill with a task you want to delegate.

> $handoff Implement the agreed CSV export change in a fresh executor. Preserve the existing export format and verify the export tests.

[Read the skill](skills/handoff/SKILL.md)

## Fresh handoff

Run `$fresh-handoff` in the Codex desktop chat you want to leave. It derives the next task from that chat and starts a new chat with a short brief as its first message.

Add a focus if the source chat covers several tasks.

> $fresh-handoff Fix the CSV export regression we agreed on.

You can also supply a chat link or ID to hand off work from a different chat.

[Read the skill](skills/fresh-handoff/SKILL.md)

## Client feedback triage

`$client-feedback-triage` checks client feedback against the codebase and existing GitHub work, then prepares a change set for review.

> $client-feedback-triage Triage the feedback below against the current repository and draft the proposed GitHub changes for review.

[Read the skill](skills/client-feedback-triage/SKILL.md)

## Plan PR

`$plan-pr` plans a selected GitHub issue and opens a draft planning PR with verification steps and JPEG mockups when useful. It chooses the planning depth based on the issue's scope, uncertainty, and risk.

> $plan-pr https://github.com/owner/repo/issues/42

Use `--local` to keep the plan in the checkout. [Read the skill](skills/plan-pr/SKILL.md)

## Implement an existing plan

`$implement-plan` executes an agreed plan using a workflow sized to the work. It opens an implementation PR or converts the planning draft, links the original issue, and updates its review status or label after verifying publication.

> $implement-plan https://github.com/owner/repo/pull/43

You can also pass a local plan path. Use `--base <branch-or-pr>` to target a specific branch or stack, or `--local` to implement without publishing. [Read the skill](skills/implement-plan/SKILL.md)

## PR closeout

`$pr-closeout` checks CI, approvals, and stack readiness for an existing implementation PR. Add `--merge` to merge the verified PR into its current base and reconcile the original issue.

> $pr-closeout https://github.com/owner/repo/pull/43

[Read the skill](skills/pr-closeout/SKILL.md)

## Choose the next issue

`$next-issue` ranks the open issues in a GitHub repository and selects the best eligible candidate.

- `$next-issue owner/repo --rank` reports the shortlist and winner. Ranking is the default when you omit the mode.
- `$next-issue owner/repo --review` runs ECC's `issue-review` on the winner and stops after the review. [ECC skill source](https://github.com/affaan-m/ecc/blob/main/skills/issue-review/SKILL.md)
- `$next-issue owner/repo --plan` uses `plan-pr` to open a draft planning PR for the winner.

Install ECC's `issue-review` separately to use `--review`:

```bash
npx skills add affaan-m/ecc --skill issue-review -a codex -g
```

[Read the skill](skills/next-issue/SKILL.md)

## Controlled GitHub delivery

The reusable [GitHub delivery workflow](workflows/github-delivery/README.md) runs `next-issue`, `plan-pr`, `implement-plan`, and read-only `pr-closeout` under one resumable repository policy. It pins Spec Kit v1.3.2, supports independent review gates, and publishes through an isolated GitHub.com launcher that verifies candidate bundles in a trusted Git repository.
