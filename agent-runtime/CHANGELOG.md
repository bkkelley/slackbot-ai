# Changelog

All notable changes to the agent-runtime are documented here.

---

## 2026-06-12

### Added
- **Three-layer skill resolution** (`skill-resolver.js`, `workflow-executor.ts`, `run-skill.ts`): skills now resolve agent-specific first, then workspace-specific, then global. Workspace skills use `<workspace>/.claude/skills/<name>/SKILL.md`; legacy `<workspace>/.agents/skills/<name>/SKILL.md` remains a read fallback.

- **Claude-native agent directories** (`vault.js`, `context-assembler.ts`): workspace agents now resolve from `<workspace>/.claude/agents/<Name>.md` first, with legacy `<workspace>/.agents/<Name>.md` as a compatibility fallback. Global agent writes now target `~/.claude/agents/<Name>.md`, with `BAK/Agent/<Name>.md` retained as a legacy fallback.

---

## 2026-05-26

### Added
- **Shared action and persona roots** (`context-assembler.ts`): Actions now resolve through `<workspace>/.agents/actions/<Action>.md` and `~/.agents/actions/<Action>.md`, with `agents:` metadata deciding which agents can use them. Legacy `<Agent> - <Action>.md` and `BAK/_agent_actions` files remain readable. Personas now use `~/.agents/personas` globally, with `BAK/_personas` as a legacy fallback.

- **Project-scoped MCP servers** (`executor.ts`): MCP servers are now loaded from both `~/.claude/settings.json` (global) and `<workspace>/.claude/settings.json` (project), merged with project taking precedence on name conflicts. All loaded server names are automatically added to `--allowed-tools` as `mcp__<serverName>__*` patterns. This mirrors Claude Code's own settings merge behavior.

- **Project-scoped personas** (`context-assembler.ts`): Persona resolution checks `<workspace>/.agents/personas/<Name>.md` first, then global persona roots. Previously always read from vault regardless of job scope.

- **Project-scoped skills** (`run-skill.ts`): `RunSkill` now searches `<workspace>/.agents/skills/<name>/SKILL.md` first (when parent job has a scope), then `~/.claude/skills/<name>/SKILL.md` (global), then `~/.claude/commands/<name>.md` (legacy fallback). Skill child jobs inherit the parent job's scope so they run in the right working directory.

- **Project-scoped workflows** (`workflow-executor.ts`, `run-workflow.ts`): `loadWorkflow` now accepts an optional scope and checks `<workspace>/.agents/workflows/<Name>.md` before falling back to `BAK/_workflows/`. Workflow child jobs inherit the parent's scope. Skill steps within workflows use the same project-first search order.

- **Scope inheritance**: Skills and workflows spawned as child jobs automatically inherit the parent job's `scope` — no explicit configuration needed in `SpawnAgent`, `RunSkill`, or `RunWorkflow` calls.

### Context
These changes bring the agent-runtime's resource resolution into parity with Claude Code's own project-scoped behavior: project-local resources override global ones at every layer, and scope flows down through child jobs automatically. Enables per-project MCP server configs (e.g. separate Supabase/Vercel credentials per website project) without any global config changes.
