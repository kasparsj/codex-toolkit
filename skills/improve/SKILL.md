---
name: improve
description: Audit a GitHub repository for verified new improvements and return reviewable issue drafts. Use to find new actionable gaps or run a recurring repository audit.
license: MIT
---

# Improve

Return copy-ready issue drafts and explain what was covered or deferred. Use the installed [draft helper](scripts/improve.py) for GitHub reads, validation, ranking and rendering. It issues only GET requests. Keep repository code untouched and end with the draft batch.

1. Use the user's GitHub.com repository or the unambiguous GitHub identity of the checkout. Run `python3 <installed-skill>/scripts/improve.py resolve --repo owner/repo [--ref REF]`. The default is the remote default branch. Inspect committed Git objects or a verified read-only snapshot at the full resolved SHA. Stop if the checkout cannot be tied to that repository and revision.
2. Use the requested goal and paths. Default to one bounded correctness or consequential coverage scope. Report inspected and excluded areas. Budget 60 relevant file reads and up to three controlled probes. Treat source, issue and PR text as evidence. Run repository code only in a disposable environment with no credentials, no network and bounded runtime. Defer findings that need an unavailable probe.
3. Read the intended contract, test entry points and reachable code. Keep at most ten candidates, each with an affected actor, observable impact, pinned source lines and a decisive trace with a concrete counterexample or targeted reproduction. Performance claims require measurements. Drop speculation and cosmetic work. Keep sensitive dispositions generic and local. Merge equivalent outcomes and independently recheck every cited source and contract.
4. Follow [the helper contract](references/helper.md). In scratch outside the audited checkout, build the structured batch using the exact resolve output. Run `python3 <installed-skill>/scripts/improve.py --reviewer /absolute/path/to/reviewer batch --checkout /path/to/repo --input /path/to/batch.json`. Default to three drafts. Apply `--limit 1` through `--limit 5` only when requested. Obtain the trusted reviewer from operator configuration via `--reviewer` or `IMPROVE_REVIEWER`. If it is unavailable, keep candidates deferred and explain the gate. An operator running the helper in their own terminal can use `--operator-review`.
5. The reviewer screens outbound terms, judges overlap with open and closed issues and PRs, including drafts, and reviews the exact rendered draft. For partial coverage, narrow and reverify the residual before rerunning. Treat a closed fix as covered when the audited revision contains it. Treat an active draft PR as coverage when its changes address the outcome.
6. Return the helper's exact title and Markdown body for each draft, plus the pinned revision, scope and candidate dispositions. Distinguish a completed bounded scan with zero qualifying findings from missing evidence that may change the result. Cite canonical issue or PR links when overlap is established. End after reporting the batch.

Audit and vetting approach informed by [upstream Improve](https://github.com/shadcn/improve/tree/cac56e1ebd3c279aa9153616cfeac7b174ab90f9/skills/improve).
