# VAL-LOCAL-POLL: Fresh bounded polling and backoff

Surface: process/HTTP fixture.
Needs: Active run with check/review snapshots.
Behavior: Read fresh durable/GitHub state on each decision; bounded verifier attempts and exponential transient-read backoff respect RetryAfter/reset even above ordinary cap; unclassified errors/rejection/pin/auth/head drift hold; no auto recover or forged receipt.
Evidence: Deterministic clock tests plus real failed/pending/success/rate-limit fixture sequence; no forbidden transitions.

Required local-mode scenarios: Defaults are a 15-second normal poll and exponential transient-read delay capped at five minutes, configurable only by trusted bounded policy; respected server RetryAfter/reset can exceed that cap. Test default pacing and no repeated idle-state logs.
