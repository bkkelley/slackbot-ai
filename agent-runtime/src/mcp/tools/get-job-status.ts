import { JobQueue } from '../../job-queue.js';
import { AgentJob } from '../../types.js';

export interface GetJobStatusResult {
  found: boolean;
  status?: AgentJob['status'];
  result?: AgentJob['result'];
  error?: string;
}

export function getJobStatusTool(jobId: string, queue: JobQueue): GetJobStatusResult {
  const job = queue.getJob(jobId);
  if (!job) return { found: false, error: `Job not found: ${jobId}` };
  return { found: true, status: job.status, result: job.result };
}
