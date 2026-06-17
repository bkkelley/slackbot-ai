import { Logger } from '../logger';
import * as path from 'path';
import * as fs from 'fs';

export const DEFAULT_MODEL = 'claude-sonnet-4-6';
export const MODELS: Record<string, string> = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-7',
};

const PERSIST_PATH = path.join(process.cwd(), 'data', 'models.json');

export class ModelManager {
  private models: Map<string, string> = new Map();
  private logger = new Logger('ModelManager');

  constructor() {
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    try {
      if (!fs.existsSync(PERSIST_PATH)) return;
      const entries = JSON.parse(fs.readFileSync(PERSIST_PATH, 'utf-8')) as Array<[string, string]>;
      for (const [key, value] of entries) this.models.set(key, value);
    } catch (err) {
      this.logger.warn('Failed to load models from disk', err);
    }
  }

  private saveToDisk(): void {
    try {
      const dir = path.dirname(PERSIST_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(PERSIST_PATH, JSON.stringify(Array.from(this.models.entries()), null, 2), 'utf-8');
    } catch (err) {
      this.logger.warn('Failed to persist models to disk', err);
    }
  }

  private key(channelId: string, threadTs?: string): string {
    return threadTs ? `${channelId}-${threadTs}` : channelId;
  }

  set(channelId: string, alias: string, threadTs?: string): { ok: boolean; model?: string; error?: string } {
    const model = MODELS[alias.toLowerCase()];
    if (!model) {
      return { ok: false, error: `Unknown model "${alias}". Use: ${Object.keys(MODELS).join(', ')}` };
    }
    this.models.set(this.key(channelId, threadTs), model);
    this.saveToDisk();
    return { ok: true, model };
  }

  get(channelId: string, threadTs?: string): string {
    if (threadTs) {
      const threadModel = this.models.get(this.key(channelId, threadTs));
      if (threadModel) return threadModel;
    }
    return this.models.get(channelId) ?? DEFAULT_MODEL;
  }

  reset(channelId: string, threadTs?: string): void {
    this.models.delete(this.key(channelId, threadTs));
    this.saveToDisk();
  }

  label(model: string): string {
    return Object.entries(MODELS).find(([, v]) => v === model)?.[0] ?? model;
  }
}
