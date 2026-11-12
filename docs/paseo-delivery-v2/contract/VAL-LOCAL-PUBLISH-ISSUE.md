# VAL-LOCAL-PUBLISH-ISSUE: Explicit queued issue publication

Surface: HTTP/process.
Needs: Queued proposal and authorized digest.
Behavior: Create only explicitly queued proposal with stable operation marker and exact author/repo/payload readback; persist intent before POST, unique recovery after loss/index deletion, ambiguous match holds; publish does not implicitly schedule new issue for delivery.
Evidence: Positive create and wrong actor/body/repo/lostresponse/zero/multiple match fixtures; durable journal and zero auto-dispatch.
