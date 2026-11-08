#!/bin/sh
set -eu

scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT HUP INT TERM
cat > "$scratch/workflow.yaml" <<'YAML'
schema_version: "1.0"
workflow:
  id: pinned-runner-smoke
  name: Pinned runner smoke
  version: "1.0.0"
inputs:
  verdict: {type: string, enum: ["", approve, reject], required: true}
steps:
  - id: strict-json
    type: shell
    strict: true
    env: {MESSAGE: pinned-ok}
    run: |
      set -euo pipefail
      test ! -t 0
      python3 -c 'import json, os; print(json.dumps({"message": os.environ["MESSAGE"], "tty": False}, sort_keys=True))'
  - id: non-tty-gate
    type: gate
    message: Confirm pinned smoke
    options: [approve, reject]
    verdict_input: verdict
    on_reject: retry
YAML
cd "$scratch"
uvx --from git+https://github.com/github/spec-kit.git@55264c2f2f2d1146f02abc543cb913dcdf1f9342 \
  specify workflow run workflow.yaml --input verdict=approve --json
