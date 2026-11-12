# Repository Delivery acceptance specification

Planner draft, 2026-11-11. Plan: `.omx/plans/repository-delivery-plan.md`. All assertions below are required; no initial pass inferred from old reports. Owner A is portable-engine executor; B plugin executor; V leader/independent validator. Validation reports must preserve atomic assertion suffixes within each target, so a partial target cannot be marked passed.

## Evidence protocol and fixtures

Create two disposable GitHub-identity repositories A/B, two linked worktrees A1/A2, one independent clone A3, clean local bare remotes, owner-only per-repo profiles/policies/state, fake gh and loopback HTTP service with durable request/effect ledger. Same delivery IDs in A/B deliberately test isolation. Production GitHub URLs are identity strings only; transport/push use protected explicit test fixtures. HTTP server rejects unknown hosts/endpoints and records forbidden mutation attempts. Use a fresh isolated Paseo home, loopback port (proposed 6819), relay disabled, web UI enabled; enable plugin only there. No active-host change or restart.

Capture manifest containing source hashes, package artifact hashes, Node/Paseo versions, fixture paths, process IDs/ownership, exact commands/exit codes, raw logs, normalized state before/after, HTTP/Git refs, screenshot paths and timestamps. Each assertion gets passed/failed/blocked, evidence pointers, surface and limitation. Tests proving a library do not prove installed CLI/native UI. Evidence must be regenerated when relevant source changes. Disposable resources are cleaned up by exact recorded identity; preserve sanitized evidence.

## New repository experience targets

| Target / owner | Atomic acceptance assertions | Required evidence |
|---|---|---|
| VAL-REPO-IDENTITY / A | .1 server obtains directory via refreshed selected-host workspace; .2 resolves canonical GitHub repo/root/branch/worktree/common-dir; .3 detached HEAD explicit; .4 non-Git/missing/ambiguous/malformed/credential-bearing origin refuses; .5 origin/worktree change between read and mutation blocks | Real temp Git commands plus RPC forged-path/repo inputs; before/after identity |
| VAL-REPO-ISOLATION / A+B | .1 A/B profiles/state/runs isolated; .2 controls cannot target other's run or state root; .3 cache/selection/uncertainty isolated by host/workspace/repo; .4 delayed response after switching never displays/controls old repo; .5 matching run IDs across repos remain distinct | Two actual workspaces/panels, RPC adversarial calls, delayed network responses, state and dispatch ledgers |
| VAL-REPO-WORKTREES / A | .1 A1/A2 share binding and active delivery; .2 A3 same canonical repo cannot create alternate root/runner; .3 simultaneous Start has one winner; .4 concurrent pause/resume/stop rejects stale revision; .5 checkout provenance visible without changing shared owner; .6 old foreground and new runner cannot coexist | Separate CLI/RPC processes with barriers, one dispatch/process owner and durable registry/session proofs |
| VAL-REPO-COMMAND / B | .1 `/delivery` offered in draft and agent workspace contexts; .2 opens current workspace native panel; .3 repeated invocation focuses existing tab; .4 workspace switch opens its correct panel; .5 global sidebar entry absent; .6 open/refresh/switch never dispatch | Actual native command interaction and tab counts with zero-effect ledger |
| VAL-REPO-SETUP / A+B | .1 missing binding shows in-panel setup; .2 protected matching profile import validate/save works; .3 structured creation from trusted asset references produces valid private profile with off/off/scheduling false; .4 wrong repo/unsafe path/invalid dependencies show actionable error and remain unready; .5 concurrent setup rejects stale config revision; .6 saving creates no runner/work/publication; .7 existing global config does not silently grant actions | Actual UI setup/empty/error/retry, file modes/config readback, zero dispatch/write ledger |
| VAL-REPO-RUNNER-CONTROLS / A+B | .1 explicit Start creates exactly one run while scheduling off; .2 no duplicate Start on unfinished claim; .3 Pause requests barrier and does not falsely acknowledge while operation in flight; .4 Resume revalidates pins and continues same run; .5 Stop drains then exits while preserving unfinished work; .6 Cancel remains distinct effect-disposition action; .7 request replay is idempotent and changed payload refuses; .8 competing controls serialize | Real installed worker process plus UI/RPC controls, blocked-child fixture, durable request/state/effect ledger |
| VAL-REPO-RUNNER-STATE / A+B | .1 distinguish session vs run stage; .2 running, pausing, paused, stopping, stopped, blocked and uncertain accurate; .3 pending spawn is starting; .4 process death never paused/completed; .5 stale heartbeat is not proof external work stopped; .6 one-shot completion stops without scheduling next issue | Kill/freeze/resume fixture worker, timestamps, independent process checks and native state projection |
| VAL-REPO-PANEL-LIFETIME / A+B | .1 close panel leaves started runner working; .2 reopening reconnects same generation/delivery; .3 plugin reload/client disconnect does not own runner lifetime; .4 reopening never starts/resumes; .5 standalone CLI can inspect/control while Paseo unavailable | Actual native close/reopen and isolated plugin reload/disconnect, same process/session evidence and CLI readback |
| VAL-REPO-RUNNER-RECOVERY / A+B | .1 crash before/after reservation/spawn/ack stays uncertain; .2 crash before/after dispatch/external acceptance reconciles exact existing execution; .3 supervisor recovery distinct from failed execution retry; .4 live/unknown provider prevents duplicate dispatch; .5 explicit safe terminal recovery succeeds; .6 PID reuse/identity mismatch is held and never signalled; .7 changed runtime/profile path or bytes holds; .8 publication response loss yields unique readback or uncertainty, never blind POST | Actual processes/fault injection, real adapter inspection, durable intents and zero duplicate effect ledger |
| VAL-REPO-DOCS / V | .1 setup/import/create prerequisites documented; .2 `/delivery` and worktree scope explained; .3 background lifetime, pause/stop/cancel/recover distinctions explained; .4 CLI portability and private state paths documented; .5 global UI migration and Python retention stated; .6 all acceptance verdicts/limitations current and discoverable | Readthrough against exact source plus reproducible documented setup/launch on fresh fixture |

## Preserved local-mode targets

Each original file in `docs/paseo-delivery-v2/contract/` remains authoritative except the explicitly replaced UI navigation. The following rows identify required scenario sets and evidence; retain detailed subconditions in those original contracts.

| Existing target | Owner | Required fresh scenario/evidence |
|---|---|---|
| VAL-LOCAL-AUTH | A/V | Fake-gh argv/env and HTTP account/repo numeric identity; selected login preserved for reads/dispatch/private Git/writes; ambient token/account drift and secret sentinel rejection |
| VAL-LOCAL-CHECKS | A/V | Real candidate and checker; distinct reviewer approves/rejects; stale/missing checks/review hold; corrective iteration and budget exhaustion |
| VAL-LOCAL-CONTROLS | A+B/V | Real RPC/CLI/UI positive action and missing/forged/stale/repeated/other-repo denial; exact-digest publication and current revision; no privileged endpoints |
| VAL-LOCAL-DISPATCH | A/V | Default-off and forged config refuse; explicit one-shot works without unattended; disposable trusted opted-in positive; one active child/repo; read-only UI zero dispatch |
| VAL-LOCAL-DRAFTS | A/V | Real enqueue/list/show/restart/remove and derived view rebuild; verified PR handoff; private body/secret sentinel omitted from default projection; no external writes |
| VAL-LOCAL-E2E | V | Installed actual Node foreground/repository runner selects/plans/implements/checks/independently reviews/stages/publishes to local Git/HTTP, survives response-loss/restart, waits requested human checkpoints, appears in native UI; separate explicit issue proposal publication |
| VAL-LOCAL-EXEC | A/V | Actual adapter process success/forged envelope/hang/error/cancel; exact repo/run/stage/candidate and phase ordering; time/attempt/concurrency bounds; generic manifest differential corpus |
| VAL-LOCAL-EXPORT | A/V | Export accepted/interrupted state; independent offline CLI consumer without Paseo/private config verifies schema/digest; secret exclusion |
| VAL-LOCAL-GATES | A/V | Original generic review corpus and both corrected stages; four human gate combinations; exact generation/material/base/policy/head; rejected/unavailable/stale review holds |
| VAL-LOCAL-GIT | A/V | Real valid/malicious bundles, intermediate history, modes/paths, ancestry, selected credentials, lease/ref race; before/after bare refs |
| VAL-LOCAL-GRANTS | A/V | Independent PR/issue off/explicit/automatic combinations in fixtures, exact actor/repo/draft grant, policy/content drift invalidation; one authorized fixture positive each kind |
| VAL-LOCAL-HANDOFF | A/V | Requested ready then requested tracking readbacks before claim release; early ready/early label/stale/corrected head hold; no ready/label/review/merge/deploy writes |
| VAL-LOCAL-INDEX | A+B/V | Actual RPC planted secrets/body, traversal/symlinks/corruption/removal/rebuild; valid sources retained beside warnings; no journal/grant mutation/dispatch on reads |
| VAL-LOCAL-LIFECYCLE | A/V | Real process-group SIGINT/SIGTERM, blocked child release, repeated signal and accepted-write response loss; no signals to owned detached child on normal drain, no forcekill/new scheduling |
| VAL-LOCAL-NATIVE | B/V | Official native plugin at desktop and compact, light/dark; keyboard focus and accessible labels; readable exact SHAs; selection/detail/error-retry and all lifecycle controls; screenshots and interaction evidence |
| VAL-LOCAL-PACKAGE | A+B/V | Clean artifact test/typecheck/package/load; audit no Python/SpecKit execution; legacy writable state refused; old Python files preserved |
| VAL-LOCAL-PARITY | V | Every source local contract maps to fresh V2 evidence in parity matrix; legacy differential corpus supporting; no App-only expansion or silent missing behavior |
| VAL-LOCAL-PASEO | A/V | Real isolated SDK/Codex task and output, exact workspace/agent IDs, reconnect/cancel, permission/error/idle/unsupported setting behavior, validated artifact; fake SDK insufficient |
| VAL-LOCAL-PI | A/V | Real installed authenticated Pi task and settlement transcript; current JSONL ordering/compaction/retry/error/abort/resume scenarios plus synthetic event regressions; unavailable auth is blocked |
| VAL-LOCAL-POLL | A/V | Deterministic pacing plus actual failed/pending/success/rate-limit fixture; 15s default, 5m cap except server deadlines, no repeated idle logs, no auto recovery/receipt synthesis |
| VAL-LOCAL-PUBLISH-ISSUE | A/V | Explicit queued exact proposal positive, wrong actor/body/repo, lost response and zero/multiple readback matches; durable intent/rebuild and no auto-delivery |
| VAL-LOCAL-PUBLISH-PR | A/V | Actual Git/HTTP plan create/implementation update, phase-loss/restart, unique versus zero/multiple/truncated/lookalike readback; publication-off manual export/exact binding through normal review gates performs no mutation |
| VAL-LOCAL-RANK | A/V | Complete issue/PR/dependency snapshot; incomplete/open-PR/dependency/no-candidate/next winner; shortlist order, served ledger restart, explicit requeue |
| VAL-LOCAL-RECOVERY | A/V | Killed adapter and live-provider cases; terminal proof before retry, matching installation/runtime/skills/profile absolute identity, same bytes different path held; no PID-only authority |
| VAL-LOCAL-START | A/V | Real bare/explicit foreground process idle/review/missing profile/ambiguous/singleton; viewable setup; sanitized/coalesced logs |
| VAL-LOCAL-STATE | A/V | Private atomic/fsynced state/claims/pins/intents, killed writer, corruption/symlink/legacy refusal, bytes and absolute path drift; derived index not authority |
| VAL-LOCAL-UI-RECOVERY | B/V | Actual native empty/loading/error/stale/disconnected/retry; labelled retained same-repo snapshot, disabled controls until fresh, restored selection, no cross-host fallback/dispatch |
| VAL-LOCAL-UI | B/V | Explicitly supersede all-repo/sidebar navigation with repository `/delivery`; retain run selection, detail, next action, exact revisions/links, checks/freshness/review vs progression/history, desktop/compact selection |

## Execution commands and evidence floors

Baseline and final:

```sh
npm --prefix packages/delivery test
npm --prefix packages/delivery run typecheck
npm --prefix plugins/paseo-delivery test
npm --prefix plugins/paseo-delivery run typecheck
npm --prefix packages/delivery pack --dry-run
npm --prefix plugins/paseo-delivery pack --dry-run
```

Use focused test-name/file runs for changed behavior first. Installed-process fixture harness must invoke the shipped CLI via `process.execPath --experimental-strip-types <installed-cli>` rather than constructing only ForegroundSupervisor. Record executable/package source paths and hashes. A clean installation must include all referenced runtime modules; package dry-run alone is not installation proof. No current lint script exists; static import/no-Python/sentinel checks are separately evidenced.

Fresh isolated host uses `PASEO_LISTEN=127.0.0.1:6819 PASEO_RELAY_ENABLED=false PASEO_WEB_UI_ENABLED=true paseo daemon run --home <fresh-private-home>` with pluginsEnabled true only in that disposable configuration. Verify actual installed supported flags and successful health/plugin load. Browser validates official native app on `http://127.0.0.1:6819/`; existing automation readiness is not acceptance. Never target active default host accidentally.

Native viewport evidence: desktop approximately 1440x1000 and compact approximately 390x844; light and dark. Exercise slash command from draft and agent composer, repeat focus, workspace switching, setup/error/retry, selection, Start/Pause/Resume/Stop, close/reopen, disconnected state and explicit recovery. Keyboard-only access and meaningful labels are required. Native process/provider IDs, state revisions and HTTP/Git effects must correlate with interaction timestamps.

Independent review checks state-machine completeness, ownership fencing before effects, lock/await boundaries, race safety, grants/pins, cross-repo cache/input isolation, migration/packaging and test shortcut risk. Independent real-surface validation records failures without editing implementation. Fixes require relevant rerun and refreshed hashes. Complete only after all assertions pass; blocked external/native criteria remain explicit incomplete and prevent a full-acceptance claim. No real GitHub-write or Python-retirement claim follows fixture success.

## Required review-added race and authority assertions

- VAL-REPO-RUNNER-CONTROLS.9: Barrier-race test pauses/stops immediately before and after transition reservation. Before means zero effects; after permits only the reserved operation to drain and prohibits next-stage dispatch/publication. Assert durable reservation token and owner generation, not just call order in one process.
- VAL-REPO-WORKTREES.7: Kill a mutation-lock owner, race at least two reclaimers, and prove no fresh lock is removed and at most one critical section executes. Ambiguity may fail closed; it may not bypass fencing.
- VAL-REPO-SETUP.8: First-use save creates only repo-bound local lifecycle authority; no inherited publication grant or unattended enablement. Forged setup identity, unsafe asset path and unauthenticated host access refuse. Operational RPCs cannot supply cwd/state/executable; only setup asset references are allowed and validated.
- VAL-REPO-RUNNER-CONTROLS.10: Execute frozen commands/DTOs from `.omx/plans/repository-delivery/runtime-interface.md` through actual CLI and plugin RPC, including invalid/stale/error envelopes and packaged engine path resolution.
- VAL-REPO-RUNNER-CONTROLS.11: While paused/stopping/uncertain, invoke manual publication, dispatch/retry and correction through standalone CLI and plugin RPC; no new external effect bypasses the shared barrier. Safe reads and exact existing-effect reconciliation remain usable; cancellation stays explicitly owned and audited.
