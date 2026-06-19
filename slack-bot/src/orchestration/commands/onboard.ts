import { CommandContext } from './types';
import { loadChannelProjects } from '../channel-projects';

const MGMT = `http://127.0.0.1:${process.env.MANAGEMENT_PORT || 3456}/agents/api`;

/**
 * `$onboard` (bare) — falls through to the Claude session, which runs the conversational `onboard`
 *   skill and walks the user through setup one step at a time (see message-processor handoff).
 * `$onboard status` — quick one-shot readiness dump using the management-api's onboarding engine
 *   (single source of truth, shared with the dashboard).
 * `$remember <preference>` — capture a durable working preference into the project's CLAUDE.md
 *   (or global in a DM) so the bot follows it going forward.
 */
export class OnboardCommand {
  async handle(ctx: CommandContext): Promise<boolean> {
    const { text, channel, thread_ts, ts, say } = ctx;
    const t = text.trim();
    const reply = (m: string) => say({ text: m, thread_ts: thread_ts || ts });

    // $remember <preference>
    if (/^\$remember(\s|$)/i.test(t)) {
      const pref = t.replace(/^\$remember\s*/i, '').trim();
      if (!pref) {
        await reply('Usage: `$remember <preference>` — e.g. `$remember track tasks as markdown files in tasks/`. Saved to this channel’s project CLAUDE.md (or global from a DM).');
        return true;
      }
      const proj = loadChannelProjects()[channel];
      const scope = proj || 'global';
      try {
        const r = await fetch(`${MGMT}/onboarding/preferences`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scope, text: pref }),
        });
        const data = (await r.json()) as { ok?: boolean; error?: string; file?: string };
        if (!r.ok || data.ok === false) { await reply(`⚠️ Couldn't save that: ${data.error || 'failed'}`); return true; }
        await reply(`✅ Got it — saved to ${scope === 'global' ? '*global* preferences' : `the *${scope}* project`}. I'll follow this going forward.`);
      } catch (e: any) {
        await reply(`⚠️ Couldn't reach the management API: ${e.message}`);
      }
      return true;
    }

    // $onboard status — quick one-shot dump. (Bare `$onboard` returns false below so the Claude
    // session can run the conversational `onboard` skill instead.)
    if (/^\$onboard\s+status\b/i.test(t)) {
      await reply('🚀 Checking your setup…');
      try {
        const r = await fetch(`${MGMT}/onboarding/status?fresh=1`);
        const data = (await r.json()) as { items?: any[]; summary?: any };
        const icon = (s: string) => (s === 'ok' ? '✅' : s === 'warn' ? '⚠️' : '❌');
        const lines = (data.items || []).map(
          (it) => `${icon(it.status)} *${it.label}*${it.detail ? ` — ${it.detail}` : ''}${it.status !== 'ok' && it.fix ? `\n   ↳ ${it.fix}` : ''}`
        );
        const s = data.summary || {};
        const next = [
          '*Next steps:*',
          '• Map a project here: `$project map <name>`, then `$project sf <org> <AccountId> <Project__cId>` and `$project drive <path>`',
          '• Capture a working preference: `$remember <how you like to work>`',
          `• Step-by-step setup for anything not ready: the *Onboarding* tab → ${process.env.PUBLIC_BASE_URL || 'http://localhost:3456'}/agents/#onboarding`,
        ].join('\n');
        await reply(`*Setup status — ${s.ok || 0}/${s.total || 0} ready*\n\n${lines.join('\n')}\n\n${next}`);
      } catch (e: any) {
        await reply(`⚠️ Couldn't reach the management API (${e.message}). Is \`com.slackbot.management\` running?`);
      }
      return true;
    }

    return false;
  }
}
