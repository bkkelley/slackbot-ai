import * as fs from 'fs';
import * as path from 'path';
import { AgentJob } from './types.js';

export type NotificationMode = 'immediate' | 'failures_only' | 'digest' | 'silent';
export type NotificationSeverity = 'info' | 'warn' | 'error' | 'critical';

export interface QuietHours {
  enabled?: boolean;
  start?: string;
  end?: string;
  timezone?: string;
  allowFailures?: boolean;
}

export interface NotificationPreference {
  mode?: NotificationMode;
  notifyOnFailure?: boolean;
  channel?: { platform: string; id: string };
  minSeverity?: NotificationSeverity;
  quietHours?: QuietHours;
}

export interface NotificationPolicy {
  enabled?: boolean;
  default?: NotificationPreference;
  agents?: Record<string, NotificationPreference>;
  workflows?: Record<string, NotificationPreference>;
  toolsets?: Record<string, NotificationPreference>;
  triggers?: Record<string, NotificationPreference>;
}

export interface ResolvedNotificationPreference {
  mode: NotificationMode;
  notifyOnFailure: boolean;
  channel?: { platform: string; id: string };
  minSeverity: NotificationSeverity;
  quietHours?: QuietHours;
}

const NOTIFICATIONS_PATH = process.env.NOTIFICATIONS_PATH || path.join(
  path.dirname(path.dirname(new URL(import.meta.url).pathname)),
  'notifications.json'
);

export function loadNotificationPolicy(): NotificationPolicy {
  try {
    return JSON.parse(fs.readFileSync(NOTIFICATIONS_PATH, 'utf8')) as NotificationPolicy;
  } catch {
    return {
      enabled: true,
      default: { mode: 'immediate', notifyOnFailure: true },
    };
  }
}

export function saveNotificationPolicy(policy: NotificationPolicy): NotificationPolicy {
  const normalized = normalizeNotificationPolicy(policy);
  fs.mkdirSync(path.dirname(NOTIFICATIONS_PATH), { recursive: true });
  const tmpPath = `${NOTIFICATIONS_PATH}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, NOTIFICATIONS_PATH);
  return normalized;
}

export function getNotificationPolicyPath(): string {
  return NOTIFICATIONS_PATH;
}

export function resolveNotificationPreference(
  job: Partial<Pick<AgentJob, 'agent' | 'workflow' | 'toolset' | 'trigger'>> | undefined,
  policy = loadNotificationPolicy()
): ResolvedNotificationPreference {
  const fallback: ResolvedNotificationPreference = {
    mode: policy.enabled === false ? 'silent' : 'immediate',
    notifyOnFailure: true,
    minSeverity: 'info',
  };

  if (policy.enabled === false) return fallback;

  return [
    policy.default,
    job?.trigger ? policy.triggers?.[job.trigger] : undefined,
    job?.toolset ? policy.toolsets?.[job.toolset] : undefined,
    job?.workflow ? policy.workflows?.[job.workflow] : undefined,
    job?.agent ? policy.agents?.[job.agent] : undefined,
  ].filter(Boolean).reduce<ResolvedNotificationPreference>((merged, pref) => {
    const next = pref as NotificationPreference;
    return {
      ...merged,
      ...next,
      mode: next.mode ?? merged.mode,
      notifyOnFailure: next.notifyOnFailure ?? merged.notifyOnFailure,
      minSeverity: next.minSeverity ?? merged.minSeverity,
      quietHours: next.quietHours ?? merged.quietHours,
    };
  }, fallback);
}

export function shouldSendNotification(
  preference: ResolvedNotificationPreference,
  kind: 'normal' | 'failure',
  severity: NotificationSeverity = kind === 'failure' ? 'error' : 'info',
  now = new Date()
): boolean {
  const effectiveSeverity = isSeverity(severity) ? severity : kind === 'failure' ? 'error' : 'info';
  const minSeverity = isSeverity(preference.minSeverity) ? preference.minSeverity : 'info';
  if (preference.mode === 'silent') return false;
  if (preference.mode === 'digest' && kind !== 'failure') return false;
  if (!meetsSeverity(effectiveSeverity, minSeverity)) return false;
  if (isQuietNow(preference.quietHours, now)) {
    if (kind !== 'failure') return false;
    if (preference.quietHours?.allowFailures === false) return false;
  }
  if (kind === 'failure') return preference.notifyOnFailure !== false;
  return preference.mode === 'immediate';
}

function normalizeNotificationPolicy(policy: NotificationPolicy): NotificationPolicy {
  const normalizePreference = (preference?: NotificationPreference): NotificationPreference | undefined => {
    if (!preference || typeof preference !== 'object') return undefined;
    const normalized: NotificationPreference = {};
    if (isMode(preference.mode)) normalized.mode = preference.mode;
    if (typeof preference.notifyOnFailure === 'boolean') normalized.notifyOnFailure = preference.notifyOnFailure;
    if (isSeverity(preference.minSeverity)) normalized.minSeverity = preference.minSeverity;
    if (preference.channel && typeof preference.channel === 'object') {
      const platform = String(preference.channel.platform || '').trim();
      const id = String(preference.channel.id || '').trim();
      if (platform && id) normalized.channel = { platform, id };
    }
    const quietHours = normalizeQuietHours(preference.quietHours);
    if (quietHours) normalized.quietHours = quietHours;
    return Object.keys(normalized).length ? normalized : {};
  };

  const normalizePreferences = (preferences?: Record<string, NotificationPreference>): Record<string, NotificationPreference> => {
    const normalized: Record<string, NotificationPreference> = {};
    for (const [name, preference] of Object.entries(preferences ?? {})) {
      const key = name.trim();
      if (!key) continue;
      const normalizedPreference = normalizePreference(preference);
      if (normalizedPreference) normalized[key] = normalizedPreference;
    }
    return normalized;
  };

  return {
    enabled: policy.enabled !== false,
    default: normalizePreference(policy.default) ?? { mode: 'immediate', notifyOnFailure: true },
    agents: normalizePreferences(policy.agents),
    workflows: normalizePreferences(policy.workflows),
    toolsets: normalizePreferences(policy.toolsets),
    triggers: normalizePreferences(policy.triggers),
  };
}

function normalizeQuietHours(quietHours?: QuietHours): QuietHours | undefined {
  if (!quietHours || typeof quietHours !== 'object') return undefined;
  const start = normalizeTime(quietHours.start);
  const end = normalizeTime(quietHours.end);
  if (!quietHours.enabled) return undefined;
  const normalized: QuietHours = {
    enabled: true,
    allowFailures: quietHours.allowFailures !== false,
  };
  normalized.start = start ?? '22:00';
  normalized.end = end ?? '07:00';
  const timezone = String(quietHours.timezone || '').trim();
  if (timezone) normalized.timezone = timezone;
  return normalized;
}

function normalizeTime(value: unknown): string | undefined {
  const text = String(value || '').trim();
  return timeToMinutes(text) !== null ? text : undefined;
}

function isMode(value: unknown): value is NotificationMode {
  return value === 'immediate' || value === 'failures_only' || value === 'silent' || value === 'digest';
}

function isSeverity(value: unknown): value is NotificationSeverity {
  return value === 'info' || value === 'warn' || value === 'error' || value === 'critical';
}

function meetsSeverity(actual: NotificationSeverity, minimum: NotificationSeverity): boolean {
  const rank: Record<NotificationSeverity, number> = { info: 0, warn: 1, error: 2, critical: 3 };
  return rank[actual] >= rank[minimum];
}

function isQuietNow(quietHours: QuietHours | undefined, now: Date): boolean {
  if (!quietHours?.enabled || !quietHours.start || !quietHours.end) return false;
  const minutes = localMinutes(now, quietHours.timezone);
  const start = timeToMinutes(quietHours.start);
  const end = timeToMinutes(quietHours.end);
  if (start === null || end === null || start === end) return false;
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

function localMinutes(now: Date, timezone?: string): number {
  if (!timezone) return now.getHours() * 60 + now.getMinutes();
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(now);
    const hour = Number(parts.find((part) => part.type === 'hour')?.value);
    const minute = Number(parts.find((part) => part.type === 'minute')?.value);
    if (Number.isFinite(hour) && Number.isFinite(minute)) return hour * 60 + minute;
  } catch { /* invalid timezone falls back to local time */ }
  return now.getHours() * 60 + now.getMinutes();
}

function timeToMinutes(value: string): number | null {
  const match = value.match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}
