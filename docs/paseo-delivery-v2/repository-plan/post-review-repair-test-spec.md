# Post-review repair acceptance specification

Additive to `.omx/plans/repository-delivery-test-spec.md` and all preserved `docs/paseo-delivery-v2/contract/` assertions. Plan: `post-review-repair-plan.md`. Status: pending sequential Architect and Critic approval. Every numbered assertion below needs its own verdict; aggregate counts do not prove acceptance.

## Evidence rules

For each Rxx.n record candidate source/test/package hashes, surface, exact command/input, request/task/execution/run IDs, before/after protected state and revisions, provider/process observations, effect ledger, result and limitation. A report saying only “test passed” is insufficient. Independent validator does not edit implementation. Fault injection must stop the actual owned process at the named durable boundary, not just throw from a mock; repeat concurrent cases enough to exercise both orderings with explicit barriers. Fixtures record and deny non-loopback HTTP/Git writes. Use two canonical GitHub identities A/B, linked A1/A2, independent clone A3, matching delivery IDs, private per-role adapter state, and a fresh isolated Paseo host. No real issue/PR changes, merges, deployment, credentials or unattended operation.

Unit/mock tests establish exhaustive edge-case logic; installed CLI/child processes establish persistence and race behavior; real SDK/Pi establish provider contract; native desktop/compact interactions establish product state. One surface does not substitute for another. `U` below means focused automated tests, `P` actual installed processes, `S` real isolated SDK/Pi, `N` native app. Where both appear, both are required. Correlate evidence to exact candidate; changed relevant source invalidates old evidence.

## Atomic repair assertions

### R01 — Pi handled prompt (H1; VAL-LOCAL-PI, VAL-REPO-RUNNER-STATE)

- R01.1 [U,S] A safe fixture extension handles the prompt without ordinary agent run. Adapter returns promptly, never waits for nonexistent agent_settled; no duplicate prompt/run on polling/reopen.
- R01.2 [U,P] Extension writes a harmless marker before handled. Outcome records no ordinary run but unknown external disposition; engine holds unresolved claim and visible uncertainty, never `effect:none` or automatic retry.
- R01.3 [U,P] Owned RPC child is closed and awaited; cleanup does not fabricate rollback or mark unrelated session cancelled. Exact process receipt and marker survive.
- R01.4 [N] Handled uncertainty is actionable/readable and never shown as perpetual ordinary running or completed. Controls do not silently relaunch.

### R02 — scoped task identity (H2; VAL-REPO-ISOLATION.5)

- R02.1 [U,S] Same delivery/stage/attempt/revision/candidate in A/B yields different task IDs for agent and independent reviewer; same-host workspaces/agents/branches/results stay disjoint.
- R02.2 [U,P] Persisted pre-repair execution intent resumes its exact old ID and external identity without creating a newly hashed task. Include old reviewer intent.
- R02.3 [U] Case-normalized canonical repository yields stable IDs; stage/delivery differences remain distinct. IDs appear in exact manifest/producer/review checks, not only labels.

### R03 — publisher binding and migration (H3; VAL-REPO-SETUP, ISOLATION, VAL-LOCAL-STATE/PUBLISH-PR)

- R03.1 [U,P] Concurrent separate setup processes for A/B using the same canonical publisher root have one binding winner; loser performs no publication/overwrite. Alias/symlink variants cannot bypass checks.
- R03.2 [U,P] Same delivery ID in separately bound A/B roots creates distinct intents/manual handoffs; neither overwrites other's bytes or lock.
- R03.3 [U,P] Editing existing profile publisher root blocks readiness and effects; registry keeps frozen old root reserved. Attempt to bind old/new root from B cannot exploit config drift or unreadable legacy config.
- R03.4 [U,P,N] Legacy missing-root binding is visible/unhealthy; read/status does not migrate. Explicit same-profile/current-revision in-panel import freezes original root. Hash all existing intent/push/manual-handoff files before/after: same absolute locations and bytes, unchanged grants/scheduling.
- R03.5 [U,P] Wrong profile, changed root, stale revision, active runner/reservation, conflicting legacy binding and unsafe path reject migration with zero moved/copied/deleted intents. An inactive unfinished intent survives permitted migration and requires existing explicit recovery gates.

- R03.6 [U,P] Change publisher config/root before attempting legacy migration while retaining the same profile path. Protected prior runtime/config pins expose mismatch; migration refuses and old intent paths remain reserved. Missing provenance also holds. Separate proven never-started binding with initial protected ledger and complete empty authoritative inventory imports successfully; missing files alone cannot authorize that branch.

- R03.7 [P] Actual legacy/unbound CLI repo B profile targets publisher root frozen/admitted to A: foreground, dispatch/review, publication/export/manual handoff and issue publish/retry reject before effects. Wrong-repo Paseo source rejects before SDK connection. Parameterize every effect-capable CLI entry point; read-only inspect still works.
- R03.8 [P] Race separate-process bind for A against legacy effect admission for B on the same root with explicit barriers. One admission wins under shared registry mutex; loser performs zero mutations. Repeat with unresolved legacy intent: root remains reserved through recovery, not released by process exit.
- R03.9 [P] Clean unbound standalone profile with unclaimed root successfully executes existing foreground/dispatch and local fixture publication paths through shared admission; no panel setup requirement, no automatic scheduling, no duplicate runner. Same-repo repeated admission remains compatible.

### R04 — protected exact Pi run evidence (H4; VAL-LOCAL-PI/STATE/RECOVERY)

- R04.1 [U,P,S] Exact owned run observes settlement, persists bounded terminal receipt, restarts adapter, returns same outcome/result without new prompt or last-text inference.
- R04.2 [U,P] Valid stale assistant JSON plus active+idle, missing receipt, corrupt receipt, legacy session-only ID, missed settlement, or agent_end alone never completes; each remains uncertain.
- R04.3 [U,P] Cross-role/root/run/session/task/repo receipt swaps, forged provider-returned receipt paths, traversal and symlinks are rejected. Assert no unauthorized file read/write or adopted result.
- R04.4 [U,P] Two processes race same canonical session: one active owner. Live/unknown owner cannot be stolen; exact run/command ordering excludes prior-run events. Session reuse after terminal run does not alter old receipt.
- R04.5 [U,P] Crash before intent persistence, after intent before send, after send before ACK, ACK before save, terminal event before ACK, and settlement before durable receipt each has explicit outcome. Only durable exact proof completes; uncertain windows never resend automatically.
- R04.6 [U,S] Error/length/abort, failed retry finalError, successful retry after failed attempt, compaction and queued continuation preserve exact run outcome. Negative control: intermediate assistant JSON and agent_end cannot beat later failure. Real installed-provider events support documented paths; deterministic synthetic events cover difficult branches and are labelled synthetic.
- R04.8 [P] Fresh adapter while original Pi runtime/session remains live launches zero additional RPC children and sends zero prompts. Inaccessible original stream stays uncertain/running only as proven; dead parent without terminal receipt stays uncertain. Terminal receipt lookup starts no Pi process. Same owned runtime abort followed by explicit new run and fresh-adapter terminal receipt resume remain functional.
- R04.7 [U,P,S] Abort targets only owned active run, persists exact abort ACK/settlement evidence; stale/other-run aborted event is refused. Child exit alone never fabricates successful delivery or no extension effects.

- R04.9 [P] Concurrent executor/reviewer processes with different per-role receipt roots target the same canonical session: shared protected owner key yields one runtime owner. Repeat across two profiles, aliases, and foreign installation provenance; no second runtime/prompt or receipt cross-read. Terminal owner releases only exact token.

### R05 — cancellation fencing and claim release (H5; VAL-REPO-RUNNER-CONTROLS/RECOVERY)

- R05.1 [U,P] Hold worker collect, request Cancel, then complete exact external cancellation. Cancellation persists intent first; no new stage/dispatch/publication. Claim releases once only after exact terminal proof and operation drain.
- R05.2 [U,P] Hold dispatch before external-ID return, request Cancel, then return accepted ID. ID is durably retained while cancel pending and exactly cancelled/reconciled; claim cannot release early and work cannot become orphaned.
- R05.3 [U,P] After claim release inject delayed collect/dispatch/reviewer/checker callbacks. Full authoritative state/journal byte hashes and revisions remain unchanged; no new unresolved marker or runner resurrection.
- R05.4 [U,P] Hold publication command after possible effect, request Cancel. No release until exact publication disposition/drain; response loss remains uncertain without blind repeat. Concurrent different commands cannot bypass cancellation barrier.
- R05.5 [U,P] Kill cancel owner before/after adapter ACK and before/after journal receipt/release. Exact same request reconciles once; changed digest/live/unknown owner refuses. Lost proof keeps claim, not invented success.
- R05.6 [P,N] Stop drains supervisor but retains unfinished claim; zero adapter cancel calls. Reopen shows same run and explicit Resume. Cancel remains a separate action with accurate pending/uncertain state.

- R05.7 [P,S] Hold live Pi dispatch/collect in worker, request Cancel from separate CLI while main await is blocked. Concurrent watcher on original adapter receives durable epoch, cancels exact live run, records receipts/drain and exits. Zero cloned RPC runtimes; request observer death and same-request takeover do not duplicate cancel.
- R05.8 [U,P] Race final claim release against dispatch acceptance, command completion and reservation takeover. Repository-lock→engine-lock fence admits release only after exact current tokens/epoch/drain; instrument tests to prove no awaited provider/process operation inside either critical section and no reverse lock order.
- R05.9 [P,S,N] Request Stop during an active Pi run. Original controller and Pi remain owned/live and UI stopping until natural settlement; durable receipt precedes orderly child/controller exit. No abort and no orphan. Reopen/Resume uses same delivery and existing receipt, no repeated prompt. Separate run: Cancel during stopping interrupts via watcher and releases only with proof.

### R06 — typed reservations and dead-owner takeover (H6; VAL-REPO-WORKTREES/CONTROLS/RECOVERY)

- R06.1 [U,P] Worker/command/cancel records include variant, exact PID/start identity, token and required generation/request fields. Legacy untyped record is uncertain; command-prefix guessing never clears it.
- R06.2 [P] SIGKILL command after reserved but before effect intent. Exact same request + proven dead owner takes CAS ownership and finishes once; journal confirms no prior effect. Worker remains live/observable while waiting.
- R06.3 [P] SIGKILL after phase:effect before journal intent; same-request reconciliation proves no effect from protected journal before continuation. Phase flag alone never grants replay.
- R06.4 [P] SIGKILL after engine intent, external acceptance and result persistence in separate cases. Same request reconciles authoritative journal/readback; durable effect count at most one; unfinished unknown effect remains held.
- R06.5 [U,P] Different request/input, PID reuse, live owner, inaccessible/unknown identity and stale token cannot take over/clear reservation or signal arbitrary PID. Old owner late finally cannot clear successor token.
- R06.6 [P] Identical completed request replay returns stored result despite advanced current revision; changed payload under reused ID refuses. Concurrent same-request callers have one owner/effect.
- R06.7 [P,N] Pause/Stop while command pending reports draining, never falsely paused/stopped; heartbeat stays accurate. Resume cannot pass uncertain reservation. Exact completion permits drain/stop acknowledgement.

### R07 — configured Paseo source (H7; VAL-REPO-IDENTITY/WORKTREES/SETUP)

- R07.1 [U,P,S] A profile with Paseo executor source B refuses setup/Start before SDK connection/create. Repeat with reviewer source B; zero create counters in isolated host.
- R07.2 [U,P,N] A1/A2 and independent A3 view/control same binding and configured source A. A3 commonDir differs legitimately; no false source mismatch or alternate runner.
- R07.3 [U,P] Configured source origin/path/commonDir drift blocks effect-capable loads. Branch/base pin checks remain enforced; generic executable/Pi cwd is not subjected to unrelated Git constraints.

### R08 — exact Paseo adoption (H8; VAL-LOCAL-PASEO/RECOVERY)

- R08.1 [U,S] Exact protected creation intent and one exact SDK/Git match reconnect without duplicate agent/workspace. Validate real refresh/current field shapes, deterministic agent ID, repo/delivery/task/provider/model and workspace branch/source.
- R08.2 [U,S] Zero legitimate matches with no ambiguous prior acceptance creates once; lost create response reconciles existing exact resource. Partial workspace creation is retained and reconciled, not silently abandoned/recreated.
- R08.3 [U,S] Duplicate matches, title-only, spoofed labels, wrong deterministic ID/repo/commonDir/provider/model/branch and untrusted legacy intent refuse adoption/create/archive. Each negative has zero-mutation ledger.
- R08.4 [U,S] Agent commits descend from pinned baseline: reconnect succeeds even though HEAD advanced. Unrelated ancestry or switched source refuses. Fresh creation still requires exact baseline.
- R08.5 [U] No use of nonexistent public runtimeConfig/providerOptions or original workspace base fields; unsupported validation requires protected intent/fresh Git evidence, never guessed SDK data.

### R09 — refusal and owned child cleanup (H9; VAL-LOCAL-EXEC/PI/PASEO)

- R09.1 [U,P,S] Known provider/model/local validation refusal before prompt/create is terminal no-effect, no unresolved external identity, explicit retry permitted. Any owned Pi discovery child exits and is awaited.
- R09.2 [U,P] Pi prompt rejection after a fixture hook writes marker is unknown effect, not no-effect. Timeout/lost response after possible acceptance stays uncertain and never triggers duplicate run.
- R09.3 [P] Repeated refusal/timeout/cleanup cases leave no unowned child/process group; cleanup targets only recorded owned child. Unable-to-prove shutdown produces uncertainty, not fabricated receipt.

### R10 — outcome attestation (H10; VAL-LOCAL-EXEC/PASEO/RECOVERY)

- R10.1 [U,P] Exact terminal failure/cancel/owned executable timeout clears only matching execution unresolved marker for agent and reviewer; explicit safe retry/cancel completes without phantom task.
- R10.2 [U,S] SDK wait timeout leaves actual provider run alive/reconnectable. Permission and lookup/observer error are nonterminal/unknown, never terminal solely from status.
- R10.3 [U,S] Successful Codex archive ACK yields terminal owned-runtime proof; termination failure and lost ACK with archivedAt visible remain uncertain. Preserve claim until authoritative proof, no timestamp shortcut.
- R10.4 [U] Contradictory tuples, unknown legacy output, missing exact proof, wrong execution proof and success-with-unknown-effect refuse/normalize conservatively. No stage result bypasses manifest/check/review validation.
- R10.5 [U,P] Normal completed exact run transitions once; duplicate terminal receipt idempotent. Other unresolved effects remain held. Non-Codex provider shutdown is not assumed from Codex-specific source evidence.

- R10.6 [U,P] CLI/worker sends forged proof ID/path/raw receipt or swaps exact context. Trusted adapter resolver refuses; no claim release/stage advance. Public DTO/index/export exclude absolute proof/session paths and raw private texts, while safe statuses/digests remain readable.

### R11 — phase-aware publication refusal (M11; VAL-LOCAL-AUTH/PUBLISH-PR/PUBLISH-ISSUE)

- R11.1 [U,P] Initial AUTH_MISMATCH/REPO_MISMATCH before possible Git/HTTP effect is known failure, zero mutating HTTP/Git effect ledger (identity GETs allowed), no phantom unresolved publication; corrected authorized explicit retry works in local fixture.
- R11.2 [U,P] Same error after push/possible accepted POST preserves pushed branch/ref and intent bytes, remains uncertain pending exact readback. No duplicate push/POST or discarded receipt.
- R11.3 [U,P] Apply both cases to issue proposal and PR publication; publication-off/grant/digest/candidate/independent-review gates still reject unauthorized/stale operations.

- R11.4 [U,P] Concrete Publisher emits trusted phase/intent attestation before surfacing initial/refetch identity refusal. Forged caller phase and generic error-code-only response cannot authorize no-effect; corrupted/mismatched protected intent stays uncertain. Cover initial and recovery paths for PR and proposal as mandatory tests.

## Integration and full-acceptance floor

- I01 [P] Build/install packed artifact into fresh fixture location and execute real CLI through Node. Complete rank/plan/implementation/check/independent review/local Git+HTTP publication journey with exact candidate artifacts and requested human checkpoints. Include response-loss/restart; no direct-engine-only substitution.
- I02 [P,N] Two repositories plus A1/A2/A3: isolated profiles/control/state, shared same-repo ownership, repeated `/delivery` focus, workspace switching, setup and root migration, no open/save dispatch. Native desktop approximately 1440×1000 and compact 390×844, light/dark, keyboard/labels.
- I03 [P,N] Native Start/Pause/Resume/Stop/Cancel, panel close while explicitly running and reopen same generation, disconnected/error/loading/empty states, process loss then explicit safe recovery. Accurate session vs delivery state and no automatic resume.
- I04 [P] Exact candidate mismatch, forged/stale checker/review/producer evidence and missing publication grant/digest prevent effect. Independent reviewer identity stays distinct; two repositories with identical run IDs cannot share receipts.
- I05 [U,P] Full engine and plugin tests/typechecks, package content/import/no-Python/static checks; no test exclusions. Record missing lint script explicitly. Read docs against final behavior and retain Python.
- I06 [review] Independent code review checks all11 findings plus new ownership/receipt/migration boundaries. Per-original-criterion matrix retains all 28 local and10 repository targets, atomic suffixes, passed/failed/blocked and evidence limitations. No full-acceptance claim if any required criterion is unproven.

## Commands and lane handoff

Use existing package scripts and focused test files before full checks:

```sh
npm --prefix packages/delivery test
npm --prefix packages/delivery run typecheck
npm --prefix plugins/paseo-delivery test
npm --prefix plugins/paseo-delivery run typecheck
npm --prefix packages/delivery pack --dry-run
npm --prefix plugins/paseo-delivery pack --dry-run
```

Lane A owns adapter tests R01/R04/R08/R09 and provider side R10. Lane E owns engine assertions R02/R05/R10/R11. Lane R owns binding/real-process control R03/R06/R07 and barrier side R05. Shared scenarios have one written test owner; other lanes supply fixtures/contracts without editing that file. Parent assigns independent validators after integration. Store sanitized evidence under `.omx/evidence/repository-delivery/` in new candidate-specific paths; never overwrite candidate6 reports. Cleanup exact owned fixtures/processes only. Acceptance requires fresh actual observations, not this plan or upstream source facts alone.
