# VAL-LOCAL-PUBLISH-PR: Bound draft create update and reconciliation

Surface: HTTP/Git/process.
Needs: Authorized plan/implementation candidate.
Behavior: Persist owner-only intent outside derived index before push/create/update; verify account/repo/policy/base/issue/digest/generation and applicable prior review; create draft or update same owned draft only, exact title/body/author/head/base readback; ambiguous lostPOST reconcile unique match else block, never blindly POST again.
Evidence: Real localHTTP/Git positive and every phase-loss/restart case, lookalike/multiple/zero/truncated matches, one bound PR and no duplicate create.

Required local-mode scenarios: Publication-off remains usable: export verified handoff, let developer publish manually, then bind only the exact expected repo/author/head/base/owned draft with protected read-only validation. Wrong or stale identity refuses; binding itself performs zero GitHub mutation. Exercise this positive manual-bind flow through the normal review gates.
