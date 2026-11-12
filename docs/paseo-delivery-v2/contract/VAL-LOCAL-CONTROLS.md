# VAL-LOCAL-CONTROLS: Narrow local operator controls

Surface: RPC/cli/Paseo UI.
Needs: Protected local-host control grant and expected revision.
Behavior: Default read-only; protected config grants registeredrepo actions to authenticated trusted host clients, not caller claimed identity/path/executable. Pause/resume/cancel/recover and digest-bound publication requests validate expectedrevision/requestid idempotency. No approve/merge/deploy endpoint.
Evidence: Authorized positive control, missing/forged/stale/repeated/otherrepo denial plus exact resulting state and audit. GitHub reviewer remains independently verified.
