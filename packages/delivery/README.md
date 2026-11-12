# Codex Toolkit Delivery V2

This package is the local TypeScript engine behind repository-scoped Delivery. In Paseo, run `/delivery` from the current Git workspace to open or focus its native panel. Opening, refreshing, switching to, or closing the panel never starts work. The explicit `Start` control launches one one-shot repository runner; unattended scheduling remains a separate protected opt-in.

Paseo is an adapter and control plane. Canonical GitHub identity, protected repository configuration, runner ownership, workflow state, policy identity, execution receipts and exports remain portable files outside plugin storage. Linked worktrees share the repository owner while the panel retains the selected worktree and branch as launch provenance. See the [repository experience guide](../../docs/paseo-delivery-v2/repository-experience.md) for setup, lifecycle, recovery and migration behavior.

## Runtime

- Node.js 22.19 or newer (Node 24 is supported)
- TypeScript 5.9 for static checking
- `@getpaseo/client` 0.15.4 for a foreground Paseo executor profile
- No Python or Spec Kit runtime

Install and verify from this directory:

```sh
npm install
npm run typecheck
npm test
npm run demo
```

`npm run demo` illustrates the state transitions with fixture publisher/checker/reviewer results. It does not run a coding model or publish remotely. The repository journey integration test additionally uses actual temporary Git repositories, a local HTTP fixture and detached CLI/runner processes.

## Operating model

The engine persists schema-versioned state with 0600 files, 0700 directories, fsync/rename writes, repository locks, monotonic revisions and claim fencing. Agent manifests are data. Publisher writes require a staged handoff, its exact content digest and a durable operation intent. Human review remains bound to the exact commit, stage generation, material digest, base, final target and policy digest. Merge and deploy are not engine operations.

The CLI emits one JSON envelope on stdout:

```json
{"ok":true,"data":{}}
```

Domain refusal uses `ok:false` and exits nonzero. Diagnostics and foreground status go to stderr.

The primary repository commands are:

- `workspace-status --directory <absolute-worktree>` resolves repository identity and returns setup, runner and run projections without starting work.
- `workspace-setup --directory ... --expected-revision ... --request-id ...` imports or creates the protected repository binding.
- `runner-control --directory ... --action start|pause|resume|stop|recover` manages the durable repository runner with revision fencing.
- `workspace-command --directory ... --delivery-id ... --action ...` applies an allowed revision-bound delivery control behind the repository runner barrier.

The existing portable engine commands remain available for inspection, exports, migration and non-bound profiles: `start`, `list`, `status`, `resume`, `advance`, `pause`, `control-resume`, `cancel`, `recover`, `stage-handoff`, `publish-plan`, `publish-implementation`, `export-handoff`, `bind-manual-pr`, `export`, `inspect-export`, proposal-draft commands and `foreground`. Bound repositories retain a narrowly managed form of `export-handoff` and `bind-manual-pr` for the publication-off workflow described below. Native publication uses a backend-held operator grant and an exact staged draft digest; the untrusted UI never supplies the profile, state root, executable, working directory or grant.

### Publication-off manual continuation

When the protected policy reports a staged draft with `publicationMode: "off"`, Delivery waits for an explicit operator instead of creating a PR. Use the exact owner-only profile already bound to the repository and a fresh revision from `workspace-status`:

```sh
DELIVERY_OPERATOR_GRANT='<operator-grant>' github-delivery-v2 export-handoff \
  --profile /absolute/path/to/profile.json \
  --repo owner/repository \
  --delivery-id <delivery-id> \
  --expected-revision <fresh-revision> \
  --stage plan \
  --request-id <unique-request-id>
```

Export verifies the protected candidate and writes an owner-only record at `<publisher.stateRoot>/manual-handoffs/<delivery-id>.json`. It does not push a branch or call GitHub mutation APIs. The operator then publishes exactly the record's `head_sha` to its `head` ref and creates a draft PR with its exact `base`, `title`, and `body`. After obtaining the PR number, read a fresh revision and bind the existing draft:

```sh
DELIVERY_OPERATOR_GRANT='<operator-grant>' github-delivery-v2 bind-manual-pr \
  --profile /absolute/path/to/profile.json \
  --repo owner/repository \
  --delivery-id <delivery-id> \
  --expected-revision <fresh-revision> \
  --stage plan \
  --number <pull-request-number> \
  --request-id <unique-request-id>
```

Repeat with `--stage implementation` when the independently verified implementation handoff is ready. Binding performs read-only identity checks for the repository, actor, head/base refs and SHAs, title, body, draft state, and PR number; it performs no POST, PATCH, push, merge, or deploy. Pause or Stop prevents a new managed manual effect from being admitted. A command already admitted before the control barrier drains under its exact repository reservation; process-loss recovery remains explicit and request-fenced.

Managed manual request IDs are durable. Replay the exact original command, including its original expected revision, to read back a completed or failed result after response or process loss. Reusing the ID with another action, stage, PR number, or expected revision is rejected. Recovery consults the protected engine operation and concrete publisher journal without repeating an export, push, POST, PATCH, merge, or deploy. A proven pre-effect failure releases the repository reservation; an external effect that remains uncertain keeps the barrier and is shown as unresolved until an exact readback can settle it.

## Protected local profile

Repository setup can import an existing owner-only profile or create one from explicit protected assets. Created profiles default to `auto_schedule: false` with PR and issue publication `off`. Bare `github-delivery-v2` remains equivalent to the legacy portable `github-delivery-v2 foreground` mode. It infers the canonical GitHub `origin` and loads an owner-only profile from:

```text
~/.config/codex-toolkit/foreground/<owner>/<repo>.json
```

The profile pins the repository, state root, skills root, policy provenance, foreground policy, publisher configuration and implementation executor. Verification uses `checker: {"argv": ["/absolute/executable", "arguments"], "cwd": "/absolute/worktree"}` and a separate `reviewer` configured with the same executor kinds:

- `paseo`: daemon URL, host ID, repository path, immutable base ref/SHA, provider/model, `featureValues`, and `options`. Select an advertised `modeId`; omit it only for a provider advertising no modes, such as Pi. Codex requires `auto`, approval on request, workspace writes and network off; unsupported settings refuse before a prompt. See the [permission setup](../../docs/paseo-delivery-v2/repository-experience.md#first-use-repository-setup).
- `pi`: absolute Pi executable and optional provider/model/session directory;
- `executable`: a protected JSON packet launcher, suitable for Codex/local adapters.

Each executable reads one JSON request on stdin and writes one JSON result on stdout. A checker returns `{"status":"success","candidate_sha":"<exact candidate>"}` only after its configured checks pass. A reviewer returns `status: "approved"`, the exact `candidate_sha`, `delivery_id`, `task_id`, and `criteria_digest` supplied in the review request (`criteria.criteria_digest`). The engine binds that result to its own persisted producer and reviewer execution identities. Agent-authored identity strings do not establish independence.

Foreground scheduling is disabled unless the separate protected foreground policy explicitly enables `auto_schedule`. PR and issue publication modes are independent and default to `off`; supported values are `off`, `explicit`, and `automatic`. Ctrl-C stops scheduling and drains the current engine/publication boundary. It never performs automatic recovery or force-kills inherited work.

The repository-scoped runner does not enable foreground scheduling. `Start` selects one explicit issue (or one explicit rank-next choice) and stops after that delivery reaches its terminal gate. Closing Paseo leaves an explicitly started runner alive; reopening `/delivery` reconnects to durable state. Process loss is reported as blocked or uncertain rather than paused or completed, and recovery is an explicit revision-fenced action.

The protected foreground policy also declares `allowed_paths` separately for `plan` and `implementation`. Native create setup requires the corresponding `allowedPaths.plan` and `allowedPaths.implementation` fields as non-empty arrays. Values must be narrow repository-relative slash paths: no absolute paths, empty or `.`/`..` segments, backslashes or glob characters. Keep each list to the exact files that stage may publish. Agent handoffs must match those lists. Runtime/configuration files and executable script arguments are hashed so changing a launcher in place invalidates its old pins. Implementation publication requires successful checks and an independent review of the exact candidate before the PR write.

## Native repository panel boundary

The `/delivery` plugin resolves the current Paseo workspace on the server, invokes the shipped CLI with that workspace directory, and returns only allowlisted display fields. Repeated command invocation focuses the existing workspace panel. The former global sidebar dashboard is superseded as the primary workflow.

Controls use `{deliveryId, expectedRevision, action, requestId}` from the panel; the server derives the repository and owns the grant, profile, state root and executable boundary. Publication additionally carries the exact staged draft digest. There are no approve, mark-ready, label, merge or deploy mutations. Ready and tracking transitions are read back after explicit engine checkpoints and remain human GitHub actions.

A proven independent-review preflight refusal blocks the run without claiming an uncertain external effect. **Retry reviewer preflight** explicitly authorizes one new review attempt against the unchanged candidate and successful check evidence. It revalidates protected proof and all pins; it never reruns implementation or publishes. While stopped, authorization leaves the repository stopped until Resume. A paused repository requires Resume or Stop first. Unknown or accepted effects cannot use this retry. The portable command is `retry-review`; managed repositories use `workspace-command --action retry_review` with the usual exact revision, request ID and protected operator grant.

## Portable exports

`export` writes an owner-only, digest-protected bundle containing objective, workflow/policy identity, graph, execution IDs, decisions and unresolved effects. `inspect-export` validates it without Paseo. Claim tokens, publication authorization digests, credentials, private keys and protected configuration paths are excluded.

The V2 runtime has no Python bridge. Existing Python delivery code remains available as rollback and comparison material until replacement acceptance has complete final-source evidence; this package does not declare it retired.
