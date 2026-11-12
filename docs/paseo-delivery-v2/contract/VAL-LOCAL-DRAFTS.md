# VAL-LOCAL-DRAFTS: Durable local issue proposals and PR handoffs

Surface: cli/data.
Needs: Actual local plan candidate and explicit proposal input.
Behavior: Queue bounded typed issue title/body as data only and derive PR handoff from verified candidate; stable identity/digest and owner-only retained source survive restart/index deletion; removing source removes view; show only safe metadata by default, explicit CLI show can reveal body; draftonly no external write.
Evidence: Real enqueue/list/show/restart/rebuild/remove source commands, secret/body sentinel scan and zero-write ledger.
