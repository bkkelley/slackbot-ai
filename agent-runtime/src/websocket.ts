import type * as WebSocket from 'ws';
import { JobEvent } from './types.js';
import { Logger } from './logger.js';

const logger = new Logger('ws-manager');

export class WsManager {
  private subs: Map<string, Set<WebSocket.WebSocket>> = new Map();

  subscribe(jobId: string, ws: WebSocket.WebSocket): void {
    let set = this.subs.get(jobId);
    if (!set) {
      set = new Set();
      this.subs.set(jobId, set);
    }
    set.add(ws);
    ws.on('close', () => {
      set!.delete(ws);
      if (set!.size === 0) this.subs.delete(jobId);
    });
    logger.debug('WS subscribed', { jobId, subscribers: set.size });
  }

  emit(jobId: string, event: JobEvent): void {
    const set = this.subs.get(jobId);
    if (!set || set.size === 0) return;
    const data = JSON.stringify(event);
    for (const ws of set) {
      try {
        if ((ws as unknown as { readyState: number }).readyState === 1 /* OPEN */) {
          (ws as unknown as { send: (d: string) => void }).send(data);
        }
      } catch (err) {
        logger.warn('WS send failed', { error: String(err) });
      }
    }
  }

  cleanup(jobId: string): void {
    this.subs.delete(jobId);
  }
}
