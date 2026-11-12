# VAL-LOCAL-HANDOFF: Human GitHub final actions

Surface: HTTP/cli.
Needs: Published verified draft.
Behavior: Mark-ready, tracking label, review and merge are human actions; runner requests only applicable next action then observes fresh exact-head readback; release own claim after verified handoff, never mutate ready/labels/reviews/merge/deploy implicitly.
Evidence: Draft→humanready→tracking readback fixture sequence, no mutation endpoint calls, claim timing and merge-readiness separate from delivery status.

Required local-mode scenarios: A PR made ready before the runner requested readiness, or tracking label observed before the requested tracking checkpoint, must hold rather than count as success. Test early-ready, early-label, corrected head and stale prior-stage evidence; progression is verified requested ready first, then requested tracking, then release.
