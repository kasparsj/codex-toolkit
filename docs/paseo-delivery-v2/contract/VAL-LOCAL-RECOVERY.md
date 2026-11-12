# VAL-LOCAL-RECOVERY: Explicit recovery without duplicate execution

Surface: process/cli.
Needs: Killed adapter plus persisted provider/effect identity.
Behavior: Resume adopts only compatible recognized checkpoints and reconciles existing remote execution; stranded running state requires explicit operator recovery and proof old workload stopped; PID death/reuse alone grants nothing; old-session processes are not signalled.
Evidence: Kill/restart before-after dispatch/checkpoint and provider-active cases, one accepted execution or explicit ambiguous hold.

Required local-mode scenarios: Compatible checkpoint requires the same recorded runtime/installation path, skills root and trusted profile path/identity, not merely hash equality. Test identical bytes copied to a different installation/path and require visible pin hold rather than resume.
