# Local developer-mode implementation ownership

Historical migration working plan, superseded by the accepted C31 implementation and the separately authorized Python retirement. Active/open/pending wording below records the earlier planning state. See [current validation and retirement](validation.md) and the [final acceptance snapshot](evidence/repository-experience/final-acceptance.md).


User scope correction: only planned local mode is replaced. Prior App-parity ownership and acceptance are superseded. Corrected local-source contracts passed two sequential independent reviews, with focused revisions between them. This ownership is now active. All28 local targets retain real-surface evidence requirements; there are no active App-only requirements.

| Lane | Exclusive files | Active targets |
| --- | --- | --- |
| Engine | packages/delivery core/types/policy/reviews/store/engine/CLI/projection, metadata and core tests | START, DISPATCH, STATE, RECOVERY, LIFECYCLE, RANK, POLL, GATES, CHECKS, DRAFTS, GRANTS, HANDOFF, INDEX, CONTROLS, EXPORT, PACKAGE, PARITY, E2E |
| Local publisher | packages/delivery github/publisher/trusted-git/verifier and publication tests | AUTH, GIT, PUBLISH-PR, PUBLISH-ISSUE |
| Executors/native dashboard | packages/delivery executors and its tests; plugins/paseo-delivery | EXEC, PASEO, PI, UI, NATIVE, UI-RECOVERY |

Parent owns integration/differential tests, original-local scenario mapping and final evidence; independent reviewer validates source/state/security behavior; real native/provider validation remains required. Individual targets retain separate verdicts even when one lane implements them together. No App-only task remains active.

Repository experience ownership, November 11, 2026: engine lane owns canonical Git identity, protected binding, repository runner/session lifecycle, CLI and process regressions. Plugin lane owns workspace resolution, `/delivery`, native setup/control/projection and scoped query state. Validation lane owns `test/fixtures/repository-host.ts`, the installed CLI journey, repository-experience documentation and source-bound evidence. Parent integrates and runs independent review plus official native-host validation. These lanes share the frozen CLI/DTO contract in `.omx/plans/repository-delivery/runtime-interface.md`; no lane may create a second repository engine or weaken the final per-criterion evidence floor.

## Continuation milestone

The custom-plugin continuation hardened all three lanes, added the real Git/HTTP/detached-executor foreground fixture journey, and passed 155 delivery tests plus 2 plugin boundary tests and both typechecks. The six previously identified engine blockers were repaired; the final cancellation retry defect received a bounded independent approval. The active Paseo host has a separate read-only preview, and the isolated validation daemon was stopped gracefully after testing. Full contract closure, installed foreground/live-model mission qualification, compact/theme recovery coverage and Python retirement remain open as detailed in [validation.md](validation.md).
