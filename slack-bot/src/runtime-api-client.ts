import { config } from './config.js';
import { Logger } from './logger.js';

const logger = new Logger('RuntimeApiClient');

export interface SubmitJobRequest {
  agent?: string;
  action?: string;
  prompt?: string;
  mode: 'sync' | 'async';
  toolset?: 'default' | 'extended';
  outputChannel?: { platform: string; id: string };
  threadId?: string;
  files?: string[];
  replyText?: string;
  sessionId?: string;
  trigger?: 'manual' | 'schedule' | 'spawn';
}

export interface SubmitJobResponse {
  jobId: string;
  status: string;
  result?: {
    ok: boolean;
    error?: string;
    postedMessageIds: string[];
    cardFiles: string[];
    childJobIds: string[];
  };
}

export class RuntimeApiClient {
  private baseUrl: string;
  private secret: string;

  constructor() {
    this.baseUrl = `http://127.0.0.1:${config.runtimeHttpPort}`;
    this.secret = config.botRuntimeSharedSecret;
  }

  async submitJob(req: SubmitJobRequest): Promise<SubmitJobResponse> {
    logger.debug('Submitting job to runtime', { agent: req.agent, action: req.action, mode: req.mode });
    const response = await fetch(`${this.baseUrl}/api/jobs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Bot-Auth': this.secret,
      },
      body: JSON.stringify(req),
    });
    if (!response.ok) {
      throw new Error(`Runtime API error: ${response.status} ${await response.text()}`);
    }
    return response.json() as Promise<SubmitJobResponse>;
  }
}
