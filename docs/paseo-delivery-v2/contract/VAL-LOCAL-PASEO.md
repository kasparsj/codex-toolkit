# VAL-LOCAL-PASEO: Real Paseo executor lifecycle

Surface: Paseo SDK.
Needs: Compatible real test daemon and configured Codex provider.
Behavior: Discover supported profile/settings; use actual worktree, persist host/workspace/agent IDs before accepting result; handle permission/error/timeout/idle and reattach/cancel without duplicate dispatch; collect independently validated artifacts.
Evidence: Actual Codex test task IDs/output plus real reconnect/cancel and unsupported setting refusal; fake SDK alone cannot pass.
