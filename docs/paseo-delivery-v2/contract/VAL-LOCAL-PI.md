# VAL-LOCAL-PI: Real direct Pi execution

Surface: Pi JSONL.
Needs: Installed authenticated Pi and current RPC contract.
Behavior: Execute direct Pi JSONL using receipt versus agent_settled distinction, handle agent_end/compaction/retry/error/abort/resume and validate same artifact envelope; Pi through Paseo additionally follows generic provider path.
Evidence: Actual Pi task output and settlement transcript plus synthetic event-order/abort regressions. Missing authentication blocks real-provider claim.
