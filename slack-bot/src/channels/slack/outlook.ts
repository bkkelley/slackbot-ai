import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Best-effort reads of Legacy Outlook (mail + calendar) for the App Home tab, via the installed
 * `outlook` Claude Code skill scripts. No model involved — just the AppleScript shell scripts
 * (~1-2s). Every failure path returns a human `reason` so the Home tab degrades gracefully.
 */

const execFileP = promisify(execFile);
const SKILL_DIR = path.join(process.env.HOME || '', '.claude', 'skills', 'outlook');
const MAIL_SH = path.join(SKILL_DIR, 'mail.sh');
const CAL_SH = path.join(SKILL_DIR, 'cal.sh');

export type InboxResult =
  | { ok: true; messages: { sender: string; subject: string; time: string }[] }
  | { ok: false; reason: string };

export type CalResult =
  | { ok: true; events: { subject: string; when: string; ts: number }[] }
  | { ok: false; reason: string };

export async function fetchInbox(limit = 10): Promise<InboxResult> {
  if (!fs.existsSync(MAIL_SH)) return { ok: false, reason: 'Outlook skill not installed (~/.claude/skills/outlook).' };
  try {
    const mode = (await execFileP('bash', [MAIL_SH, 'mode'], { timeout: 5000 })).stdout.trim();
    if (mode === 'new') return { ok: false, reason: 'Outlook is in *New* mode (not scriptable) — switch it to *Legacy* mode.' };
    const { stdout } = await execFileP('bash', [MAIL_SH, 'list', String(limit)], { timeout: 12000 });
    const messages = stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line) => {
        const parts = line.split('  |  '); // "<time>  |  <sender <addr>>  |  <subject>"
        const senderRaw = (parts[1] || '').trim();
        const sender = senderRaw.replace(/\s*<[^>]*>\s*$/, '').trim() || senderRaw || 'unknown';
        const subject = parts.slice(2).join('  |  ').trim() || '(no subject)';
        const t = (parts[0] || '').trim();
        const m = t.match(/(\w+ \d+),.*?at (\d+:\d+):\d+\s*(AM|PM)/i); // → "June 15, 9:39 AM"
        return { sender, subject, time: m ? `${m[1]}, ${m[2]} ${m[3]}` : t };
      });
    if (!messages.length) return { ok: false, reason: 'No messages (is Outlook signed in and in Legacy mode?).' };
    return { ok: true, messages };
  } catch {
    return { ok: false, reason: 'Outlook not reachable — open it (Legacy mode) and sign in, then refresh.' };
  }
}

export async function fetchCalendar(days = 7, limit = 10): Promise<CalResult> {
  if (!fs.existsSync(CAL_SH)) return { ok: false, reason: 'Outlook skill not installed (~/.claude/skills/outlook).' };
  try {
    const { stdout } = await execFileP('bash', [CAL_SH, 'agenda', String(days)], { timeout: 12000 });
    const events = stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line) => {
        const parts = line.split('  |  '); // "<time>  |  <subject>  [<calendar>]"
        const t = (parts[0] || '').trim();
        const subject = parts.slice(1).join('  |  ').trim().replace(/\s*\[[^\]]*\]\s*$/, '') || '(busy)';
        const ts = Date.parse(t.replace(/^[A-Za-z]+,\s*/, '').replace(/\s+at\s+/i, ' ')) || 0;
        const m = t.match(/(\w+), (\w+ \d+),.*?at (\d+:\d+):\d+\s*(AM|PM)/i); // → "Thursday, June 18 · 8:30 AM"
        return { subject, when: m ? `${m[1]}, ${m[2]} · ${m[3]} ${m[4]}` : t, ts };
      });
    if (!events.length) return { ok: false, reason: `No events in the next ${days} days.` };
    events.sort((a, b) => a.ts - b.ts);
    return { ok: true, events: events.slice(0, limit) };
  } catch {
    return { ok: false, reason: 'Outlook not reachable — open it (Legacy mode) and sign in, then refresh.' };
  }
}
