# VAL-LOCAL-AUTH: Selected existing human GitHub account

Surface: HTTP/process.
Needs: Private developer profile and fake gh executable/server.
Behavior: Resolve configured login via gh auth token --hostname github.com --user LOGIN without switching global account; scrub ambient token/host overrides, preserve deliberate GH_CONFIG_DIR, verify /user actor/login and numeric repoID at startup/before writes; tokens never in argv/storage/prompts/logs/DTOs.
Evidence: Actual fake-gh argv/env and HTTP identity drift/ambient override/error/sentinel tests; no App key/token code required.

Required local-mode scenarios: All supervised trusted GitHub reads, ranking and private Git reads use the same selected verified human credential as writes. Revalidate actor consistency before supervised dispatch and publication. Private Git must authenticate deliberately; ambient active-account drift cannot select a different actor. Evidence includes private-Git/account-drift and ambient-token sentinels.
