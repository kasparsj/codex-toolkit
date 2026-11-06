---
name: handoff
description: Delegate one authorized implementation task to a fresh Codex subagent with a self-contained brief, then verify the result in the parent chat. Use when the user asks to hand off implementation to a fresh agent.
license: MIT
---

# Handoff

1. **Check readiness and prepare the brief.** Inspect the relevant conversation, code, repository instructions, and Git state. A task is ready when one executor can implement and verify it within a clear scope without making major product or architecture decisions. If important decisions are still open, plan in the parent chat and resolve them before spawning the executor. If the task is ready, proceed directly to the brief.

   Record the working directory, branch (or detached HEAD), starting commit, and any staged, unstaged, or untracked work relevant to the task. Include the objective, current behavior, relevant files, files the executor owns, edits to preserve, decisions and constraints, acceptance criteria, and exact verification commands. Put everything the executor needs in the brief.
2. **Dispatch one executor.** Use the native Codex subagent tool with `agent_type: "executor"` and `fork_turns: "none"`. Pass the brief as its task message. Tell the executor it shares the checkout, must preserve other people's work, and owns implementation and testing within the brief. If native dispatch is unavailable, return the brief and report that implementation is pending.
3. **Wait for the result.** Keep the assigned files free of concurrent parent edits. Ask the executor to report `DONE`, `NEEDS_CONTEXT`, or `BLOCKED`, with changed files, commands run and their results, and remaining issues. If it needs context the parent can supply, send it to the same executor and wait again. If the executor remains blocked, review any partial changes and report the blocker and outstanding criteria.
4. **Verify in the parent chat.** Compare the resulting diff with the starting state and the acceptance criteria. Check that existing edits were preserved and rerun the key checks. Send actionable findings back to the same executor when it can address them within scope, then verify again. Report the criteria met, verification results, and any remaining gaps.
