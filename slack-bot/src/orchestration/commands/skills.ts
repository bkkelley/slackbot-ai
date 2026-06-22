import { spawn } from 'child_process';
import { CommandContext } from './types';

const NPX = '/opt/homebrew/bin/npx';

function runSkillsCommand(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn(NPX, ['--yes', 'skills', ...args], {
      env: { ...process.env, HOME: process.env.HOME || '' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('close', (code) => resolve({ stdout, stderr, code: code ?? 1 }));
    child.on('error', (err) => resolve({ stdout: '', stderr: err.message, code: 1 }));
    setTimeout(() => { child.kill(); resolve({ stdout, stderr: 'timed out', code: 1 }); }, 60_000);
  });
}

export class SkillsCommand {
  async handle(ctx: CommandContext): Promise<boolean> {
    const { text, thread_ts, ts, say } = ctx;
    const trimmed = text.trim();

    if (!/^skills(\s|$)/i.test(trimmed)) return false;

    const args = trimmed.slice('skills'.length).trim();

    if (!args || /^list$/i.test(args)) {
      const { stdout, code } = await runSkillsCommand(['list']);
      if (code !== 0 || !stdout.trim()) {
        await say({ text: '📭 No skills installed.', thread_ts: thread_ts || ts });
        return true;
      }
      const lines = stdout.trim().split('\n').filter(Boolean);
      const formatted = lines.map(l => `• \`${l.trim()}\``).join('\n');
      await say({ text: `*Installed skills:*\n${formatted}`, thread_ts: thread_ts || ts });
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
