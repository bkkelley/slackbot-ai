import * as http from 'http';
import { JobQueue } from './job-queue.js';
import { Logger } from './logger.js';
import { postMessage, PostMessageInput } from './mcp/tools/post-message.js';
import { writeCardTool, WriteCardInput } from './mcp/tools/write-card.js';
import { updateCardTool, UpdateCardInput } from './mcp/tools/update-card.js';
import { spawnAgentTool, SpawnAgentInput, InlineRunner } from './mcp/tools/spawn-agent.js';
import { waitForJobTool, WaitForJobInput } from './mcp/tools/wait-for-job.js';
import { getJobStatusTool } from './mcp/tools/get-job-status.js';
import { runSkillTool, RunSkillInput } from './mcp/tools/run-skill.js';
import { runWorkflowTool, RunWorkflowInput } from './mcp/tools/run-workflow.js';
import { writeCanvas, WriteCanvasInput } from './mcp/tools/write-canvas.js';
import {
  scheduleMessage,
  listScheduledMessages,
  cancelScheduledMessage,
  ScheduleMessageInput,
  ListScheduledInput,
  CancelScheduledInput,
} from './mcp/tools/schedule-message.js';
import { addReminder, AddReminderInput } from './mcp/tools/add-reminder.js';
import {
  createTaskList,
  addTask,
  listTasks,
  CreateTaskListInput,
  AddTaskInput,
  ListTasksInput,
} from './mcp/tools/manage-task.js';

const logger = new Logger('ipc-server');

export class IpcServer {
  private server: http.Server | null = null;
  private port: number = 0;

  constructor(
    private queue: JobQueue,
    private runInline: InlineRunner
  ) {}

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res).catch((err) => {
          logger.error('IPC request error', { error: String(err) });
          res.writeHead(500);
          res.end(JSON.stringify({ ok: false, error: String(err) }));
        });
      });

      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server!.address();
        if (!addr || typeof addr === 'string') {
          reject(new Error('Could not get IPC server port'));
          return;
        }
        this.port = addr.port;
        logger.info('IPC server started', { port: this.port });
        resolve(this.port);
      });

      this.server.on('error', reject);
    });
  }

  close(): void {
    this.server?.close();
  }

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    res.setHeader('Content-Type', 'application/json');

    // GET /tool/GetJobStatus
    if (req.method === 'GET' && req.url?.startsWith('/tool/GetJobStatus')) {
      const url = new URL(req.url, `http://127.0.0.1:${this.port}`);
      const jobId = url.searchParams.get('jobId') ?? '';
      const result = getJobStatusTool(jobId, this.queue);
      res.writeHead(200);
      res.end(JSON.stringify(result));
      return;
    }

    // POST /tool
    if (req.method === 'POST' && req.url === '/tool') {
      const body = await readBody(req);
      let parsed: { jobId: string; tool: string; input: unknown };
      try {
        parsed = JSON.parse(body) as { jobId: string; tool: string; input: unknown };
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
        return;
      }

      const { jobId, tool, input } = parsed;
      let result: unknown;

      switch (tool) {
        case 'PostMessage': {
          const job = this.queue.getJob(jobId);
          const ctx = {
            jobOutputChannel: job?.outputChannel,
            jobThreadId: job?.threadId,
            job: job ?? undefined,
          };
          result = await postMessage(input as PostMessageInput, ctx);
          // Track posted message IDs in job result accumulator
          const pmResult = result as { ok: boolean; messageId?: string };
          if (pmResult.ok && pmResult.messageId) {
            this.accumulatePostedMessage(jobId, pmResult.messageId);
          }
          break;
        }
        case 'WriteCard': {
          result = writeCardTool(jobId, input as WriteCardInput, this.queue);
          const wcResult = result as { ok: boolean; cardFile?: string };
          if (wcResult.ok && wcResult.cardFile) {
            this.accumulateCardFile(jobId, wcResult.cardFile);
          }
          break;
        }
        case 'UpdateCard':
          result = updateCardTool(jobId, input as UpdateCardInput, this.queue);
          break;
        case 'SpawnAgent': {
          result = await spawnAgentTool(
            jobId,
            input as SpawnAgentInput,
            this.queue,
            this.runInline
          );
          const saResult = result as { ok: boolean; jobId?: string };
          if (saResult.jobId) {
            this.accumulateChildJob(jobId, saResult.jobId);
          }
          break;
        }
        case 'WaitForJob':
          result = await waitForJobTool(input as WaitForJobInput, this.queue);
          break;
        case 'GetJobStatus':
          result = getJobStatusTool((input as { jobId: string }).jobId, this.queue);
          break;
        case 'RunWorkflow': {
          result = await runWorkflowTool(
            jobId,
            input as RunWorkflowInput,
            this.queue,
            this.runInline
          );
          const rwResult = result as { ok: boolean; jobId?: string };
          if (rwResult.jobId) {
            this.accumulateChildJob(jobId, rwResult.jobId);
          }
          break;
        }
        case 'RunSkill': {
          result = await runSkillTool(
            jobId,
            input as RunSkillInput,
            this.queue,
            this.runInline
          );
          const rsResult = result as { ok: boolean; jobId?: string };
          if (rsResult.jobId) {
            this.accumulateChildJob(jobId, rsResult.jobId);
          }
          break;
        }
        case 'WriteCanvas': {
          const job = this.queue.getJob(jobId);
          result = await writeCanvas(input as WriteCanvasInput, {
            jobOutputChannel: job?.outputChannel,
          });
          break;
        }
        case 'ScheduleMessage': {
          const job = this.queue.getJob(jobId);
          result = await scheduleMessage(input as ScheduleMessageInput, {
            jobOutputChannel: job?.outputChannel,
            jobThreadId: job?.threadId,
          });
          break;
        }
        case 'ListScheduledMessages': {
          const job = this.queue.getJob(jobId);
          result = await listScheduledMessages(input as ListScheduledInput, {
            jobOutputChannel: job?.outputChannel,
          });
          break;
        }
        case 'CancelScheduledMessage': {
          const job = this.queue.getJob(jobId);
          result = await cancelScheduledMessage(input as CancelScheduledInput, {
            jobOutputChannel: job?.outputChannel,
          });
          break;
        }
        case 'AddReminder':
          result = await addReminder(input as AddReminderInput);
          break;
        case 'CreateTaskList':
          result = await createTaskList(input as CreateTaskListInput);
          break;
        case 'AddTask':
          result = await addTask(input as AddTaskInput);
          break;
        case 'ListTasks':
          result = await listTasks(input as ListTasksInput);
          break;
        default:
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: `Unknown tool: ${tool}` }));
          return;
      }

      res.writeHead(200);
      res.end(JSON.stringify(result));
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ ok: false, error: 'Not found' }));
  }

  // Accumulate results into job's in-progress tracking
  private getOrInitAccumulator(jobId: string): {
    postedMessageIds: string[];
    cardFiles: string[];
    childJobIds: string[];
  } {
    const job = this.queue.getJob(jobId);
    if (!job) return { postedMessageIds: [], cardFiles: [], childJobIds: [] };
    return {
      postedMessageIds: job.result?.postedMessageIds ?? [],
      cardFiles: job.result?.cardFiles ?? [],
      childJobIds: job.result?.childJobIds ?? [],
    };
  }

  private accumulatePostedMessage(jobId: string, messageId: string): void {
    const acc = this.getOrInitAccumulator(jobId);
    acc.postedMessageIds.push(messageId);
    this.queue.updateStatus(jobId, 'running', {
      result: { ok: true, ...acc },
    });
  }

  private accumulateCardFile(jobId: string, cardFile: string): void {
    const acc = this.getOrInitAccumulator(jobId);
    acc.cardFiles.push(cardFile);
    this.queue.updateStatus(jobId, 'running', {
      result: { ok: true, ...acc },
    });
  }

  private accumulateChildJob(jobId: string, childJobId: string): void {
    const acc = this.getOrInitAccumulator(jobId);
    acc.childJobIds.push(childJobId);
    this.queue.updateStatus(jobId, 'running', {
      result: { ok: true, ...acc },
    });
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
