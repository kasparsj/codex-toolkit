# GitHub delivery workflow

This directory contains a resumable, policy-bound delivery coordinator for the
`next-issue` → `plan-pr` → `implement-plan` → `pr-closeout` sequence. It keeps
agent work local and schema-validates its results; a deterministic publisher is
the only component allowed to mutate GitHub. Use macOS or Linux with Python
3.11 or later on `PATH` as `python3`. The implementation uses the Python
standard library.

The executable boundary is intentional:

- `workflow.yaml` is the reviewed local workflow run by Spec Kit v1.3.2 at
  commit `55264c2f2f2d1146f02abc543cb913dcdf1f9342`. It uses strict shell
  steps, dynamic values through `env`, JSON CLI output, and non-TTY gate
  verdicts supplied only by the wrapper.
- `delivery.py start|status|resume|recover` owns the repo mutex, active claim,
  immutable policy and skill hashes, linked attempts, atomic state, manifest
  acceptance, write intents, and recovery.
- The four skills remain usable interactively. `adapter.py` defines and enforces
  an explicit isolated launcher protocol for actual pinned-skill execution and
  schema-valid result acceptance.
- `publisher.py` is the GitHub.com launcher. It takes an operator-allowlisted
  repository and imports each candidate bundle into a fresh bare Git repository
  in a protected publisher directory. Credentialed Git stays outside the agent
  checkout and uses its own config, hooks, and remote settings.

## Repository policy

Each target repository opts in with `.github/delivery.toml` on an explicitly
trusted, already-established remote ref. Fetch that ref read-only, resolve its
full SHA, copy the file into the protected state directory, and pass its SHA-256
digest, source ref, full SHA, and fetch time to `start`. A minimal policy is:

```toml
version = 1

[delivery]
final_target = "main"
publisher_id = 9001
policy_max_age_seconds = 3600

[eligibility]
required_labels = ["ready"]
excluded_labels = ["blocked", "deferred"]

[branches]
default_parent = "main"
allowed_parent_prefixes = ["stack/"]
plan_template = "codex/plan-{issue}"
implementation_template = "codex/issue-{issue}"

[tracking]
review_label = "status: review"

[approvals.plan]
minimum = 1
reviewer_ids = [1001, 1002]

[approvals.implementation]
minimum = 1
reviewer_ids = [1001, 1002]
```

Set either `minimum` to zero to disable that gate. The independent values
support all four plan/implementation gate combinations. Workflow escalation may
raise a minimum, but cannot lower policy or exceed the allowlist. A stale
policy, changed digest, non-full source SHA, unknown publisher, publisher listed
as a reviewer, unsafe ref, or impossible minimum blocks the delivery.

The state records three different destinations: the inspected baseline
repository/ref/full SHA, the immediate publication repository/ref/tip (and
parent PR for a stack), and the final target repository/ref. They must never be
collapsed into one field.

## Start and resume

Use a protected state directory writable by the wrapper/publisher but not the
agent. The active claim is written before candidate selection, so one controlled
host runs at most one issue per target repository.

```bash
export DELIVERY_PUBLISHER_REPO=acme/widget
export DELIVERY_PUBLISHER_ROOT="$protected_publisher_directory"
python3 workflows/github-delivery/delivery.py start \
  --state-dir "$trusted_state" --repo acme/widget \
  --policy "$trusted_state/policy/delivery.toml" \
  --policy-ref refs/heads/main --policy-sha "$policy_sha" \
  --policy-digest "$policy_digest" --policy-fetched-at "$fetched_at" \
  --skills-root skills --agent-launcher /opt/delivery/agent-launcher \
  --publisher-launcher workflows/github-delivery/publisher.py \
  --worktree "$dedicated_worktree" --agent-scratch "$agent_scratch"
```

`next-issue --rank` returns either a structured winner or `no_candidate`.
An empty result completes the runner and releases the claim.
`plan-pr` and `implement-plan` return only locally verified artifacts/candidates.
`pr-closeout` returns a merge-readiness `status` and a separate
`delivery_status`, each `READY`, `WAITING`, or `BLOCKED`. Pending delivery checks
keep the claim active. Merge-only requirements such as approvals or a merge
queue can leave merge readiness waiting while delivery is complete. Closeout
must report actual check states or `["no_required_checks"]` when verified
against applicable rules. Each result uses this envelope and a kind-specific
allowlist:

```json
{
  "schema_version": 1,
  "kind": "rank",
  "delivery_id": "…",
  "repo": "acme/widget",
  "result": {"winner": 42, "shortlist": [42, 31]}
}
```

At a paused review, commit the correction as a fast-forward from the owned
draft head and export its bundle to the same stage's candidate path. Submit
the corrected manifest with `resume --result result.json`. The runner
publishes the new revision on the same draft before asking for approval again.
The publisher verifies that the correction changes the committed tree. Use
plain `resume` to retry an interrupted publication. A replacement candidate
after a failed correction can publish only if the draft still matches the
verified previous revision or the replacement already landed.

`start` dispatches the reviewed YAML through the pinned runner. The wrapper
atomically snapshots the reviewed YAML under `$trusted_state/runner/<delivery-id>/`
and runs Spec Kit there. Its engine state stays in protected per-delivery storage.
Resume verifies that snapshot is unchanged.

The wrapper derives gate booleans and verdicts from trusted policy and fresh,
paginated, exact-PR publisher-launcher receipts; an agent or operator cannot
inject them through the public CLI. `resume` checks the current paused gate,
refreshes the exact PR and reviews, and supplies only the derived verdict to
Spec Kit. Runner gate completion alone does not authorize a mutation. Completed
Spec Kit occurrences replay without re-execution on resume.

The isolated launcher is an executable that reads one JSON task packet from
stdin and writes exactly one manifest JSON object to stdout. The packet includes
the stage, delivery identity, dedicated worktree, and exact pinned skill path
and file digest. The runner also pins each skill package, including its
references and scripts, and checks those pins on resume. Diagnostics belong
on stderr. `adapter.py` strips GitHub/git
credential variables, installs a scratch HOME/GH config, invokes the launcher,
validates its manifest, and enforces rank → plan → implement → closeout stage
order. The launcher may use its own non-GitHub agent credential (for example a
dedicated `CODEX_HOME`) but must not regain publisher credentials.

For `plan` and `implement`, the task packet provides `candidate_ref` and
`candidate_bundle`. After committing and testing the candidate in the agent
checkout, export the candidate and its history since the publication base:

```bash
git update-ref "$candidate_ref" "$candidate_sha"
git bundle create "$candidate_bundle" "$candidate_ref" "^$base_sha"
```

The publication base must be an ancestor of the candidate. The plan manifest
can report a separate `base` when its inspected baseline differs from its
immediate PR base. For both stages, `artifact_paths` must match the candidate
diff against that base. The plan also reports the SHA-256 of each artifact's
committed bytes.

The publisher launcher follows the same one-JSON-object stdin/stdout discipline
for `publish_plan`, `publish_implementation`, `list_reviews`, and `finalize`.
`publisher_adapter.py` derives expected repo/head/head SHA/base/provenance from
trusted state, validates every response, requires proof that reviews were fully
paginated, and performs the COMMENT receipt calculation. The live launcher
rechecks applicable approvals before GitHub writes. The pinned end-to-end
test also supplies a fake launcher for credential-free local runs.

## Approval receipt

An approval is one submitted `COMMENT` review on the exact draft PR:

```text
delivery-review <plan|implementation> <generation> <context-digest> <approve|reject>
```

The review `commit_id` must equal the plan revision or implementation head. The
context digest covers material artifact hashes, issue, inspected baseline,
immediate base and tip, final target, and policy digest. Paginate all reviews,
key reviewers by immutable numeric human ID, exclude the publisher, ignore
dismissed/malformed evidence, and use the latest matching `(submitted_at, id)`
decision per reviewer. Any active reject blocks. A retry cannot clear it; a new
generation requires a recorded material change. In-place conversion preserves
the historical plan receipt, while later plan changes or implementation head
movement invalidate the applicable current receipt.

## Publisher and recovery

Before each publisher operation, the adapter atomically records the expected
GitHub identity and candidate. The publisher reads each mutation back. After
an ambiguous response it queries the exact repo, head, base, and provenance.
It adopts a unique verified match or blocks on a conflict. It marks the PR
ready after verifying the current head, base, and applicable approvals. It
then adds and reads back the existing review label from policy.

A hard kill can leave Spec Kit `running`. Do not edit engine files. First prove
the old PID/process has exited, then run `recover`; it increments a linked
attempt under the same delivery ID and reconciles intents before continuing.

## Credential boundary and live disposable smoke

The agent launcher fails closed unless `DELIVERY_AGENT_ISOLATED=1`, `HOME` and
`GH_CONFIG_DIR` are under its scratch directory, and `GH_TOKEN`,
`GITHUB_TOKEN`, `GITHUB_ENTERPRISE_TOKEN`, `SSH_AUTH_SOCK`, `GIT_ASKPASS`, and
`SSH_ASKPASS` are absent. Launch the agent in a separate OS account/container
with no mounted GitHub CLI config, SSH keys, credential-helper sockets, or
publisher state. Give the launcher only the read access it needs to inspect
issues and PRs. Run the publisher with a GitHub CLI identity limited to the
allowlisted repository. Set `DELIVERY_PUBLISHER_ROOT` to a private directory
outside the agent checkout and scratch directory. The publisher verifies its
authenticated identity against `publisher_id`. The bundled publisher tracks
the issue through an existing review label.

There is no portable stdlib mechanism that proves OS-level credential-helper,
keychain, or container isolation on every platform. The environment validation
is tested, but the stronger boundary must be supplied and audited by the
operator. Do not enable live publication without it.

For a separately authorized live smoke, use a disposable private repository and
test identity:

1. Commit `.github/delivery.toml` to the trusted default branch; record the ref,
   full SHA, digest, numeric publisher ID, and distinct numeric reviewer ID.
2. Start with empty protected state and verify a second concurrent start blocks.
3. Create a planning-only draft through the publisher. On that exact draft and
   plan commit, submit a GitHub **COMMENT** review whose body exactly matches the
   plan receipt. Verify wrong head, stale base/context, malformed body,
   publisher self-review, dismissal, and an active reject all block.
4. Convert the same draft or create exactly one implementation draft according
   to policy. Submit the implementation COMMENT receipt on its exact head.
5. Inject a transport failure after PR acceptance but before checkpoint; verify
   resume adopts the unique PR and does not duplicate it.
6. Exercise pending and failing CI. Pending remains resumable; failing checks
   block completion. Mark the exact verified PR ready and update an existing
   review label/status only. Verify no merge, close, deployment, or label create.
7. Revoke/delete the test credential and disposable repository according to the
   operator's cleanup policy.

## Verification

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s workflows/github-delivery/tests -v
PYTHONDONTWRITEBYTECODE=1 python3 workflows/github-delivery/tests/pinned_e2e.py
git diff --check
```

The test suite covers all gate modes, stale policy, changed head/base, rejection
semantics, ambiguous create recovery, concurrent claim, stacked refs, closeout
waiting/failure with no merge, manifest/privilege validation, correction
generations, skill pinning, and existing-label enforcement.

## M1 GitHub App mode

App mode uses the bundled publisher and one protected state directory on one
operator-controlled host. The user-token launcher remains available through
`--publisher-launcher`. For the M1 fixture use `--app-config` and an explicit
issue number.

Prepare a private GitHub.com repository with `main` as the default branch, one unlabeled
open issue, an existing tracking label, and an Actions workflow on `main` that
runs for draft `pull_request` events on open and synchronize. Audit the
workflow and any other workflow triggered by delivery branch or PR updates.
Use GitHub-hosted runners, read-only checkout credentials, a pinned checkout
action with credential persistence disabled, and a harmless fixture job with
no secrets, deployments, or `pull_request_target`. Keep the default branch
fixed once the policy is in place.

Default-branch protection is optional for every repository. App preflight
records the protection status reported by GitHub. The runner still pins the
base SHA, stops on base drift, and confines App pushes to the delivery branch.
Without GitHub branch protection, other writers can push directly to `main`.

Register a separate private GitHub App for the fixture, generate a key, and
install it only on the selected repository. Grant repository permissions
Metadata read, Contents write, Pull requests write, Issues write, and Actions
read. If branch protection is enabled, leave the App out of its bypass list. Resolve the numeric bot
account using the verified App slug and resolve each reviewer to a GitHub
`User` account. Store the key and binding in owner-only files outside all
agent mounts. Create the bound state directory with mode `0700`.

The protected binding is JSON. Replace the sample IDs, paths and workflow
settings with values from the fixture.

```json
{
  "schema_version": 1,
  "host": "github.com",
  "app": {"id": 100, "client_id": "Iv1.example", "slug": "fixture-delivery", "bot_user_id": 101},
  "installation": {"id": 102, "account_id": 103},
  "repository": {"id": 104, "full_name": "OWNER/FIXTURE"},
  "permissions": {
    "metadata": "read", "contents": "write", "pull_requests": "write",
    "issues": "write", "actions": "read"
  },
  "private_key_path": "/operator/private/fixture-app.pem",
  "state_dir": "/operator/private/fixture-state",
  "allowed_path_prefixes": ["docs/"],
  "ci": {
    "workflow_id": 105,
    "workflow_path": ".github/workflows/delivery-fixture.yml",
    "workflow_sha256": "516af51deca439b5d3452bc4b6c49f7df25098068ad24abfdb41a1198c820432",
    "event": "pull_request",
    "required_job": "verify-fixture"
  }
}
```

Commit `.github/delivery.toml` during fixture setup. The publisher ID is the
bot user ID. Set both approval minimums to one with the intended human IDs,
use `required_labels = []`, set `default_parent` and `final_target` to
`main`, use the same branch template for both stages (for example,
`codex/issue-{issue}`), and map `tracking.review_label` to the existing label.
Fetch the policy from the resulting immutable commit. Record the SHA of
`refs/heads/main`, the SHA-256 of the policy bytes, and the fetch timestamp.

Prepare a self-contained dedicated checkout at that commit and set
`git config --local delivery.agentCheckout true`. Remove credential-bearing
remotes and local credential helpers. Supply a locally available image pinned
by registry digest and an operator-controlled agent launcher compatible with
that image. The agent runs in a network-disabled Docker container with its
own writable checkout and output directory. The launcher needs an in-container
agent runtime capable of operating offline. It reads the adapter JSON packet
on stdin, reads private issue and PR data from its mounted snapshot, and
returns the requested manifest and candidate bundle. Git source is available
in the checkout. The publisher refreshes the repository-scoped read snapshot
on start and resume. The protected config, private key, trusted Git workspace,
Docker socket, and host home stay outside the container.
Export full candidate bundles so the implementation can extend the exact
reviewed plan commit while keeping the default-branch base pinned.

```bash
python3 workflows/github-delivery/delivery.py start \
  --repo OWNER/FIXTURE --issue 1 --delivery-id m1-fixture \
  --app-config /operator/private/app.json --state-dir /operator/private/fixture-state \
  --policy /operator/private/delivery.toml --policy-ref refs/heads/main \
  --policy-sha "$FIXTURE_SHA" --policy-digest "$POLICY_DIGEST" \
  --policy-fetched-at "$POLICY_FETCHED_AT" --skills-root "$TOOLKIT/skills" \
  --agent-launcher /operator/fixture-agent --container-image "$AGENT_IMAGE_DIGEST" \
  --worktree /operator/agent-checkout --agent-scratch /operator/agent-output
```

Use `status`, `resume`, and `recover` with the same state directory,
repository and delivery ID. Pass the same `--skills-root` on resume and
recover. At either gate, `status` supplies a review URL, exact head SHA, and
the exact body for a submitted **Comment** review. The implementation review
must be on the new head of the same draft. Resume checks submitted reviews
and the current GitHub state. Use `recover` when the previous coordinator
died and left the runner marked running. If the protected policy or default
branch has moved, preserve the claim and reconcile the delivery before
replanning against the new base.

For the disposable recovery trial, run start or resume with
`DELIVERY_PUBLISHER_FAULT_AFTER` set to one of `push`, `pr_create`,
`pr_update`, `ready`, or `label`. The publisher simulates losing the
response once for the selected write after acceptance and before its
checkpoint. Clear the variable and resume the same delivery ID. Compare the
journal and GitHub ref, PR, and issue state before and after each retry.
Review-ready requires the final open PR, trusted CI on its exact revision,
and the existing issue label to be read back. Claim release follows the
durable terminal checkpoint.

For an explicitly authorized fixture trial, pass
`resume --defer-actions-verification` at the paused implementation review.
The runner records the deferral only after verifying the submitted approval
and binds it to that exact head. The terminal record reports CI as deferred
and still requires the ready PR and issue label to be read back.
