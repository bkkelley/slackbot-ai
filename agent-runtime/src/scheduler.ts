import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import cronParser from 'cron-parser';
import { AgentJobTemplate } from './types.js';
import { Logger } from './logger.js';

const logger = new Logger('scheduler');

// Resolve defaults relative to this file: <repo>/scheduler/jobs.json and
// <repo>/agent-runtime/data/job-state.json. Overridable via env.
const __dir = path.dirname(fileURLToPath(import.meta.url));
const JOBS_FILE =
  process.env.JOBS_FILE || path.join(__dir, '..', '..', 'scheduler', 'jobs.json');
const JOB_STATE_FILE =
  process.env.JOB_STATE_FILE || path.join(__dir, '..', 'data', 'job-state.json');

export class Scheduler {
  private templates: AgentJobTemplate[] = [];
  private lastRuns: Record<string, string> = {};
  private timer: NodeJS.Timeout | null = null;

  constructor(private onJobDue: (template: AgentJobTemplate) => void) {}

  start(): void {
    this.loadTemplates();
    // Run first tick after 1s, then every 60s
    setTimeout(() => {
      this.tick();
      this.timer = setInterval(() => this.tick(), 60_000);
    }, 1000);
    logger.info('Scheduler started', { jobCount: this.templates.length });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    logger.info('Scheduler stopped');
  }

  getTemplates(): AgentJobTemplate[] {
    return this.templates.map((template) => ({
      ...template,
      lastRun: this.lastRuns[template.id] ?? template.lastRun,
    }));
  }

  upsertTemplate(t: AgentJobTemplate): void {
    const idx = this.templates.findIndex((x) => x.id === t.id);
    if (idx >= 0) {
      this.templates[idx] = t;
    } else {
      this.templates.push(t);
    }
    this.saveTemplates();
  }

  deleteTemplate(id: string): void {
    this.templates = this.templates.filter((t) => t.id !== id);
    this.saveTemplates();
  }

  private loadTemplates(): void {
    try {
      const raw = fs.readFileSync(JOBS_FILE, 'utf8');
      this.templates = JSON.parse(raw) as AgentJobTemplate[];
    } catch (err) {
      logger.warn('Could not load jobs.json', { error: String(err) });
      this.templates = [];
    }
    this.loadState();
  }

  private saveTemplates(): void {
    try {
      fs.writeFileSync(JOBS_FILE, JSON.stringify(this.templates, null, 2), 'utf8');
    } catch (err) {
      logger.error('Could not save jobs.json', { error: String(err) });
    }
  }

  private loadState(): void {
    try {
      const raw = fs.readFileSync(JOB_STATE_FILE, 'utf8');
      const parsed = JSON.parse(raw) as { lastRuns?: Record<string, string> };
      this.lastRuns = parsed.lastRuns ?? {};
    } catch {
      this.lastRuns = {};
    }
  }

  private saveState(): void {
    try {
      fs.writeFileSync(JOB_STATE_FILE, JSON.stringify({ lastRuns: this.lastRuns }, null, 2), 'utf8');
    } catch (err) {
      logger.error('Could not save scheduler state', { error: String(err) });
    }
  }

  private getLastRun(template: AgentJobTemplate): string | null | undefined {
    return this.lastRuns[template.id] ?? template.lastRun;
  }

  private markLastRun(template: AgentJobTemplate, now: Date): void {
    this.lastRuns[template.id] = now.toISOString();
    this.saveState();
  }

  private tick(): void {
    // Hot-reload jobs.json on every tick
    this.loadTemplates();
    const now = new Date();

    for (const template of this.templates) {
      if (!template.enabled) continue;

      if (template.runAt) {
        const runAt = new Date(template.runAt);
        if (now >= runAt) {
          this.fire(template);
          template.enabled = false;
          this.markLastRun(template, now);
          this.saveTemplates();
        }
        continue;
      }

      if (template.cron) {
        if (!this.isCronDue(template.cron, this.getLastRun(template), now)) continue;
        this.fire(template);
        this.markLastRun(template, now);
      }
    }
  }

  private isCronDue(
    cronExpr: string,
    lastRun: string | null | undefined,
    now: Date
  ): boolean {
    try {
      const interval = cronParser.parseExpression(cronExpr, {
        currentDate: now,
        iterator: false,
      });
      // Get last scheduled time before now
      const prev = interval.prev();
      const prevDate = prev.toDate();

      if (!lastRun) {
        // Never run — fire if prev is within last 2 minutes (startup catchup window)
        return now.getTime() - prevDate.getTime() < 2 * 60 * 1000;
      }

      const lastRunDate = new Date(lastRun);
      return prevDate > lastRunDate;
    } catch (err) {
      logger.warn('Invalid cron expression', { cron: cronExpr, error: String(err) });
      return false;
    }
  }

  private fire(template: AgentJobTemplate): void {
    logger.info('Job due', { id: template.id, agent: template.agent, command: template.command });

    if (template.command) {
      const command = template.command.trim();
      if (!command) {
        logger.warn('Command template is empty', { id: template.id });
        return;
      }
      // Run the command string through a shell so $HOME and other env vars expand. The previous
      // shell:false + whitespace-split passed "$HOME/..." to bash literally, so every job that used
      // $HOME failed with ENOENT. jobs.json is admin-authored/trusted, so shell interpretation is fine.
      const child = spawn(command, {
        shell: true,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout?.on('data', (d: Buffer) => { output += d.toString(); });
      child.stderr?.on('data', (d: Buffer) => { output += d.toString(); });
      child.on('close', (code) => {
        if (code !== 0) {
          logger.error('Shell job failed', { id: template.id, code, output: output.slice(0, 500) });
        } else {
          logger.info('Shell job completed', { id: template.id });
        }
      });
      child.on('error', (err) => {
        logger.error('Shell job spawn error', { id: template.id, error: err.message });
      });
    } else if (template.workflow) {
      this.onJobDue(template);
    } else if (template.agent || template.action) {
      this.onJobDue(template);
    } else {
      logger.warn('Template has neither command, workflow, nor agent/action', { id: template.id });
    }
  }
}
