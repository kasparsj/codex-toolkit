# Delivery validation and Python retirement

The repository-scoped TypeScript/TSX Delivery replacement passed the full local-developer acceptance gate before the user authorized Python retirement. The [historical C31 acceptance snapshot](evidence/repository-experience/final-acceptance.md) retains all 163 assertions, ten repository targets and 28 local contracts, including exact-source and evidence limitations. The snapshot predates retirement and its statements about Python retention describe that earlier state.

The legacy runner, Python CLI/wheel packaging and Python-dependent global dashboard are now removed. Git commit `2d791bd` retains their final source and the preserved local-verifier regression tests. Python Improve remains independent and supported.

The runtime and plugin production sources are unchanged from accepted C31. Retirement validation runs the actual Node test suites with the Python Delivery tree absent, both TypeScript checks, and Improve's Python tests. The cancellation fixture now refreshes an explicitly refused stale revision using its existing bounded helper; its checker-liveness, claim-release and late-write assertions remain unchanged.

Reproduce the current checks:

```sh
cd packages/delivery
npm ci --ignore-scripts
npm run typecheck
node --experimental-strip-types --test --test-concurrency=2 test/*.test.ts
cd ../../plugins/paseo-delivery
npm install --ignore-scripts --package-lock=false
npm run typecheck
npm test
cd ../..
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests/improve -v
```

The [CI workflow](../../.github/workflows/delivery.yml) checks the Node replacement. The old Python Delivery CI and packaging verifier are removed. The [source parity matrix](local-parity-matrix.json) and [reviewed plan](repository-plan/implementation-plan.md) remain historical implementation records; prior raw local receipts and private temporary fixture paths are not shipped as runtime dependencies.

Local fixture qualification does not prove real GitHub publication or authorize merge, deployment, credential changes or unattended operation. Provider archive acknowledgements do not unconditionally prove operating-system process exit. Worktrees coordinate edits and ownership; they are not a hostile-process sandbox.

See [setup and usage](repository-experience.md) for explicit Start, durable background work, Stop versus Cancel, and safe process-loss recovery.
