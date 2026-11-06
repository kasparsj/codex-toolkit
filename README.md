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
