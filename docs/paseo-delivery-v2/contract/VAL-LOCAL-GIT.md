# VAL-LOCAL-GIT: Trusted local candidate import and guarded push

Surface: Git/process.
Needs: Temporary clean bare remote and real candidate bundles.
Behavior: Use isolated Git config/hooks/env and explicit selected credential; verify canonical repo/base/head, ancestry, complete introduced history, allowed safe file modes/paths and material change, then fastforward/lease-bound exact branch push; reject foreign/conflicting remote state.
Evidence: Actual valid and malicious bundles/path/intermediate-history/ref-race Git tests with beforeafter refs; no Python Git helper invocation.
