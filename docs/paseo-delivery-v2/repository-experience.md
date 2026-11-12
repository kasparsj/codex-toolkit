# Repository Delivery in Paseo

Repository Delivery is a repository-scoped workflow. Run `/delivery` from a Paseo workspace composer to open that workspace's native Delivery panel. Repeating the command focuses the existing panel. Opening, refreshing, switching to, closing, or reopening the panel never starts, resumes, pauses, or stops work.

## Repository scope

The plugin asks the selected Paseo host to refresh the workspace ID. The TypeScript engine then derives the canonical GitHub origin, Git root, common Git directory, branch or detached-HEAD state, commit, and current worktree from the server-resolved directory. The browser cannot supply a repository, executable, state directory, working directory, credential, provider, or operator grant for an operational command.

Linked worktrees and independent clones of the same canonical GitHub repository share one protected repository binding, state root, and repository runner. The panel still shows the worktree and branch from which `/delivery` was opened. A changed or ambiguous origin, unsafe checkout, conflicting state root, or stale binding blocks controls instead of creating another owner.

## Host and engine configuration

The plugin needs a trusted absolute command for the TypeScript engine. In a source checkout it searches only ancestors of the plugin module for `packages/delivery`; it never searches the daemon working directory. A bundled runtime may not expose `import.meta.url`, and a separately installed plugin has no trusted monorepo ancestor. In either case, configure an explicit command.

The backend reads its normal private configuration from the daemon user's home:

```text
~/.config/codex-toolkit/delivery-v2/dashboard.json
```

The portable engine uses the containing directory as its default repository registry:

```text
~/.config/codex-toolkit/delivery-v2/
```

Set `DELIVERY_REGISTRY_DIR` to an absolute private directory only when the plugin backend, runner processes, and portable CLI must share a different registry, such as an isolated validation host. Set `PASEO_DELIVERY_DASHBOARD_CONFIG` to the matching protected `dashboard.json` when it is not at the default path. The plugin and CLI must resolve the same registry; copying a profile or state file into another root does not transfer repository ownership.

The dashboard configuration directory must be owned by the daemon user with mode `0700`. The JSON file must be an owner-owned, non-symlink regular file with mode `0600`:

```json
{
  "cliArgv": [
    "/absolute/path/to/node-22.19-or-newer",
    "--experimental-strip-types",
    "/absolute/path/to/packages/delivery/src/cli.ts"
  ],
  "workspaceOperatorGrant": "an-explicit-protected-host-control-grant"
}
```

`workspaceOperatorGrant` is optional. When present, the backend passes it privately to the engine for revision-bound delivery controls and digest-bound publication actions. The legacy `operatorGrant` field is ignored. The grant and publisher credentials never enter a browser RPC or panel DTO.

Keep the default dashboard path for a normal persistent Paseo launch. Paseo 0.15.4 preserves `DELIVERY_REGISTRY_DIR`, `PASEO_DELIVERY_DASHBOARD_CONFIG`, and `PATH` for both `daemon start` and `daemon run`. Set overrides when launching a new daemon: reusing an existing instance does not update its environment. For an isolated development or validation host, a foreground launch makes its lifetime easy to observe:

```sh
env \
  PASEO_LISTEN=127.0.0.1:6819 \
  PASEO_RELAY_ENABLED=false \
  PASEO_WEB_UI_ENABLED=true \
  DELIVERY_REGISTRY_DIR=<VALIDATION_ROOT>/registry \
  PASEO_DELIVERY_DASHBOARD_CONFIG=<VALIDATION_ROOT>/dashboard.json \
  paseo daemon run --home <VALIDATION_ROOT>/paseo-home
```

This isolated-host command is a validation recipe. The final frozen candidate still needs a fresh end-to-end run. Environment inheritance was verified against the pinned Paseo 0.15.4 source; absence from `ps` output does not prove an environment variable was removed.

## First-use repository setup

Provider permissions belong in the protected executor asset, alongside its provider and model. Paseo configuration selects `modeId`, `featureValues`, and native `options` explicitly; an unsupported selection is a setup/preflight refusal, not permission to use host defaults. Validation uses Codex workspace writes, approvals on request, and network access off. It does not automatically accept tool permissions or widen the sandbox when a task cannot proceed.

Providers advertising no modes, including Pi in Paseo 0.15.4, omit `modeId`. The adapter requires an empty advertised catalog and an exact `currentModeId:null` snapshot for that selection. A provider advertising modes requires an explicit supported selection. Codex continues to require `auto` and the permission settings below; Pi does not inherit Codex options or sandbox guarantees.

Capability discovery happens for an explicit execution request, not when opening the Delivery panel or inspecting an offline export. Paseo's feature discovery can briefly launch a provider process without sending a model prompt. Selected creation settings and their provenance remain protected. SDK snapshots expose mode/features but do not expose the resolved native sandbox options; creation provenance must not be described as a fresh native-policy readback.

The Codex permissions portion of an executor asset is:

```json
{
  "modeId": "auto",
  "featureValues": {},
  "options": {
    "approval_policy": "on-request",
    "sandbox_mode": "workspace-write",
    "sandbox_workspace_write": {
      "network_access": false,
      "writable_roots": [],
      "exclude_slash_tmp": true,
      "exclude_tmpdir_env_var": true
    }
  }
}
```

When the provider advertises `plan_mode`, select `"plan_mode": false` in `featureValues` for execution. Other providers require their own advertised mode/features; Codex settings are not silently applied to them. Tool permissions remain operator decisions, including a narrowly scoped local Git approval when the sandbox requires it. The adapter does not turn on broad approval or widen writable roots to make a task succeed.

An unconfigured repository opens a setup view with two choices:

- Import an existing owner-only local Delivery profile.
- Create a profile from existing protected policy, publisher, executor, checker, reviewer, and skill-source assets.

Setup validates the live repository and every referenced asset before writing an owner-only binding. Create mode requires non-empty `allowedPaths.plan` and `allowedPaths.implementation` lists. Each entry must be a narrow repository-relative slash path such as `docs/delivery-plan.md` or `src/delivery.ts`; absolute paths, empty segments, traversal, backslashes, and glob characters are refused.

A created profile starts with PR publication `off`, issue publication `off`, and unattended scheduling disabled. Import preserves the profile's protected policy but does not copy a global dashboard grant. Saving setup creates repository lifecycle authority in the protected Toolkit registry used by that host; the same local owner and registry can use it through the CLI when Paseo is unavailable. It does not start a runner, create credentials, change a GitHub account, authorize publication, or enable scheduling.

## Start and observe a delivery

1. Open `/delivery` in the intended Git workspace and confirm the displayed repository, worktree, branch, and commit.
2. Import or create the protected repository binding when prompted.
3. Select `Start` for one explicit issue or one explicit rank-next selection. Start creates one one-shot runner; it never turns on unattended scheduling.
4. Follow the exact candidate, local checks, independent review, publication draft, GitHub review, readiness, and tracking evidence in the panel.

Planning, checking, exact-candidate binding, independent review, publication policy, and human ready/tracking gates remain mandatory. The repository panel changes ownership and navigation, not those safeguards.

## Publication-off manual workflow

Publication `off` remains the safe default. It does not require changing policy to complete a managed delivery. When the panel shows a protected local draft, use the CLI-only manual route from a worktree of the same canonical repository:

```sh
DELIVERY_OPERATOR_GRANT='<protected-host-control-grant>' \
node --experimental-strip-types /absolute/path/to/packages/delivery/src/cli.ts export-handoff \
  --profile /absolute/path/to/repository-profile.json \
  --repo OWNER/REPOSITORY \
  --delivery-id DELIVERY_ID \
  --expected-revision REVISION \
  --stage plan \
  --request-id manual-export-plan-001
```

The command verifies the exact bound profile, state root, repository, grant, request, revision, candidate, base, allowlist, and draft identity. It writes an owner-only handoff under the protected publisher state. An operator may then publish that exact branch and draft pull request through their separately authorized GitHub workflow.

After the draft exists, refresh `workspace-status`, use its current delivery revision, and bind the exact pull request number:

```sh
DELIVERY_OPERATOR_GRANT='<protected-host-control-grant>' \
node --experimental-strip-types /absolute/path/to/packages/delivery/src/cli.ts bind-manual-pr \
  --profile /absolute/path/to/repository-profile.json \
  --repo OWNER/REPOSITORY \
  --delivery-id DELIVERY_ID \
  --expected-revision REVISION \
  --stage plan \
  --number PULL_REQUEST_NUMBER \
  --request-id manual-bind-plan-001
```

`bind-manual-pr` performs read-only GitHub verification. It requires the exact repository, actor, draft state, title, body, head, base, and candidate that were exported; it does not create or update the pull request. Repeat the same export/bind sequence with `--stage implementation` only after the engine has produced and independently verified the exact implementation candidate.

Use a stable request ID when reconciling the same attempt. A changed payload under an existing request ID is rejected. If either command loses its response, refresh the repository and reconcile the recorded operation; do not invent a new request or blindly repeat a possible effect. Paused, stopping, or uncertain sessions allow exact readback only and refuse new manual effects until explicit Resume or recovery makes the repository safe.

## Runner controls and background work

The repository runner is a portable Node process backed by Toolkit state outside plugin storage. Closing the panel, disconnecting the client, or reloading the plugin leaves explicitly started work running. Reopening `/delivery` reconnects to the same durable repository owner and delivery; it never starts or resumes work.

| Control | Effect |
| --- | --- |
| Start | Creates one one-shot runner for an explicit issue or rank-next choice. Refuses an unfinished claim or competing owner. |
| Pause | Records a barrier. An already reserved operation drains to durable state; no next transition is reserved. |
| Resume | Revalidates repository identity, profile, runtime, skills, and delivery pins, then continues the same delivery. |
| Stop | Drains the current reserved operation and exits the repository runner while preserving unfinished work and its claim. It does not cancel provider work. |
| Cancel | Starts a separate, revision-bound effect-disposition workflow. It is not Stop and cannot release a claim while effects remain unresolved. |
| Recover | Reconciles the exact recorded owner, execution, publication, and pins after proven process loss. It never means “retry blindly.” |
| Retry reviewer preflight | Authorizes one new independent-review attempt only after protected proof establishes that the previous review never began. Retains the exact candidate/checks and revalidates all pins; no automatic retry or publication. |

Runner state and delivery stage are separate. `Starting`, `running`, `pausing`, `paused`, `stopping`, `stopped`, `blocked`, and `uncertain` describe supervision, not whether a delivery is complete. Process death, a stale heartbeat, or a reused PID is never treated as pause, completion, or permission to start a duplicate. Unknown process or provider state remains uncertain until an explicit safe recovery establishes the exact disposition. There is no automatic restart, recovery, or next-issue scheduling. The runner never signals a process solely because a PID was stored.

A reviewer preflight refusal is an explained block with no unresolved external review effect. Fix the external preflight condition before choosing **Retry reviewer preflight**. A stopped repository accepts authorization but stays stopped until Resume; a paused repository requires Resume or Stop first. A changed candidate, check receipt, producer, profile, runtime, policy, or skill pin refuses retry. Use correction for a material implementation change. Accepted, live, no-ordinary-run, or otherwise unknown effects require their existing reconciliation path. A protected Pi `no_ordinary_run` receipt proves that an ordinary model run did not start; it does not prove whether an input hook handled or rejected the request, and it does not resolve extension effects.

## Portable inspection

The same owner can inspect repository state without Paseo:

```sh
node --experimental-strip-types /absolute/path/to/packages/delivery/src/cli.ts \
  workspace-status --directory /absolute/path/to/worktree
```

`workspace-status` is read-only and returns one JSON envelope. Setup, runner controls, delivery controls, exports, and recovery are also available through the portable TypeScript CLI and use the same protected repository registry and revision fences.

## Migration and acceptance status

Repository-scoped `/delivery` replaces the global Python Delivery dashboard. Existing global configuration may be suggested during setup, but it is not silently migrated and does not grant repository runner or publication controls.

The TypeScript replacement passed its full 163-criterion local-developer acceptance gate before Python retirement. The [acceptance snapshot](evidence/repository-experience/final-acceptance.md) records that qualification; its detailed local fixture receipts remain in the implementation workspace, not the distributed runtime. The [parity matrix](local-parity-matrix.json) records source-to-replacement coverage. These are historical qualification records, not a claim that private temporary fixture paths exist on another machine.

After explicit user authorization, the legacy Python runner, installed Python CLI, wheel packaging and dependent global dashboard were removed. Git commit `2d791bd` preserves the final Python source, including the local-verifier test changes. The unrelated Python Improve helper remains. No Python or Spec Kit subprocess implements Delivery transitions.

See the [reviewed plan](repository-plan/implementation-plan.md), [test specification](repository-plan/test-spec.md), [current validation guide](validation.md) and [TypeScript package README](../../packages/delivery/README.md). Qualification used disposable Git/HTTP repositories and an isolated Paseo host; real GitHub publication, merge, deployment, credential changes and unattended enablement require their own authorization.
