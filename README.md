# Codex skills

## Handoff

`$handoff` turns an implementation request into a brief, dispatches one fresh Codex executor, and brings the result back to the parent chat for verification.

### Install

Use Codex with native subagent support and Node.js 22.20 or later for the installer.

```bash
npx skills add kasparsj/skills --skill handoff -a codex -g
```

Omit `-g` to install for the current project. [Skills CLI reference](https://github.com/vercel-labs/skills/blob/main/docs/commands.md#skills-add)

### Use

In a Codex chat, invoke the skill with a task you want to delegate.

> $handoff Implement the agreed CSV export change in a fresh executor. Preserve the existing export format and verify the export tests.

[Read the skill](skills/handoff/SKILL.md)
