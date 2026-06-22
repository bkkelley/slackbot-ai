import { CommandContext } from './types';

const DASHBOARD_URL = `${process.env.PUBLIC_BASE_URL || 'http://localhost:3456'}/agents/`;

export const HELP_TEXT = `*🗂 Command palette*
Send one of these as a normal bot message in this channel or thread.

*Setup*
• *Onboard* — \`onboard\`
   Walk through setup conversationally, one step at a time. (\`onboard status\` for a quick readiness check.)
• *Remember* — \`remember that <preference>\`
   Save a working preference to this project's CLAUDE.md.

*Agents*
• *Agents* — \`agents list\` · \`agents create\` · \`agents run <name> <action>\` · \`agents delete <name>\`
   List, create, run, or remove agents.

*Jobs*
• *Jobs* — \`jobs\` · \`jobs create\` · \`jobs cancel <id>\`
   List, create, or cancel scheduled jobs.
• *Schedule* — \`jobs schedule <plain English>\`
   Create a recurring job (e.g. \`jobs schedule every day at 9am post the standup\`).

*Projects*
• *Project* — \`project\` · \`project map <name>\` · \`project unmap\` · \`project list\`
   Show or map this channel's project. Also \`project sf <org> <AccountId> <Project__cId>\`, \`project drive <path>\`, \`project alias <names>\`.
   _In a DM, just mention a client name to scope to it (or start with \`project: <name>\`)._

*Model*
• *Model* — \`model haiku|sonnet|opus\` · \`model reset\`
   Set the model for this conversation.

*MCP*
• *MCP* — \`mcp\` · \`mcp reload\`
   List or reload configured MCP servers.

*Skills*
• *Skills* — \`skills list\` · \`skills add <package>\` · \`skills remove <name>\`
   Manage installed Claude skills.

*Workflows*
• *Workflows* — \`workflows list\` · \`workflows run <name> [sync|async]\` · \`workflows create\` · \`workflows delete <name>\`
   List, run, author, or delete workflows.

*Tasks* _(Slack Lists — paid plan)_
• *Tasks* — \`tasks create <name>\` · \`tasks add <listId> <columnId> <task>\` · \`tasks list <listId>\`
   Manage Slack list tasks.

*Help*
• *Help* — \`help\` (or the \`/commands\` slash command) — show this palette.

Manage agents & jobs at ${DASHBOARD_URL}`;

export class HelpCommand {
  async handle(ctx: CommandContext): Promise<boolean> {
    if (!/^(help|commands)$/i.test(ctx.text.trim())) return false;
    await ctx.say({ text: HELP_TEXT, thread_ts: ctx.thread_ts || ctx.ts });
    return true;
  }
}
