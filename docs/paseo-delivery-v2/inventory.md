# Local-mode scope inventory

This inventory replaces the superseded App parity catalog after the user's explicit scope correction. No App token/installation/OAuth requirements remain active.

| Local actor surface | Active contract IDs | Reference |
| --- | --- | --- |
| Foreground launch/setup/logging and singleton | VAL-LOCAL-START, VAL-LOCAL-DISPATCH | Foreground plan START/DISPATCH |
| Persistent state, pins, claims, process/remote recovery | VAL-LOCAL-STATE, VAL-LOCAL-RECOVERY | Local foreground lifecycle and existing coordinator semantics |
| Ctrl-C/drain and publication cancellation crossing | VAL-LOCAL-LIFECYCLE | Foreground LIFECYCLE |
| Rank coverage, serviced IDs, explicit repeat | VAL-LOCAL-RANK | Foreground DISPATCH/POLL |
| Fresh polling/backoff/verification limits | VAL-LOCAL-POLL | Foreground POLL |
| Exact-head plan/implementation gates, corrections | VAL-LOCAL-GATES, VAL-LOCAL-CHECKS | Foreground GATES + local coordinator |
| Selected existing gh login, actor/repo and secret hygiene | VAL-LOCAL-AUTH | Foreground AUTH |
| PR/issue drafts, durable spool, private metadata | VAL-LOCAL-DRAFTS | Foreground DRAFTS |
| Off/explicit/automatic independent publication policy | VAL-LOCAL-GRANTS | Foreground publication policies |
| Candidate Git safe import/history/guarded push | VAL-LOCAL-GIT | Trusted local publisher/Git helper |
| PR publish/update, bound ownership and response-loss recovery | VAL-LOCAL-PUBLISH-PR | Foreground PUBLISH-PR |
| Queued issue create/readback and no implicit delivery | VAL-LOCAL-PUBLISH-ISSUE | Foreground PUBLISH-ISSUE |
| Human ready/label/review/merge actions and readback | VAL-LOCAL-HANDOFF | Foreground gates/final stages |
| Executable/Paseo/real Pi execution and budgets | VAL-LOCAL-EXEC, VAL-LOCAL-PASEO, VAL-LOCAL-PI | New provider requirement + existing packet semantics |
| Native list/detail, source-based rebuilding and read-only browsing | VAL-LOCAL-UI, VAL-LOCAL-INDEX | Prior local dashboard contracts, native replacement |
| Native compact/theme/keyboard/error states | VAL-LOCAL-NATIVE, VAL-LOCAL-UI-RECOVERY | Paseo host primitives and prior local UI semantics |
| Revision-bound local controls without invented identity | VAL-LOCAL-CONTROLS | Explicit trusted host operator model |
| Portable offline export/inspection | VAL-LOCAL-EXPORT | Replaceable UI principle |
| No Python/Spec Kit; package, parity and full real local journey | VAL-LOCAL-PACKAGE, VAL-LOCAL-PARITY, VAL-LOCAL-E2E | User full replacement + original local plan scenarios |

CLI required families: bare/run foreground, start/issue/rank, list/status, pause/resume/recover/cancel, correction result, draft issue enqueue/list/show/publish, PR candidate publication/binding, export/inspect-export. Inputs include explicit state root/repo/run/expected revision, protected profile/policy, selected executor and dedicated worktree. Configured modes live in owner-controlled config, not repository content or UI-selected flags. All commands return bounded structured output; invalid input blocks without dispatch.

The native dashboard uses Paseo's authenticated local-host access as its operator boundary. Backend control enablement defaults off and is scoped by protected configuration; client cannot supply a claimed GitHub identity, executable or arbitrary path. Explicit publication requests bind exact draft digest/revision. Human GitHub review identity remains verified independently.

The prior web dashboard's loopback server, launch URL secret, browser Host/Origin protocol and SQLite implementation are replaced by native plugin transport and a source-derived view. Their privacy/no-read-side-effects/rebuild properties remain required. No web OAuth or hosted dashboard is included.
