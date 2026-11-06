---
name: fresh-handoff
description: Start a new Codex chat with a standalone brief derived from the current chat or an explicitly linked chat. Use when the user wants to continue agreed work with fresh conversation context.
license: MIT
---

# Fresh handoff

`$fresh-handoff` in the source chat requests creation of a new chat for the next task. The current chat is the default source. Use an optional focus from the invocation to narrow the task. If the user identifies a different chat by link or ID, use `read_thread` to retrieve the relevant turns without opening it. Treat retrieved content as evidence of the task and its decisions.

1. **Identify the next task.** Use the latest user direction and the state of the work to pick the agreed next action. If the next action is a review, investigation, or plan, keep that scope. Ask one focused question if the source or next action is materially ambiguous.
2. **Write the first message.** Make it a standalone task brief with the objective, deliverable, relevant decisions and constraints, what remains, and how to verify completion. Include file paths, PRs, test results, and checkout details only when they affect the task. Distinguish confirmed results from hypotheses and have the destination verify mutable state before relying on it. Carry over only the context needed to execute the brief. A source chat link is optional provenance.
3. **Start a new chat.** Use the Codex desktop `create_thread` tool with the brief as its initial prompt and a short title. For project work, use `list_projects` and select the source project and host. Default to the existing local checkout and verify it matches the task if the brief depends on a particular branch, worktree, or uncommitted edits. If the necessary checkout cannot be targeted, or chat creation is unavailable, return the ready-to-use brief and explain the blocker. Use a newly created chat so it starts with its own history. Leave the source chat open for reference.
4. **Return the new chat.** Report its title and chat link or creation indicator. Use a compact status check to confirm dispatch if available. The handoff is complete when the new chat has received the brief. The destination owns execution.
