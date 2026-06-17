---
fileClass: Agent Action
agents:
  - Ask the System
action: Diagnose
created: 20260601000000000
modified: 20260601000000000
---

# Diagnose

## Task

Answer the user's question about the local agent system by inspecting the system workspace and relevant runtime artifacts.

## Procedure

1. Read the user's question from `=== USER'S REPLY ===` or `=== PRIOR STEP OUTPUT ===` if present.
2. Identify the smallest evidence set needed:
   - Architecture/docs: `CLAUDE.md`, `README-RUNTIME.md`, package READMEs
   - Runtime behavior: `agent-runtime/src/`, `agent-runtime/data/`, `agent-runtime/runtime.log`
   - Dashboard/API behavior: `management-api/routes/`, `management-api/web/`
   - Transport behavior: `slack-bot/src/`, `slack-bot/bot.log`
   - Scheduling: `scheduler/jobs.json`
   - Tool permissions: `agent-runtime/toolsets.json`, `.claude/settings.json`
3. Inspect only what is relevant. Prefer `Read`, `Grep`, and `Glob`.
4. If the user provides a job ID, call `GetJobStatus` for that job and correlate it with logs if available.
5. If the user asks for a recommendation, rank fixes by risk and leverage.

## Response Contract

Call `PostMessage` with a concise answer:

- Start with the conclusion.
- Include the key evidence.
- Include a concrete next step.

If the investigation is substantial or identifies an incident worth remembering, also call `WriteCard`:

```yaml
card-type: Agent Log
agent: "[[Ask the System]]"
action: "Diagnose"
tag: system
session-type: system-diagnostic
summary: "[one-line summary]"
tags:
  - cards
  - system
body: |
  # System Diagnostic
  **Question:** [user question]
  **Conclusion:** [short answer]
  **Evidence:** [paths, job IDs, logs, observations]
  **Recommended next step:** [specific action]
```

Do not write output directives. Use the MCP tools directly.
