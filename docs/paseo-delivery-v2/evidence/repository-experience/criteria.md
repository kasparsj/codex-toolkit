# Final repository-experience criteria matrix

Historical pre-C31 criterion matrix. Pending/current-repair wording below records an earlier failed or incomplete candidate and is retained as evidence, not as the current verdict. See the [accepted C31 snapshot](final-acceptance.md) and [current validation and Python retirement](../../validation.md).


Status on 2026-11-12: **pending final-candidate validation**. A row remains pending until its individual assertions have direct evidence tied to one frozen source/package hash set. Aggregate test totals cannot change a row's status.

## Candidate status

| Source set | Verdict | Evidence boundary |
| --- | --- | --- |
| Candidate 8 | rejected | Independent code review requested changes; architecture review blocked acceptance; the full engine suite recorded 297 passes, one failure, and one cancellation; real Pi resume exposed the `0644` session-file compatibility failure. The 72 recorded source hashes were stable for those observations. |
| Candidate 9 | rejected | All 308 engine tests passed; independent review still found recovery, admission and Pi-resume defects. Green totals did not establish acceptance. |
| Candidate 10 | rejected | 74 hashes stable through both independent reviews; 321/322 engine tests,12/12 plugin tests and both typechecks passed. Reviews confirmed idle-control starvation, detached-worker transient backoff failure, and Pi terminal-group SIGINT exposure. |
| Current lifecycle repairs | work in progress | Fix those three defects without weakening exact CAS, effect uncertainty or explicit cancellation. Integrated actual Pi, full native lifecycle, packed journey and final per-criterion acceptance remain pending. |

`.omx/evidence/repository-delivery/acceptance-inventory.json` records 163 scoped entries. It is an inventory, not an atomic pass count.

## New repository targets

| Target | Required atomic assertions | Status | Evidence |
| --- | --- | --- | --- |
| VAL-REPO-IDENTITY | .1 live host workspace resolution; .2 repo/root/common-dir/branch/worktree; .3 detached HEAD; .4 non-Git/missing/ambiguous/malformed/credential origin refusal; .5 mutation-time identity drift refusal | partial | .1-.2 native evidence below; .3-.5 pending |
| VAL-REPO-ISOLATION | .1 separate profiles/state/runs; .2 cross-repo control refusal; .3 host/workspace/repo cache and uncertainty keys; .4 delayed old response discarded; .5 same run ID remains distinct | partial | .1 native evidence below; .2-.5 pending |
| VAL-REPO-WORKTREES | .1 linked worktrees share binding/run; .2 same-repo clone cannot create alternate owner; .3 concurrent Start has one winner; .4 stale concurrent controls refuse; .5 launch provenance visible; .6 old/new foreground cannot coexist; .7 killed-lock concurrent reclaim does not remove fresh owner | partial | .1 and .5 native evidence below; remaining assertions pending |
| VAL-REPO-COMMAND | .1 command offered in draft and agent workspaces; .2 opens current workspace panel; .3 repeat focuses existing tab; .4 workspace switch opens correct panel; .5 global entry absent; .6 open/refresh/switch causes zero dispatch | partial | .1-.3 observed in draft and real-agent contexts; agent invocation portion of .6 observed; .4-.5 and full .6 remain pending or indirectly supported |
| VAL-REPO-SETUP | .1 missing binding setup; .2 profile import; .3 structured private creation with off/off/scheduling false; .4 unsafe/mismatched prerequisite refusal; .5 stale concurrent save; .6 no effects on save; .7 no global grant inheritance; .8 lifecycle-only authority and setup-only protected paths | partial | .1-.4 and .6 observed, part of .7 supported; .5 and remaining authority assertions pending |
| VAL-REPO-RUNNER-CONTROLS | .1 explicit one-shot Start; .2 unfinished duplicate refusal; .3 pause barrier/drain; .4 pin-revalidating resume; .5 draining stop preserves work; .6 Cancel distinct; .7 request replay/conflict; .8 concurrent serialization; .9 before/after reservation barrier race; .10 packaged CLI/RPC DTO and errors; .11 manual effects cannot bypass barrier | partial | .1 and .6 source-dated native evidence; .3 source-dated partial evidence; focused current-source tests cover managed publication-off export/read-only binding and barrier behavior, but final-source native resume/recovery/concurrency and integrated `.11` assertions remain pending |
| VAL-REPO-RUNNER-STATE | .1 session versus run; .2 running/pausing/paused/stopping/stopped/blocked/uncertain; .3 starting reservation; .4 death not pause/completion; .5 stale heartbeat not external termination; .6 one-shot terminal stop | partial | actual running/pausing/paused/stopped and PID exit observed; complete state/recovery matrix pending |
| VAL-REPO-PANEL-LIFETIME | .1 close leaves runner working; .2 reopen same generation/run; .3 reload/disconnect independent; .4 reopen does not start/resume; .5 CLI available without Paseo | partial | disconnected rendering and portable stopped snapshot only; active-run assertions remain pending |
| VAL-REPO-RUNNER-RECOVERY | .1 crash around reservation/spawn/ack; .2 crash around dispatch/acceptance; .3 supervisor versus execution recovery; .4 live/unknown provider blocks duplicate; .5 explicit terminal recovery; .6 PID reuse never signalled; .7 runtime/profile path or bytes drift; .8 publication response loss unique readback or hold | pending | |
| VAL-REPO-DOCS | .1 setup prerequisites; .2 `/delivery`/worktree scope; .3 background and lifecycle distinctions; .4 portable CLI/private state; .5 global UI migration/Python retention; .6 discoverable current verdicts/limitations | partial | Source read-through updated `repository-experience.md`, plugin overview, this matrix, and the evidence README; fresh final-artifact setup/launch read-through and execution remain pending |

## Source-dated native evidence by atomic assertion

All paths below are relative to this directory and were captured before the current post-candidate repairs. “Observed” applies only to the named historical assertion and does not pass its target siblings or the current source. The final validator must retain the failed cancelled-delivery row and add a separate rerun tied to the final hashes.

| Assertion | Verdict | Evidence and boundary |
| --- | --- | --- |
| VAL-REPO-IDENTITY.1 | observed | `native/workspaces.json` plus `native/rpc-workspace-isolation.json` record three real isolated-host workspace IDs and server-resolved repository results. |
| VAL-REPO-IDENTITY.2 | observed | `native/native-no-config-bootstrap.json` records canonical repository, Git root, common directory, worktree, branch and HEAD from the related worktree. Detached HEAD and rejection cases are not covered. |
| VAL-REPO-ISOLATION.1 | observed | `native/native-setup-bindings.json` records distinct protected A/B state roots and owner-only profile mode; `native/rpc-workspace-isolation.json` records isolated repository projections with zero runs. |
| VAL-REPO-WORKTREES.1 | observed | `native/native-no-config-bootstrap.json` and `native/native-setup-bindings.json` show the related A worktree reconnecting to A binding revision 1 without a second setup. No active shared run was exercised. |
| VAL-REPO-WORKTREES.5 | observed | `native/native-no-config-bootstrap.json` exposes the related worktree’s repository, branch, worktree, common directory and HEAD. |
| VAL-REPO-COMMAND.2 | observed | `native/native-setup-import-stopped-desktop.png` shows the native Delivery panel opened for the selected workspace. |
| VAL-REPO-COMMAND.1 | observed | `native/native-observations.json` records the draft composer flow; `native/agent-context-slash.txt` records `/delivery` offered in an existing real Codex agent composer. |
| VAL-REPO-COMMAND.3 | observed | `native/native-observations.json` and `native/agent-slash-panel-error.txt` record repeated invocation retaining one focused Delivery tab. |
| VAL-REPO-COMMAND.6 agent invocation | observed | `native/agent-slash-no-dispatch.json` records the actual SDK agent as idle with identical `updatedAt` before and after `/delivery`; no agent turn was dispatched. Open/refresh/workspace-switch zero-dispatch coverage remains incomplete. |
| VAL-REPO-COMMAND non-Git panel state | observed | `native/agent-slash-panel-error.txt` records native “Delivery is unavailable” and Retry for the intentionally non-GitHub-origin workspace, with no Start control. This supplements identity/setup error-state coverage but does not pass all refusal cases. |
| VAL-REPO-COMMAND compact rendering supplement | observed | `native/native-related-worktree-compact-light.png` and `native/native-related-worktree-compact-dark-final-ui.png` show native compact rendering in both themes. This is not physical-device proof. |
| VAL-REPO-SETUP.2 | observed | `native/native-setup-import-stopped-desktop.png` and the A entry in `native/native-setup-bindings.json` show imported configuration with a stopped runner and no run. |
| VAL-REPO-SETUP.3 | observed | The B entry in `native/native-setup-bindings.json` records owner-only mode, a separate state root, `auto_schedule: false`, and PR/issue publication `off`. |
| VAL-REPO-SETUP.1 | observed | `native/native-observations.json` records the missing-binding setup view before A import and B creation. |
| VAL-REPO-SETUP.4 | partial | `native/native-observations.json` records actionable refusal when A's profile was submitted for B and successful correction. Other unsafe-path prerequisite cases remain pending. |
| VAL-REPO-SETUP.6 | observed | `native/native-observations.json` records an unchanged local effect ledger across both setup operations. |
| VAL-REPO-SETUP.7 | partial | `native/rpc-workspace-isolation.json` records that the private grant was omitted from all workspace DTOs. Global-grant inheritance and authority boundaries still need adversarial proof. |
| VAL-REPO-PANEL-LIFETIME.3 | partial | `native/native-disconnected-compact-dark.png` proves the disconnected native state renders. It does not prove active work continues. |
| VAL-REPO-PANEL-LIFETIME.4 | partial | `native/native-no-config-bootstrap.json` records stopped/no-runs after native bootstrap. Reopen during an active run remains pending. |
| VAL-REPO-RUNNER-CONTROLS.1 | observed | `native/native-observations.json` records one explicit native Start, generation 1, and actual rank and plan processes with unattended scheduling still disabled. The run was later cancelled, so this is not terminal-journey proof. |
| VAL-REPO-RUNNER-CONTROLS.3 | partial | `native/native-observations.json` records a stale first Pause refusal, then accepted `pausing` and stable `paused` after refresh. Reservation-boundary adversarial coverage remains pending. |
| VAL-REPO-RUNNER-CONTROLS.6 | observed | `native/native-observations.json` distinguishes delivery Cancel/released claim from repository Stop, owner acknowledgement and actual PID exit. |
| VAL-REPO-RUNNER-STATE.2 | partial | `native/native-observations.json` directly records running, pausing, paused and stopped. Starting, stopping, blocked and uncertain still need the final matrix. |
| VAL-LOCAL-UI-RECOVERY | observed with limitation | `native/native-observations.json` records retained repository identity and disabled Start while the CLI was unavailable, then successful Reconcile without starting work. |
| cancelled-delivery UI regression | failed | `native/native-observations.json` records stale Resume/unfinished presentation after Cancel then Stop. This must be fixed and rerun; it prevents a final native verdict. |
| VAL-LOCAL-PASEO adapter compatibility | observed | `native/live-paseo-adapter.json` records actual SDK dispatch, reconnect and collect against the isolated host. It explicitly excludes a full provider mission. |
| VAL-LOCAL-PI adapter compatibility | observed | `native/live-pi-adapter.json` records actual Pi 1.5.2 persistent settled collection. Retry, compaction and recovery remain pending. |
| VAL-LOCAL-PI current repair supplement | supporting | `.omx/evidence/repository-delivery/providers-candidate-9/report.md` records the focused real Pi 1.5.2 private-session, legacy-mode, positive-compaction and repeated-start/exit repair checks. It is not final integrated provider/native acceptance. |
| VAL-LOCAL-PACKAGE installed engine | supporting | `packaged/README.md`, `packaged/npm-pack.json` and `packaged/repository-journey.log` bind an earlier source set to a packed tarball, offline production install and passing extracted-package process journey on Node 22.19.0. Current-source packaging, plugin native load and legacy-state refusal remain separate assertions. |

## Retained local-mode targets

All detailed atomic assertions remain in the corresponding `contract/VAL-LOCAL-*.md` file. Each row needs its own final-source verdict and evidence pointer.

| Target | Status | Evidence |
| --- | --- | --- |
| VAL-LOCAL-AUTH | pending | |
| VAL-LOCAL-CHECKS | pending | |
| VAL-LOCAL-CONTROLS | pending | |
| VAL-LOCAL-DISPATCH | pending | |
| VAL-LOCAL-DRAFTS | pending | |
| VAL-LOCAL-E2E | pending | |
| VAL-LOCAL-EXEC | pending | |
| VAL-LOCAL-EXPORT | pending | |
| VAL-LOCAL-GATES | pending | |
| VAL-LOCAL-GIT | pending | |
| VAL-LOCAL-GRANTS | pending | |
| VAL-LOCAL-HANDOFF | pending | |
| VAL-LOCAL-INDEX | pending | |
| VAL-LOCAL-LIFECYCLE | pending | |
| VAL-LOCAL-NATIVE | partial | native desktop/compact light/dark evidence copied; final-source rerun and remaining native assertions pending |
| VAL-LOCAL-PACKAGE | partial | an earlier clean packed engine installation and shipped CLI/Git/HTTP journey passed; final frozen-source packaging plus remaining native/legacy assertions require their own evidence |
| VAL-LOCAL-PARITY | pending | |
| VAL-LOCAL-PASEO | partial | actual adapter compatibility probe only; full mission matrix pending |
| VAL-LOCAL-PI | partial | source-dated settled compatibility plus a current focused real Pi repair run; integrated retry/error/abort/resume/Paseo/native coverage remains pending |
| VAL-LOCAL-POLL | pending | |
| VAL-LOCAL-PUBLISH-ISSUE | pending | |
| VAL-LOCAL-PUBLISH-PR | pending | |
| VAL-LOCAL-RANK | pending | |
| VAL-LOCAL-RECOVERY | pending | |
| VAL-LOCAL-START | pending | |
| VAL-LOCAL-STATE | pending | |
| VAL-LOCAL-UI-RECOVERY | partial | actual CLI-loss/Reconcile behavior observed; cancelled-delivery stale UI failed and needs rerun |
| VAL-LOCAL-UI | pending | |

## Evidence binding

The final validator fills each evidence cell with an artifact path and timestamp tied to the final source/package hashes. Browser screenshots without the correlated workspace, runner revision, process and effect-ledger records are supporting visuals only. Fixture success proves local behavior only; real GitHub publication, merge, deployment, credentials, unattended operation, physical devices and Python retirement remain outside its authority.
