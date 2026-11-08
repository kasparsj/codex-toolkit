# Draft PR publication

Use this procedure when the user asks to publish or invokes `$plan-pr` for a new plan without `--local`. Use authenticated GitHub access and git for the intended repository. In GitHub CLI commands, set `--repo HOST/OWNER/REPO` explicitly. Match the git push destination to the same repo or to a fork the user or repo workflow authorizes. If publication is unavailable, preserve the local artifacts and report where they are.

## Resolve the draft and branch

1. Re-read the issue state and look for an open planning PR for the same issue and base. Check exact issue references and whether the diff consists of planning artifacts. If a matching planning PR exists, return it and its artifacts. For an explicit revision, verify the identified PR is open and in draft. If multiple PRs match, the identified PR contains implementation, or its review state changed, resolve the target before writing.
2. For a new draft, use an isolated worktree or clean dedicated branch from the verified planning base. Fetch the actual remote base before creating the branch. If it moved since investigation, check the plan against the new tip and update the recorded baseline. Preserve the user's existing edits and staging area. Use repo branch conventions or a predictable `codex/plan-issue-<number>-<slug>` name. If that remote branch exists, reconcile it and any associated PR before proceeding. For revision, start from the fetched draft head and use a normal fast-forward push. Keep the existing base and draft status.

## Verify and publish the artifact diff

Stage only the exact reviewed artifact paths. Before committing, compare `git diff --cached --name-only --no-renames -z` with the intended changes and run `git diff --cached --check`. Inspect the staged plan, tests, and mockup references. After committing, inspect the prospective PR diff with `git diff --name-status --no-renames <fetched-base>...HEAD` and confirm every changed path is a reviewed artifact. For a new draft, verify that the only new commit is the planning commit. For a revision, verify that the new commit adds only the intended revision. Push the exact branch ref without force, then check for an existing PR on that head before creating one.

Use the repository's PR template where appropriate. Include a short proposed change summary, review questions, planning and test links, and HTML/JPEG links and embedded images when applicable. Leave the source issue untouched, including its title, body, labels, assignees, comments, and state. Use `Refs #N` for same-repo issues or a full issue URL for cross-repo references. Avoid issue-closing references such as `Closes #N` or `Fixes #N` in the PR body and planning commits. For artifact links in the PR body, use the head repository's commit-qualified blob URL, URL-encoding path segments as needed. Use `?raw=true` on the blob URL for the embedded JPEG. Refresh commit-qualified links after a revision.

For a new draft, add one direct `@login` mention in the review request text if the intended recipient is known and different from the GitHub publishing identity. Use the explicitly supplied `--notify @login` or a verified GitHub login for the human requester. Verify the identity used by the publishing connector, or use `gh api user --hostname HOST --jq .login` with the same CLI authentication. If either identity is unknown, use the invoking surface for the completion notification. Never infer the recipient from the issue author, assignee, or repository owner. Keep mentions copied from issue text inert so they cannot notify unrelated accounts.

Create with the equivalent of the following, substituting resolved values and a temporary body file. For forks, supply the explicit qualified head supported by the GitHub provider.

```bash
gh pr create --repo "$target_repo" --base "$base" --head "$head" \
  --draft --title "$title" --body-file "$body_file"
```

For an explicitly authorized revision, update the body on the identified draft with `gh pr edit` or the equivalent connector action. Leave the draft state intact. Before retrying any ambiguous create or edit, query the exact head and base and reconcile the existing PR. If a push succeeded and the PR operation failed, report the branch and continue from it when retry is safe.

Read back the PR and verify its URL, author, open draft state, base, head repository and commit, body links, and changed-file list. Return the URL, the plan and mockup paths, and the questions for human review. Report partial publication precisely if a read-back check cannot be completed.

## Notify the author or requester

- After verifying a new or updated draft, send the requester a completion notification with the PR URL through the invoking surface. In an interactive Codex run, use `send_message_to_user_async` when available. In a scheduled run, put the link and review request in the completion result so the run can notify its owner. Always include the URL in the final handoff.
- GitHub rejects a formal reviewer request to the PR author. When the publishing identity is also the recipient, use the invoking surface. For a new draft or a revision with a requested GitHub notification, an already authorized, separately authenticated notifier can post one comment mentioning the verified human PR author or explicit recipient. Check the existing PR body and comments before sending. GitHub also supports email for a user's own activity when enabled in their [notification settings](https://docs.github.com/en/subscriptions-and-notifications/get-started/configuring-notifications).
- For a distinct recipient, verify the `@login` mention in the new PR body. For a published revision, use an authorized PR comment only when a fresh GitHub notification was requested, and check that this revision has not already been announced. Keep the PR in draft. Report the mention or completion handoff actually sent, since GitHub inbox delivery depends on the recipient's settings.
