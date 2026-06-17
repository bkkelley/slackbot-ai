import * as fs from 'fs';
import { JobQueue } from '../../job-queue.js';
import { Logger } from '../../logger.js';
import { spawnAgentTool, InlineRunner, SpawnAgentResult } from './spawn-agent.js';
import { createRequire } from 'module';

const logger = new Logger('run-skill');
const require = createRequire(import.meta.url);
const { assertSafeSegment } = require('../../../../shared/path-guard.js');
const { findSkillFile: resolveSkillFile, skillSearchSummary } = require('../../../../shared/skill-resolver.js');

export interface RunSkillInput {
  skill: string;
  args?: string;
  mode?: 'sync' | 'async';
  outputChannel?: { platform: string; id: string };
  threadId?: string;
  toolset?: 'default' | 'extended';
  model?: string;
}

export interface RunSkillResult extends SpawnAgentResult {
  skillFile?: string;
}

export async function runSkillTool(
  parentJobId: string,
  input: RunSkillInput,
  queue: JobQueue,
  runInline: InlineRunner
): Promise<RunSkillResult> {
  // Inherit scope from parent job
  const parentJob = queue.getJob(parentJobId);
  const scope = parentJob?.scope;
  const agent = parentJob?.agent;

  let skillFile: string | null;
  try {
    skillFile = resolveSkillFile({ skill: input.skill, scope, agent })?.path ?? null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
  if (!skillFile) {
    const safeSkill = assertSafeSegment(input.skill, 'skill name');
    const searched = skillSearchSummary({ skill: safeSkill, scope, agent });
    logger.warn('Skill file not found', { skill: input.skill, scope, searched });
    return { ok: false, error: `Skill "${input.skill}" not found. Searched: ${searched}` };
  }

  let skillContent: string;
  try {
    skillContent = fs.readFileSync(skillFile, 'utf8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Failed to read skill file: ${msg}` };
  }

  const prompt = input.args
    ? `${skillContent}\n\n---\n\n${input.args}`
    : skillContent;

  logger.info('Running skill', { skill: input.skill, skillFile, scope, mode: input.mode ?? 'sync', parentJobId });

  const result = await spawnAgentTool(
    parentJobId,
    {
      prompt,
      mode: input.mode ?? 'sync',
      outputChannel: input.outputChannel,
      threadId: input.threadId,
      toolset: input.toolset ?? 'default',
      scope,
      model: input.model ?? parentJob?.model,
    },
    queue,
    runInline
  );

  return { ...result, skillFile };
}
