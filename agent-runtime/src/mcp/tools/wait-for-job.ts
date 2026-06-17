import { JobQueue } from '../../job-queue.js';
import { JobResult } from '../../types.js';

export interface WaitForJobInput {
  jobId: string;
  timeoutSeconds?: number;
}

export async function waitForJobTool(
  input: WaitForJobInput,
  queue: JobQueue
): Promise<JobResult & { timedOut?: boolean }> {
  const timeoutMs = (input.timeoutSeconds ?? 300) * 1000;
  return queue.waitForJob(input.jobId, timeoutMs);
}
