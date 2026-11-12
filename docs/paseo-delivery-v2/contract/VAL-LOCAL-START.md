# VAL-LOCAL-START: Local foreground launch and setup

Surface: cli/process.
Needs: Pinned local-mode plan; temporary repositories.
Behavior: Bare or explicit foreground launch resolves exactly one GitHub repo and stays attached through idle/review waits; missing profile serves viewable setup guidance without dispatch; ambiguous checkout fails; one developer foreground slot; state-change logs are sanitized and coalesced.
Evidence: Real Node launch/idle/missing/ambiguous/singleton subprocess traces and current projection.
