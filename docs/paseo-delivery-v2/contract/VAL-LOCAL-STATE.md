# VAL-LOCAL-STATE: Private durable state and source pins

Surface: data/cli.
Needs: Temp trusted state root and source packages.
Behavior: Persist versioned owner-only atomic/fsynced run, claim, source/skill/config hashes, attempts/history and independent publication intents; reject corrupt/symlinked/legacy writable state and changes before resumed execution; derived index is never authority.
Evidence: Filesystem modes, killed writer, tamper/symlink/pin tests and unchanged old implementation.

Required local-mode scenarios: Freeze absolute runtime/installation, skills and trusted profile paths along with bytes. Same bytes under a different pinned installation/skills/profile identity remain viewable but blocked from automated continuation.
