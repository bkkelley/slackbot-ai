import { CommandContext } from './types';

const HELP_TEXT = `*Commands*

*Setup*
\`$onboard\` — check integration readiness + next steps
\`$remember <preference>\` — save a working preference to this project's CLAUDE.md

*Agents*
\`$agents list\` — list all agents with status and model
\`$agents create\` — conversational multi-step agent creation
\`$agents delete <name>\` — remove an agent
\`$agents run <name> <action>\` — dispatch an agent action (e.g. \`$agents run Sage "Morning Nudge"\`)

*Jobs*
\`$jobs\` — list scheduled jobs
\`$jobs create\` — create a new scheduled job (conversational)
\`$jobs cancel <id>\` — disable a job
\`$schedule <plain English>\` — create a one-time or recurring job (e.g. \`$schedule every day at 9am remind me to review PRs\`)

*Projects*
\`$project\` — show this channel's project + bindings
\`$project map <name>\` — map this channel to a project (Claude runs there)
\`$project unmap\` — remove this channel's mapping
\`$project list\` — list known projects
\`$project sf <org> <AccountId> <Project__cId>\` — bind the Salesforce org + records
\`$project drive <absolute path>\` — bind the Google Drive folder
_In a DM, start a message with \`project: <name>\` to scope a thread._

*MCP*
\`mcp\` — list configured MCP servers
\`mcp reload\` — reload mcp-servers.json without restarting

*Skills*
\`$skills list\` — list installed skills
\`$skills add <package>\` — install a skill (e.g. \`$skills add anthropic/claude-code-skills\`)
\`$skills remove <name>\` — uninstall a skill

*Workflows*
\`$workflows list\` — list workflows
\`$workflows run <name> [sync|async]\` — run a workflow (default async)
\`$workflows create\` — author a workflow step-by-step
\`$workflows delete <name>\` — delete a global workflow

*Tasks* _(Slack Lists — paid plan)_
\`$tasks create <name>\` — create a task list
\`$tasks add <listId> <task>\` — add a task
\`$tasks list <listId>\` — show tasks in a list

*Help*
\`$help\` — show this message

Manage agents and jobs at http://localhost:3456/agents/`;

export class HelpCommand {
  async handle(ctx: CommandContext): Promise<boolean> {
    if (!/^\$help$/i.test(ctx.text.trim())) return false;
    await ctx.say({ text: HELP_TEXT, thread_ts: ctx.thread_ts || ctx.ts });
    return true;
  }
}
