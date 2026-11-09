# Codex Toolkit

Use Codex to audit repositories, triage feedback, take a GitHub issue from selection through PR review, or hand work off to a fresh agent or chat. Invoke individual skills in Codex, or use the separately configured GitHub delivery runner to coordinate the issue-to-PR sequence.

## Install the interactive skills

With Node.js 22.20 or later, install all skills for Codex.

```bash
npx skills add kasparsj/codex-toolkit --skill '*' -a codex -g
```

Omit `-g` for a project-only install. [Skills CLI reference](https://github.com/vercel-labs/skills/blob/main/docs/commands.md#skills-add)

In a Codex chat, replace `owner/repo` with your repository and try `$next-issue owner/repo --rank`. This returns a shortlist and a recommended issue without writing to GitHub.

## Install the GitHub delivery CLI

Build and install the versioned wheel with Python 3.11 or later. `uv tool`
keeps the command's interpreter independent of the `python3` selected by the
target checkout or the shell.

```sh
uv build --python 3.11
uv tool install --python 3.11 dist/codex_toolkit-0.1.0-py3-none-any.whl
codex-toolkit delivery --help
```

The same package can be installed directly from a reviewed, full revision in a
local clone:

```sh
uv tool install --python 3.11 \
  "codex-toolkit @ git+file:///absolute/path/to/codex-toolkit@FULL_COMMIT_SHA"
```

Create the owner-controlled developer profile described in the [delivery
guide](workflows/github-delivery/README.md#developer-mediated-delivery). Pass
its absolute path explicitly, or store it at
`~/.config/codex-toolkit/delivery/<owner>/<repo>.json`, with the owner and
repository lowercased. Then run the installed workflow from the target
checkout:

```sh
codex-toolkit delivery doctor --repo OWNER/REPO \
  --agent-launcher /absolute/path/launcher \
  --worktree /absolute/path/dedicated-checkout \
  --agent-scratch /absolute/path/scratch \
  --container-image IMAGE@sha256:DIGEST
codex-toolkit delivery preview --repo OWNER/REPO
codex-toolkit delivery start --repo OWNER/REPO --issue NUMBER \
  --agent-launcher /absolute/path/launcher \
  --worktree /absolute/path/dedicated-checkout \
  --agent-scratch /absolute/path/scratch \
  --container-image IMAGE@sha256:DIGEST
codex-toolkit delivery status --repo OWNER/REPO
codex-toolkit delivery resume --repo OWNER/REPO
```

Use `--developer-config /absolute/path/developer.json` after any subcommand to
override profile discovery. `status`, `resume`, and `recover` accept an optional
`--delivery-id`. Doctor reports omitted delivery inputs as full-delivery
blockers while retaining its separate preview-readiness result. Preserve the
installed version recorded by an active run. If a hard kill leaves the
coordinator recorded as running, ordinary `resume` refuses the state. After
proving the recorded process has exited, run:

```sh
codex-toolkit delivery recover --repo OWNER/REPO \
  --developer-config /absolute/path/developer.json \
  --delivery-id DELIVERY_ID
```

Then continue with `resume`.

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
