# VAL-LOCAL-UI-RECOVERY: Empty loading stale disconnected error states

Surface: Paseo UI.
Needs: Empty/error/offline/stale fixture states.
Behavior: Distinguish empty from unavailable, retain labelled last-known snapshot/evidence time, disable revision-bound controls while stale/disconnected; retry restores fresh selected run without creating work or silently switching hosts.
Evidence: Actual plugin fault→refresh→recovery interaction, state matches and zero dispatch ledger.
