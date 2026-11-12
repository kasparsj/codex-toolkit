# Repository-scoped Paseo Delivery plan

Planner draft, 2026-11-11. Product edits require sequential Architect and Critic approval. Acceptance: `.omx/plans/repository-delivery-test-spec.md`. Context: `.omx/context/repository-delivery-20261111.md`.

## Outcome and constraints

`/delivery` opens or focuses one native panel in the current Paseo workspace. Backend-resolved repository identity scopes configuration, runs, controls and one portable runner across worktrees. Opening never starts work. Closing leaves explicitly started work running; reopening observes durable state. Process loss is uncertain until explicit safe recovery.

Implement in TypeScript/TSX, reuse the existing engine, retain Python rollback/reference. Preserve unrelated dirty/untracked work. No remote GitHub issue/PR mutation, merge, deployment, credential change, active-host restart or unattended enablement. Test on disposable repositories, local Git/HTTP fixtures and a fresh isolated Paseo host. Historical green tests/reports are supporting evidence only. The latest user request supersedes global/multi-repo UI in the old mission and VAL-LOCAL-UI; all other local-mode contracts remain active.

## RALPLAN-DR

Principles: backend resolves identity; portable engine owns state/work; explicit fenced intent precedes effects; uncertainty holds; acceptance requires current real-surface evidence.

Drivers: repository/worktree isolation; independent runner lifetime and recovery; preservation of candidate/review/publication safeguards with minimal new infrastructure.

| Option | Strength | Cost/risk | Decision |
|---|---|---|---|
| A. Portable detached Node runner with protected durable controls | Panel/plugin independent; CLI works without Paseo; reuses foreground engine | Requires ownership, launch reservation and recovery protocol | Select |
| B. Plugin backend owns supervisor | Less process plumbing, existing SDK connection | Plugin reload/crash owns work lifetime; couples methodology to Paseo | Reject as owner; backend launches/observes only |
| C. Paseo scheduled agent/service owns delivery | Host lifecycle facilities | Host-specific authority/state and accidental scheduling semantics | Reject; retain Paseo only as executor adapter |

Strongest alternative B is attractive for a read-only preview, but cannot fulfill independent durable ownership. A is not a permanent daemon: only explicit Start creates a process; explicit Stop or one-shot completion exits it.

## Grounded evidence and verified APIs

Inspected engine `config.ts`, `cli.ts`, `foreground.ts`, `store.ts`, `engine.ts`, `executors.ts`, plugin entries/backend/RPC/dashboard, current tests, mission/validation and all 28 active contracts. Existing panel discards workspaceId; global sidebar enumerates configured repos; no runner/session setup or lifecycle. Claims are isolated only inside a state root; profile/state-dir can disagree. Foreground reclaims dead-PID locks automatically. Recovery lacks complete external reconciliation. Existing full fixture calls `tick()` rather than installed process.

Installed Paseo CLI/plugin/client: 0.15.4. Verified upstream commit `47a746318262364dd0f2122e3944869b6ce195f5`.

- [Official plugin reference](https://paseo.sh/docs/plugins/reference.md#slash-commands): workspace `addSlashCommand({name:'delivery',description,argumentHint:'',context:'workspace',onSubmit({openPanel}){openPanel('delivery')}})` and `addWorkspacePanel`.
- [SDK workspaces](https://paseo.sh/docs/sdk/reference.md#clientworkspaces): `const handle=paseo.workspaces.ref(workspaceId); const descriptor=await handle.refresh();` reject missing/archiving; cwd is `handle.directory` or `descriptor.workspaceDirectory`.
- [Server context](https://github.com/getpaseo/paseo/blob/47a746318262364dd0f2122e3944869b6ce195f5/packages/plugin/src/server/contracts.ts) provides only `{paseo}`. Client workspaceId is a selector, not current-view attestation or authorization. Never trust client cwd/repo.
- [Panel identity](https://github.com/getpaseo/paseo/blob/47a746318262364dd0f2122e3944869b6ce195f5/packages/app/src/workspace-tabs/identity.ts) and [layout actions](https://github.com/getpaseo/paseo/blob/47a746318262364dd0f2122e3944869b6ce195f5/packages/app/src/stores/workspace-layout-actions.ts) reuse/focus a stable per-workspace panel. No second tab registry.
- [Host configuration](https://paseo.sh/docs/configuration.md), [web UI](https://paseo.sh/docs/web-ui.md): fresh private home, loopback listen, relay disabled, web UI enabled; every mutation explicitly targets isolated home/host. Do not use newer subscription RPCs absent from installed version.

## Architecture decisions

### Repository identity and shared bindings

Add portable `packages/delivery/src/repository.ts`. Using server-resolved directory and argument-array Git commands, resolve real worktree root, absolute common Git directory, branch (explicit detached HEAD), HEAD and strict canonical GitHub origin. Support normal GitHub SSH/HTTPS formats; reject missing/ambiguous/non-GitHub/credential-bearing origin and non-Git directories. Fixture repositories can have GitHub origin identity and a separately protected local publisher remote.

Repository key is canonical GitHub identity, not branch/workspace/worktree. A versioned owner-controlled registry outside Paseo binds one repo to one profile/state root; worktrees and clones of that identity share it. Retain common Git dir/worktree as local provenance. Reject alternate roots or conflicting bindings, especially active/unresolved runs; no automatic merging. Every mutation refreshes workspace/Git and compares binding revision; changed origin, removed checkout or profile mismatch blocks execution.

### Configuration and in-panel setup

Reuse LocalProfile, foreground policy, publisher config and pins. Registry lives under existing Toolkit configuration root with explicit test override. Files/ancestors are owner-controlled, atomic and symlink checked. Registry does not elevate publication authority.

Panel displays repository/branch/worktree and setup state before configuration exists. Setup selects/imports a protected profile, suggesting `defaultProfilePath(repo)`, validates dependencies and saves binding with expected config revision. Additionally support structured creation from existing protected policy/publisher assets, skills root and executor/checker/reviewer configuration references, producing a protected LocalProfile and off/off/auto_schedule=false foreground policy. Do not expose raw executable JSON or credentials. Reuse existing profile loaders and show precise missing/invalid prerequisite fields. No policy invented, no account change, no dispatch during validate/save. Existing global dashboard configuration may suggest compatible paths but never automatically grants controls or enables scheduling. Save and Start are distinct.

### Runner ownership and controls

Add portable session/controller module and Node worker entry or narrow CLI runner subcommand, reusing ForegroundSupervisor transitions. Plugin starts a detached Node process with fixed trusted module/executable, scrubbed environment, explicit cwd and private bounded log. It owns no ongoing work in memory.

Durable per-repo record: schema, repository/binding, revision, owner generation/token, requested/observed state, launch worktree, process identity, heartbeat, active delivery, source/profile/runtime pins, request ledger and sanitized reason. Reuse protected atomic/fsynced storage and short repository locks; never hold synchronous lock during external await. Write launch reservation before spawn; worker acknowledges exact reservation and checks ownership before each new transition. Crash between reservation/spawn/ack is uncertain, never an automatic second start.

Start/Pause/Resume/Stop/Recover are revision-bound and request-idempotent; changed content with reused request ID refuses. Race separate processes/worktrees against same session. A PID and heartbeat are observations, not execution-completion proof. Never signal an arbitrary persisted PID; worker observes durable control requests. Saved uncertain owner cannot be automatically stolen. Existing foreground CLI participates in same ownership so old/new paths cannot run concurrently.

Start creates one explicit run (selected issue or rank-next), with unattended scheduling off, then supervises it. Existing unfinished claim permits Resume/Recover, not duplicate Start. One-shot terminal completion exits; it does not select another issue. Existing explicitly opted-in policy remains a supported separate engine capability, tested only in disposable fixtures without enabling real unattended operation.

### Lifecycle and recovery

| State | Semantics |
|---|---|
| stopped | Initial idle or acknowledged clean stop; no live acknowledged owner; unfinished run requires explicit resume |
| starting | Reserved launch awaiting matching worker acknowledgement |
| running | Owner acknowledged; supervising/waiting at review gates; delivery stage shown independently |
| pausing/stopping | Barrier accepted; no new stage/dispatch/publication; drain already-started operation to durable boundary |
| paused | Owner acknowledges safe boundary and no new transitions; explicit resume revalidates pins |
| blocked | Known prerequisite/pin/identity/gate failure with reason |
| uncertain | Lost/unresponsive owner, incomplete launch or unresolved effect; requires explicit reconciliation/recovery |

Pause/Stop never claim completion while owned operation remains unresolved. Drain may collect existing executor/check/publication but cannot dispatch next phase. Stop exits supervisor and preserves unfinished delivery; Cancel remains separate existing operation requiring effect disposition. Panel close is not Stop. Repeated SIGINT/SIGTERM cannot force normal drain; forced loss retains claim/intents.

Recovery inspects recorded adapter/provider identity and publication intents. Reattach only to existing exact execution under matching pins after explicit recovery; collect terminal results; reset only after proven terminated work. Missing identity, ambiguous publication match, unknown process or unresolved intent stays uncertain. Supervisor recovery and delivery execution recovery are separate decisions. Process death alone never proves external termination. Do not automatically reclaim legacy foreground session locks.

### RPC and native view

Remove global screen/sidebar registrations from primary workflow; register workspace panel plus slash command. Retain React Native primitives, Paseo theme tokens and existing detailed evidence components. No Python/browser bridge.

RPC inputs use workspaceId, expected config/session/run revision, action/requestId and exact draft digest where needed. Server refreshes workspace, resolves Git, applies binding and protected grants; refuse client repo/path/executable override and cross-repo run identity. No merge/ready/review/deploy endpoints.

Cache, selection, mutation, uncertain request and tab state keys include host/workspace/resolved repo. Never render previous-repo data during switching. Same-workspace retained state is labelled disconnected and read-only until successful refresh. Header shows repo/branch/worktree plus runner status; run stage remains separate. Provide setup, start, pause/resume, stop and safe recovery controls, with explanation that started work continues after close. Retain exact candidate/check/review/freshness/history/private-draft distinctions and existing granted run actions.

## Retain/adapt/remove

| Capability | Treatment |
|---|---|
| Engine transitions, manifests, exact review/check gates, pins, budgets | Retain; patch only demonstrated acceptance gaps |
| Store claims/projection/export | Reuse; session/registry records and state-root consistency |
| Foreground CLI/supervisor | Adapt shared ownership, explicit one-shot start, barriers, coalesced logs/recovery |
| Executable/Paseo/Pi adapters | Retain; narrow inspect/reconnect reconciliation fixes as required |
| Publisher/trusted Git/proposal spool | Retain safeguards, independently prove fixture behavior |
| Dashboard detail/evidence/checks | Reuse inside repository panel |
| Global sidebar/screen and all-repo filter | Remove from primary plugin flow; explicitly supersede old UI contract |
| Existing dashboard config | Explicit compatible import, no automatic authority migration |
| Python and previous reports | Preserve reference/rollback; historical evidence only |

## Ordered implementation and ownership

1. Save reviewed plan/test specification, exact sequential review evidence and execution handoff. Record dirty baseline and update mission/UI override and acceptance inventory. Prepare fresh isolated host and fixture seams.
2. Executor A owns portable repository/config/session modules, CLI/foreground changes and related process tests. Stabilize DTO/CLI contracts first; implement shared root/ownership, lifecycle barriers and recovery. Coordinate any engine edits with leader.
3. Executor B owns plugin server/RPC/client/index and tests after interfaces stabilize: workspace resolution, setup, lifecycle forwarding, scoped view/slash focus. A and B must preserve each other's edits and unrelated dirty work.
4. Leader/validation lane owns reusable installed-process Git/HTTP journey, isolated native host validation and docs/evidence. Real provider probes are not a substitute for complete journey. Run per-criterion scenarios in test spec.
5. Independent code-reviewer/architect and real-surface validator inspect/exercise final source. Fix findings in owning lanes, rerun relevant checks and invalidate stale evidence. Final report states implementation, usage, background semantics, per-criterion verdicts and limitations.

Sequential Planner → Architect → Critic before any product edit. Use bounded parallel native agents only for disjoint work. Durable execution via supported Ultragoal or documented App-safe workflow; runtime metadata never substitutes for approval or evidence.

## Pre-mortem

1. Duplicate work from two worktrees/roots: registry binding, launch reservation, generation fencing and request ledger; race real processes and assert one dispatch.
2. Death after external acceptance followed by duplicate retry: protected pre-effect intent, uncertain projection, exact adapter/readback reconciliation; kill at each boundary and assert unique effect or explicit hold.
3. Workspace switch applies stale control to wrong candidate: re-resolved server identity, scoped cache/mutation key, revision checks; delayed responses and identical run IDs across two repos must remain isolated.

Other risks: synchronous checks can delay heartbeat (do not infer death solely from expiry); provider work may outlive supervisor; legacy CLI bypass could defeat singleton; setup prerequisites may be unavailable; source changes invalidate pins/evidence. Missing real native/provider evidence blocks its criterion, not a reason to reduce scope.

## Verification and stop condition

Run targeted tests, then both package test/typecheck scripts; package dry-run and installed artifact CLI/plugin load; static no-Python/client-boundary checks and secret-sentinel scan. No lint script currently exists: disclose rather than invent pass. Exact commands and per-contract scenarios are in companion test spec.

Complete only with all agreed criteria freshly evidenced on their required surfaces, independent review findings fixed, usage/setup/recovery docs updated and unrelated changes preserved. Practical unavailable external/native capability stays explicit blocked/incomplete; never silently relabel acceptance or retire Python. No live GitHub write qualification is claimed.

## Review clarifications and frozen implementation seam

The portable command/DTO contract is `.omx/plans/repository-delivery/runtime-interface.md`, incorporated into this plan. Engine lane owns `workspace-status`, `workspace-setup`, `runner-control`, `workspace-command` and their envelope/DTO; plugin lane consumes them through fixed trusted argv and stdin JSON. Only setup accepts protected asset paths. Operational directory comes from refreshed SDK workspace. Trusted registry override is `DELIVERY_REGISTRY_DIR`, never RPC input. Field changes must be agreed before either lane implements consumers.

Linearization: worker acquires the same repository mutation lock used by lifecycle controls, checks generation/desired state, and durably reserves exactly one transition with an in-flight token before releasing the lock and awaiting external work. Pause/Stop accepted before reservation prevents it; accepted after reservation drains that already-reserved operation only. Completion records the reservation result under current generation; next-stage reservation requires another lock/check. A loop-level check alone is insufficient.

Lock correctness: repair `FileStateStore.withRepoLock` stale-owner reclamation so two contenders cannot unlink a newly acquired owner. Use an exact-owner revalidated, serialized reclaim protocol or fail closed on ambiguous stale lock, with explicit recovery. Never remove a lock based solely on an earlier liveness read. Engine lane owns this correction and a killed-lock/concurrent-contender regression.

Authority bootstrap: plugin RPC clients are trusted authenticated clients of the selected Paseo host, not arbitrary unauthenticated web callers. Explicit first-use setup validate/save on that host creates a repo-bound local lifecycle capability in protected registry; the setup UI discloses that Start/Stop controls become available for that repo. It grants no GitHub publication permission and does not import existing global operator grants automatically. Starting remains a separate explicit action. Existing run-level publication controls still require existing protected grant/policy/exact-digest checks. Server checks live host workspace and protected binding for each action; workspaceId alone does not grant arbitrary filesystem execution. CLI lifecycle operations run under the same local owner and registry, independent of Paseo.

All manual CLI/RPC run actions that begin new external effects participate in the same repository owner/generation/barrier reservation protocol, including publication, correction dispatch and retry. They cannot bypass paused/stopping/uncertain session controls through a separate engine entry point. Safe reads and reconciliation of an already-recorded effect remain available without starting another effect; explicit cancellation retains its distinct owned effect-disposition path. Test both UI-originated and standalone CLI-originated attempts while paused/stopping.
