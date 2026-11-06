# Codex skills

## Install

Use Node.js 22.20 or later to install all skills in this repository for Codex.

```bash
npx skills add kasparsj/skills --skill '*' -a codex -g
```

Omit `-g` to install for the current project. [Skills CLI reference](https://github.com/vercel-labs/skills/blob/main/docs/commands.md#skills-add)

## Handoff

`$handoff` turns an implementation request into a brief, dispatches one fresh Codex executor, and brings the result back to the parent chat for verification. It requires Codex with native subagent support.

In a Codex chat, invoke the skill with a task you want to delegate.

> $handoff Implement the agreed CSV export change in a fresh executor. Preserve the existing export format and verify the export tests.

[Read the skill](skills/handoff/SKILL.md)

## Fresh handoff

Run `$fresh-handoff` in the Codex desktop chat you want to leave. It derives the next task from that chat and starts a new chat with a short brief as its first message.

Add a focus if the source chat covers several tasks.

> $fresh-handoff Fix the CSV export regression we agreed on.

You can also supply a chat link or ID to hand off work from a different chat.

[Read the skill](skills/fresh-handoff/SKILL.md)
