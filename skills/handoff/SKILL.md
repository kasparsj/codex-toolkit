---
name: handoff
description: Assess whether an authorized implementation task benefits from fresh context, then continue in place or delegate to a fresh Codex subagent and verify its result. Use when the user asks to hand off implementation.
license: MIT
---

# Handoff

0. **Choose whether to hand off.** Assess whether fresh context would materially improve the next task. Continue in the current chat when the task is clear, the relevant context remains useful, and a handoff would mainly add overhead. Favor a fresh executor when unrelated history, abandoned approaches, or conflicting assumptions hinder the task, or when a self-contained next phase benefits from context isolation. Honor an explicit request for a fresh agent; invoking the skill alone requests this assessment. State the choice and one short reason, then execute it without a confirmation round. If continuing here, implement and verify the authorized task directly; skip the dispatch steps below. A fresh executor starts with its own context and does not reset the parent chat.

1. **Check readiness and prepare the brief.** Inspect the relevant conversation, code, repository instructions, and Git state. A task is ready when one executor can implement and verify it within a clear scope without making major product or architecture decisions. If important decisions are still open, plan in the parent chat and resolve them before spawning the executor. If the task is ready, proceed directly to the brief.

   Record the working directory, branch (or detached HEAD), starting commit, and any staged, unstaged, or untracked work relevant to the task. Include the objective, current behavior, relevant files, files the executor owns, edits to preserve, decisions and constraints, acceptance criteria, and exact verification commands. Put everything the executor needs in the brief.
2. **Dispatch one executor.** Use the native Codex subagent tool with `agent_type: "executor"` and `fork_turns: "none"`. Pass the brief as its task message. Tell the executor it shares the checkout, must preserve other people's work, and owns implementation and testing within the brief. If native dispatch is unavailable, return the brief and report that implementation is pending.
3. **Wait for the result.** Keep the assigned files free of concurrent parent edits. Ask the executor to report `DONE`, `NEEDS_CONTEXT`, or `BLOCKED`, with changed files, commands run and their results, and remaining issues. If it needs context the parent can supply, resume the same executor with that context and wait again. Use `followup_task` after its turn has ended. Use `send_message` only while it is still running. If it remains blocked, review any partial changes and report the blocker and outstanding criteria.
4. **Verify in the parent chat.** Compare the resulting diff with the starting state and the acceptance criteria. Check that existing edits were preserved and rerun the key checks. Resume the same executor with actionable findings it can address within scope, then verify again. Report the criteria met, verification results, and any remaining gaps.
