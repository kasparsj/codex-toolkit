# VAL-LOCAL-RANK: Complete ranking and serviced issue exclusion

Surface: cli/HTTP fixture.
Needs: Pinned rank skill and complete GitHub read fixture.
Behavior: Require complete issue/PR/dependency evidence, preserve canonical shortlist order after excluding servedIDs, revalidate winner before start; no candidate is valid idle/terminal result; completed issue cannot autorepeat without explicit requeue/start.
Evidence: Incomplete/openPR/dependency/no-candidate/nextwinner/restart/requeue traces and preserved serviced ledger.
