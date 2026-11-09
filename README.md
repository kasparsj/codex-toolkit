# Codex Toolkit

Use Codex to audit repositories, triage feedback, take a GitHub issue from selection through PR review, or hand work off to a fresh agent or chat. Invoke individual skills in Codex, or use the separately configured GitHub delivery runner to coordinate the issue-to-PR sequence.

## Install the interactive skills

With Node.js 22.20 or later, install all skills for Codex.

```bash
npx skills add kasparsj/codex-toolkit --skill '*' -a codex -g
```

Omit `-g` for a project-only install. [Skills CLI reference](https://github.com/vercel-labs/skills/blob/main/docs/commands.md#skills-add)

In a Codex chat, replace `owner/repo` with your repository and try `$next-issue owner/repo --rank`. This returns a shortlist and a recommended issue without writing to GitHub.

## Interactive GitHub skills

`next-issue` → `plan-pr` → `implement-plan` → `pr-closeout`

Start at the step you need. The write behavior below applies to the examples shown.

| Skill | Example | Result and GitHub writes |
| --- | --- | --- |
| [`next-issue`](skills/next-issue/SKILL.md) | `$next-issue owner/repo --rank` | Ranks open issues and recommends an eligible candidate. Read-only. |
| [`plan-pr`](skills/plan-pr/SKILL.md) | `$plan-pr https://github.com/owner/repo/issues/42` | Plans an issue or written brief and opens a draft PR. Add `--local` to keep the plan in the checkout. |
| [`implement-plan`](skills/implement-plan/SKILL.md) | `$implement-plan https://github.com/owner/repo/pull/43` | Implements and verifies a plan, publishes the implementation PR, and moves the linked issue into review. Add `--local` to work in the checkout. |
| [`pr-closeout`](skills/pr-closeout/SKILL.md) | `$pr-closeout https://github.com/owner/repo/pull/43` | Checks CI, approvals, and stack dependencies. Read-only by default. Add `--merge` to merge a ready PR and reconcile its linked issue. |

`next-issue --review` requires [ECC’s `issue-review` skill](https://github.com/affaan-m/ecc/blob/main/skills/issue-review/SKILL.md), installed separately.

## Improve a repository

`$improve owner/repo` audits a pinned GitHub revision and returns up to three issue drafts. It checks open and closed issues and pull requests, including drafts, for overlap. Each proposed issue includes source evidence and testable acceptance criteria. A run can defer findings when evidence or review is incomplete.

Improve uses Python 3.10+, Git and a configured independent reviewer. Its bundled helper makes read-only GitHub requests. See the [skill](skills/improve/SKILL.md) and [reviewer setup](skills/improve/references/helper.md).

## Feedback and handoff skills

| Skill | Example | When to use it |
| --- | --- | --- |
| [`client-feedback-triage`](skills/client-feedback-triage/SKILL.md) | `$client-feedback-triage Draft issue changes from the feedback below.` | Check feedback against the codebase and existing issues, then draft a change set for review. Publishing requires authorization. |
| [`handoff`](skills/handoff/SKILL.md) | `$handoff Implement the agreed CSV export change.` | Delegate to a fresh native Codex executor and verify its result in the current chat. Requires native subagent support. |
| [`fresh-handoff`](skills/fresh-handoff/SKILL.md) | `$fresh-handoff Continue the CSV export fix.` | Start a new Codex desktop chat with a standalone brief derived from the source chat. |

## Executable GitHub delivery workflow

The [GitHub delivery runner](workflows/github-delivery/README.md) coordinates the four GitHub skills as a resumable run with repository policy and optional plan and implementation review gates. An isolated publisher handles GitHub writes. The run ends with a read-only PR readiness check.

The runner has its own setup. Follow the guide to configure Python 3.11+, pinned Spec Kit, repository policy, and the agent and publisher launchers.
