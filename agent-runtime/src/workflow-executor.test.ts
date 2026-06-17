import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AgentJob, JobResult } from './types.js';
import type { JobQueue } from './job-queue.js';

type InlineHandler = (job: AgentJob, callIndex: number) => JobResult;

class FakeQueue {
  jobs: AgentJob[] = [];
  private nextId = 1;

  enqueue(job: Omit<AgentJob, 'id' | 'status' | 'createdAt'>): AgentJob {
    const fullJob: AgentJob = {
      ...job,
      id: `job-${this.nextId++}`,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    this.jobs.push(fullJob);
    return fullJob;
  }
}

function result(ok: boolean, textOutput: string, error?: string): JobResult {
  return {
    ok,
    error,
    textOutput,
    postedMessageIds: [],
    cardFiles: [],
    childJobIds: [],
    outputChars: textOutput.length,
  };
}

function workflowJob(name: string): AgentJob {
  return {
    id: `workflow-${name}`,
    workflow: name,
    mode: 'sync',
    toolset: 'default',
    trigger: 'manual',
    status: 'running',
    createdAt: new Date().toISOString(),
  };
}

function writeWorkflow(vaultPath: string, name: string, yaml: string): void {
  const dir = path.join(vaultPath, '_workflows');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.md`), `---\nname: ${name}\n${yaml.trim()}\n---\n`, 'utf8');
}

async function runCase(
  runWorkflow: typeof import('./workflow-executor.js').runWorkflow,
  name: string,
  handler: InlineHandler
): Promise<{ output: JobResult; queue: FakeQueue }> {
  const queue = new FakeQueue();
  let calls = 0;
  const output = await runWorkflow(
    workflowJob(name),
    queue as unknown as JobQueue,
    async (job) => handler(job, ++calls)
  );
  return { output, queue };
}

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-executor-'));
  const vaultPath = path.join(root, 'vault');
  process.env.VAULT_PATH = vaultPath;
  process.env.BASE_DIRECTORY = path.join(root, 'workspaces');
  process.env.BUDGETS_PATH = path.join(root, 'budgets.json');
  fs.writeFileSync(process.env.BUDGETS_PATH, '{"enabled":false}', 'utf8');

  const { previewWorkflow, runWorkflow } = await import('./workflow-executor.js');

  writeWorkflow(vaultPath, 'RetrySucceeds', `
steps:
  - type: agent
    agent: Builder
    action: Fix Tests
    maxAttempts: 3
    successWhen: output_includes
    successText: PASS
`);
  const retry = await runCase(runWorkflow, 'RetrySucceeds', (_job, call) =>
    call === 1 ? result(true, 'still failing') : result(true, 'PASS: fixed')
  );
  assert.equal(retry.output.ok, true);
  assert.deepEqual(retry.output.stepResults?.map((step) => step.status), ['failed', 'done']);
  assert.deepEqual(retry.output.stepResults?.map((step) => step.attempt), [1, 2]);

  writeWorkflow(vaultPath, 'MarkerBoundary', `
steps:
  - type: agent
    agent: Evaluator
    action: Score
    successWhen: output_includes
    successText: PASS
    onFailure: continue
  - type: agent
    agent: Followup
    action: Route
    runIf: previous_output_includes
    runIfText: ROUTE:code
`);
  const boundary = await runCase(runWorkflow, 'MarkerBoundary', (job) => {
    if (job.agent === 'Evaluator') return result(true, 'BYPASS ROUTE:codec');
    return result(true, 'should not run');
  });
  assert.equal(boundary.output.ok, true);
  assert.deepEqual(boundary.queue.jobs.map((job) => job.agent), ['Evaluator']);
  assert.deepEqual(boundary.output.stepResults?.map((step) => step.status), ['failed', 'skipped']);

  writeWorkflow(vaultPath, 'MarkerPunctuation', `
steps:
  - type: agent
    agent: Reviewer
    action: Review
    successWhen: output_includes
    successText: APPROVED
  - type: agent
    agent: Tester
    action: Verify
    successWhen: output_excludes
    successText: TESTS_FAIL
`);
  const punctuation = await runCase(runWorkflow, 'MarkerPunctuation', (job) => {
    if (job.agent === 'Reviewer') return result(true, 'APPROVED - ship it');
    return result(true, 'TESTS_PASS: clean');
  });
  assert.equal(punctuation.output.ok, true);
  assert.deepEqual(punctuation.output.stepResults?.map((step) => step.status), ['done', 'done']);

  writeWorkflow(vaultPath, 'ReviewerLoop', `
steps:
  - type: agent
    agent: Builder
    action: Draft
    maxVisits: 3
  - type: agent
    agent: Reviewer
    action: Review
    successWhen: output_includes
    successText: APPROVED
    jumpOnFailure: 1
    maxVisits: 3
`);
  let reviewCalls = 0;
  const loop = await runCase(runWorkflow, 'ReviewerLoop', (job) => {
    if (job.agent === 'Reviewer') {
      reviewCalls += 1;
      return reviewCalls === 1 ? result(true, 'NEEDS_CHANGES') : result(true, 'APPROVED');
    }
    return result(true, `draft ${reviewCalls + 1}`);
  });
  assert.equal(loop.output.ok, true);
  assert.deepEqual(loop.queue.jobs.map((job) => job.agent), ['Builder', 'Reviewer', 'Builder', 'Reviewer']);
  assert.deepEqual(loop.output.stepResults?.map((step) => `${step.step}:${step.status}:v${step.visit}`), [
    '1:done:v1',
    '2:failed:v1',
    '1:done:v2',
    '2:done:v2',
  ]);

  writeWorkflow(vaultPath, 'MaxVisitsStops', `
steps:
  - type: agent
    agent: Builder
    action: Draft
    maxVisits: 1
  - type: agent
    agent: Reviewer
    action: Review
    successWhen: output_includes
    successText: APPROVED
    jumpOnFailure: 1
`);
  const maxVisits = await runCase(runWorkflow, 'MaxVisitsStops', (job) =>
    job.agent === 'Reviewer' ? result(true, 'NEEDS_CHANGES') : result(true, 'draft')
  );
  assert.equal(maxVisits.output.ok, false);
  assert.match(maxVisits.output.error ?? '', /exceeded maxVisits=1/);

  writeWorkflow(vaultPath, 'InvalidRuntimeConfig', `
steps:
  - type: agent
    agent: Builder
    action: Draft
    maxVisits: 0
  - type: agent
    agent: Reviewer
    action: Review
    jumpOnFailure: 99
`);
  const invalidRuntime = await runCase(runWorkflow, 'InvalidRuntimeConfig', () => result(true, 'PASS'));
  assert.equal(invalidRuntime.output.ok, false);
  assert.match(invalidRuntime.output.error ?? '', /maxVisits must be at least 1/);
  assert.match(invalidRuntime.output.error ?? '', /jumpOnFailure must point to a valid/);
  assert.equal(invalidRuntime.queue.jobs.length, 0);

  writeWorkflow(vaultPath, 'RunIfFailure', `
steps:
  - type: agent
    agent: Builder
    action: Try
    onFailure: continue
  - type: agent
    agent: Fixer
    action: Recover
    runIf: previous_failed
`);
  const runIf = await runCase(runWorkflow, 'RunIfFailure', (job) =>
    job.agent === 'Builder' ? result(false, 'broken', 'boom') : result(true, 'recovered')
  );
  assert.equal(runIf.output.ok, true);
  assert.deepEqual(runIf.queue.jobs.map((job) => job.agent), ['Builder', 'Fixer']);
  assert.deepEqual(runIf.output.stepResults?.map((step) => step.status), ['failed', 'done']);

  writeWorkflow(vaultPath, 'MissingSkillPreservesPriorResults', `
steps:
  - type: agent
    agent: Builder
    action: Draft
  - type: skill
    skill: missing-skill
`);
  const missingSkill = await runCase(runWorkflow, 'MissingSkillPreservesPriorResults', () => ({
    ok: true,
    textOutput: 'draft output',
    postedMessageIds: ['message-1'],
    cardFiles: ['card.md'],
    childJobIds: ['nested-child'],
    outputChars: 12,
  }));
  assert.equal(missingSkill.output.ok, false);
  assert.match(missingSkill.output.error ?? '', /Skill "missing-skill" not found/);
  assert.deepEqual(missingSkill.output.postedMessageIds, ['message-1']);
  assert.deepEqual(missingSkill.output.cardFiles, ['card.md']);
  assert.deepEqual(missingSkill.output.childJobIds, ['job-1', 'nested-child']);
  assert.equal(missingSkill.output.textOutput, 'draft output');

  const preview = await previewWorkflow(workflowJob('ReviewerLoop'), async (job) => ({
    kind: 'agent',
    ok: true,
    errors: [],
    warnings: [],
    promptChars: `${job.agent}/${job.action}`.length,
    toolset: job.toolset,
    allowedTools: ['Read'],
  }));
  assert.equal(preview.ok, true);
  assert.deepEqual(preview.workflow?.steps[1]?.controlFlow, [
    'Succeeds only if output includes "APPROVED".',
    'On failure, jumps to step 1.',
    'May be visited up to 3 times.',
  ]);

  writeWorkflow(vaultPath, 'PreviewWarnings', `
steps:
  - type: agent
    agent: Gate
    action: Check
    runIf: previous_failed
  - type: agent
    agent: Loop
    action: Self
    jumpOnFailure: 2
`);
  const warningPreview = await previewWorkflow(workflowJob('PreviewWarnings'), async () => ({
    kind: 'agent',
    ok: true,
    errors: [],
    warnings: [],
  }));
  assert.equal(warningPreview.ok, true);
  assert.match((warningPreview.workflow?.steps[0]?.warnings || []).join('\n'), /cannot be true for the first step/);
  assert.match((warningPreview.workflow?.steps[1]?.warnings || []).join('\n'), /set maxVisits to bound the loop/);

  writeWorkflow(vaultPath, 'MarkerContract', `
steps:
  - type: agent
    agent: Reviewer
    action: Review
    successWhen: output_includes
    successText: APPROVED
---

## Marker Contract

Reviewer must include APPROVED when the work is acceptable.
`);
  const markerContractPreview = await previewWorkflow(workflowJob('MarkerContract'), async () => ({
    kind: 'agent',
    ok: true,
    errors: [],
    warnings: [],
    promptPreview: 'Review the change.',
  }));
  assert.equal(markerContractPreview.workflow?.steps[0]?.warnings?.some((warning) => warning.includes('successText "APPROVED"')), false);

  writeWorkflow(vaultPath, 'MissingMarkerContract', `
steps:
  - type: agent
    agent: Reviewer
    action: Review
    successWhen: output_includes
    successText: APPROVED
`);
  const missingMarkerPreview = await previewWorkflow(workflowJob('MissingMarkerContract'), async () => ({
    kind: 'agent',
    ok: true,
    errors: [],
    warnings: [],
    promptPreview: 'Review the change.',
  }));
  assert.match((missingMarkerPreview.workflow?.steps[0]?.warnings || []).join('\n'), /successText "APPROVED" is not mentioned/);
}

main()
  .then(() => {
    console.log('workflow-executor adaptive tests passed');
  })
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
