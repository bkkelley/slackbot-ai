import dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

// Load .env before anything else — resolve relative to this source file so the
// runtime works regardless of where the checkout lives.
dotenv.config({
  path: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env'),
});

import { JobQueue } from './job-queue.js';
import { Executor } from './executor.js';
import { IpcServer } from './ipc-server.js';
import { ApiServer } from './api.js';
import { Scheduler } from './scheduler.js';
import { WsManager } from './websocket.js';
import { Logger } from './logger.js';
import { AgentJob, JobEvent } from './types.js';

const logger = new Logger('runtime');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR =
  process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'jobs.db');
const RUNTIME_HTTP_PORT = parseInt(process.env.RUNTIME_HTTP_PORT || '3457', 10);
const BOT_RUNTIME_SHARED_SECRET = process.env.BOT_RUNTIME_SHARED_SECRET || '';

async function main() {
  // Ensure data dir exists
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const queue = new JobQueue(DB_PATH);
  logger.info('Job queue initialized', { dbPath: DB_PATH });

  // Create executor — needs IPC port before it can run jobs
  const executor = new Executor();

  // WS manager
  const wsManager = new WsManager();
  const wsEmitter = (jobId: string, event: JobEvent) =>
    wsManager.emit(jobId, event);

  // Inline runner for sync SpawnAgent — bound to executor + queue + wsEmitter
  const runInline = (childJob: AgentJob, parentJobId: string) =>
    executor.runInline(childJob, parentJobId, queue, wsEmitter);

  // Start IPC server first (gets ephemeral port)
  const ipcServer = new IpcServer(queue, runInline);
  const ipcPort = await ipcServer.start();
  executor.setIpcPort(ipcPort);

  // Scheduler
  const scheduler = new Scheduler((template) => {
    const job = queue.enqueue({
      agent: template.agent,
      action: template.action,
      workflow: template.workflow,
      scope: template.scope,
      model: template.model,
      mode: template.mode ?? 'async',
      toolset: template.toolset ?? 'default',
      trigger: 'schedule',
      outputChannel:
        typeof template.outputChannel === 'string'
          ? { platform: 'slack', id: template.outputChannel }
          : template.outputChannel,
      threadId: template.threadId,
    });
    logger.info('Scheduled job enqueued', {
      jobId: job.id,
      agent: template.agent,
      action: template.action,
      workflow: template.workflow,
    });
  });
  scheduler.start();

  // API server
  const apiServer = new ApiServer(
    RUNTIME_HTTP_PORT,
    BOT_RUNTIME_SHARED_SECRET,
    queue,
    scheduler,
    executor,
    wsManager
  );
  await apiServer.start();

  // Job runner loop — poll queue every 2s
  setInterval(() => {
    while (!executor.isAtCapacity && queue.hasPendingJobs()) {
      const job = queue.dequeueNext();
      if (!job) break;
      executor
        .runJob(job, queue, wsEmitter)
        .catch((err: Error) => {
          logger.error('Job execution error', {
            jobId: job.id,
            error: err.message,
          });
        });
    }
  }, 2000);

  logger.info('Agent runtime started', {
    ipcPort,
    httpPort: RUNTIME_HTTP_PORT,
    dataDir: DATA_DIR,
  });

  const shutdown = () => {
    logger.info('Shutting down...');
    scheduler.stop();
    ipcServer.close();
    apiServer.close();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err: Error) => {
  console.error('Fatal:', err);
  process.exit(1);
});
