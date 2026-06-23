import { spawn } from 'child_process';
import { CommandContext } from './types';

const NPX = '/opt/homebrew/bin/npx';

// The `skills` CLI colorizes output even when piped, so strip ANSI escapes before posting to Slack
// (Slack renders them as literal `[38;5;102m…` garbage otherwise).
// eslint-disable-next-line no-control-regex
const ANSI_RE = new RegExp('\\x1b\\[[0-9;]*m', 'g');
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

function runSkillsCommand(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn(NPX, ['--yes', 'skills', ...args], {
      env: { ...process.env, HOME: process.env.HOME || '' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('close', (code) => resolve({ stdout: stripAnsi(stdout), stderr: stripAnsi(stderr), code: code ?? 1 }));
    child.on('error', (err) => resolve({ stdout: '', stderr: err.message, code: 1 }));
    setTimeout(() => { child.kill(); resolve({ stdout: stripAnsi(stdout), stderr: 'timed out', code: 1 }); }, 60_000);
  });
}

// Parse `skills list -g` output into clean skill names. Lines look like (after ANSI strip):
//   "Global Skills"                                   ← header
//   ""                                                ← blank
//   "agent-skill-creator   ~/.agents/skills/...   Agents: Claude Code, …"
// Columns are padded with runs of spaces, so the name is the first run-delimited cell.
function parseSkillNames(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !/^global skills$/i.test(l) && !/^project skills$/i.test(l))
    .map((l) => l.split(/\s{2,}/)[0].trim())
    .filter(Boolean);
}

export class SkillsCommand {
  async handle(ctx: CommandContext): Promise<boolean> {
    const { text, thread_ts, ts, say } = ctx;
    const trimmed = text.trim();

    if (!/^skills(\s|$)/i.test(trimmed)) return false;

    const args = trimmed.slice('skills'.length).trim();

    if (!args || /^list$/i.test(args)) {
      // List global skills — that's where installed skills live (project scope is usually empty and
      // the CLI just prints a "no project skills" hint, which is what was leaking into Slack before).
      const { stdout, code } = await runSkillsCommand(['list', '-g']);
      const names = parseSkillNames(stdout);
      if (code !== 0 || names.length === 0) {
        await say({ text: '📭 No skills installed.', thread_ts: thread_ts || ts });
        return true;
      }
      const formatted = names.map((n) => `• \`${n}\``).join('\n');
      await say({ text: `*Installed skills (${names.length}):*\n${formatted}`, thread_ts: thread_ts || ts });
      return true;
    }

    const addMatch = args.match(/^add\s+(\S+)$/i);
    if (addMatch) {
      const pkg = addMatch[1];
      await say({ text: `⏳ Installing \`${pkg}\`...`, thread_ts: thread_ts || ts });
      const { stdout, stderr, code } = await runSkillsCommand(['add', '-g', '-y', pkg]);
      if (code !== 0) {
        await say({ text: `❌ Install failed:\n\`\`\`${(stderr || stdout).slice(0, 500)}\`\`\``, thread_ts: thread_ts || ts });
        return true;
      }
      const installed = stdout.match(/installed[:\s]+([^\n]+)/i)?.[1]?.trim() || pkg;
      await say({ text: `✅ Installed \`${installed}\``, thread_ts: thread_ts || ts });
      return true;
    }

    const removeMatch = args.match(/^remove\s+(\S+)$/i);
    if (removeMatch) {
      const name = removeMatch[1];
      await say({ text: `⏳ Removing \`${name}\`...`, thread_ts: thread_ts || ts });
      const { stdout, stderr, code } = await runSkillsCommand(['remove', name]);
      if (code !== 0) {
        await say({ text: `❌ Remove failed:\n\`\`\`${(stderr || stdout).slice(0, 500)}\`\`\``, thread_ts: thread_ts || ts });
        return true;
      }
      await say({ text: `✅ Removed \`${name}\``, thread_ts: thread_ts || ts });
      return true;
    }

    await say({
      text: `*skills commands:*\n\`skills list\` — show installed skills\n\`skills add <package>\` — install a skill (e.g. \`skills add anthropic/claude-code-skills\`)\n\`skills remove <name>\` — uninstall a skill`,
      thread_ts: thread_ts || ts,
    });
    return true;
  }
}
