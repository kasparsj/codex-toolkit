# VAL-LOCAL-LIFECYCLE: Foreground stop drains consequential work

Surface: process/HTTP.
Needs: Owned blocked child and accepted-before-checkpoint write fixture.
Behavior: Ctrl-C stops scheduling immediately, logs draining and waits owned child/publication to reach durable outcome; no normal forcekill, no unrelated signal, repeated Ctrl-C cannot duplicate/lose write; forced loss retains claim/uncertain intent and dashboard reports uncertainty rather than rollback.
Evidence: Actual process-group/signals, blocked-child release, publication response-loss race, zero postshutdown dispatch and final projection.

Required local-mode scenarios: Owned subprocesses are isolated from terminal process-group SIGINT. Normal drain neither forwards SIGINT nor force-kills them; explicit cancellation is a distinct owned operation with recorded effect disposition.
