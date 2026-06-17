import { ConversationSession } from '../types';
import { Platform } from './types';
import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';

const SESSIONS_FILE = path.join(homedir(), '.claude', 'slack-bot-sessions.json');

export class SessionManager {
  private sessions: Map<string, ConversationSession> = new Map();

  constructor() {
    this.loadSessions();
  }

  private loadSessions(): void {
    try {
      if (fs.existsSync(SESSIONS_FILE)) {
        const data = fs.readFileSync(SESSIONS_FILE, 'utf-8');
        const sessions = JSON.parse(data);
        for (const [key, session] of Object.entries(sessions)) {
          this.sessions.set(key, {
            ...(session as ConversationSession),
            lastActivity: new Date((session as any).lastActivity),
          });
        }
      }
    } catch (error) {
      console.error('Failed to load sessions:', error);
    }
  }

  private saveSessions(): void {
    try {
      const dir = path.dirname(SESSIONS_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const data: Record<string, ConversationSession> = {};
      for (const [key, session] of this.sessions.entries()) {
        data[key] = session;
      }
      fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2), 'utf-8');
    } catch (error) {
      console.error('Failed to save sessions:', error);
    }
  }

  /**
   * Build a session key that includes platform so Slack and Discord sessions
   * never collide even if channelId/threadId happen to match.
   *
   * Key format:
   *   `${platform}:${channelId}:t=${threadId}`   when threadId is provided
   *   `${platform}:${channelId}:m=${messageId}`  when only messageId is provided
   *   `${platform}:${channelId}`                 when neither is provided
   */
  getSessionKey(
    platform: Platform,
    channelId: string,
    threadId?: string,
    messageId?: string,
  ): string {
    if (threadId) return `${platform}:${channelId}:t=${threadId}`;
    if (messageId) return `${platform}:${channelId}:m=${messageId}`;
    return `${platform}:${channelId}`;
  }

  getSession(
    platform: Platform,
    channelId: string,
    threadId?: string,
    messageId?: string,
  ): ConversationSession | undefined {
    const session = this.sessions.get(this.getSessionKey(platform, channelId, threadId, messageId));
    if (session) {
      session.lastActivity = new Date();
      this.saveSessions();
    }
    return session;
  }

  createSession(
    platform: Platform,
    userId: string,
    channelId: string,
    threadId?: string,
    messageId?: string,
  ): ConversationSession {
    const session: ConversationSession = {
      userId,
      channelId,
      threadTs: threadId,
      isActive: true,
      lastActivity: new Date(),
    };
    this.sessions.set(this.getSessionKey(platform, channelId, threadId, messageId), session);
    this.saveSessions();
    return session;
  }

  cleanupInactiveSessions(maxAge: number = 7 * 24 * 60 * 60 * 1000): void {
    const now = Date.now();
    let deleted = false;
    for (const [key, session] of this.sessions.entries()) {
      if (now - session.lastActivity.getTime() > maxAge) {
        this.sessions.delete(key);
        deleted = true;
      }
    }
    if (deleted) {
      this.saveSessions();
    }
  }
}
