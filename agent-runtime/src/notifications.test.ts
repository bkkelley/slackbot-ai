import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notifications-'));
  process.env.NOTIFICATIONS_PATH = path.join(root, 'notifications.json');

  const {
    resolveNotificationPreference,
    saveNotificationPolicy,
    shouldSendNotification,
  } = await import('./notifications.js');

  const saved = saveNotificationPolicy({
    enabled: true,
    default: {
      mode: 'digest',
      notifyOnFailure: true,
      minSeverity: 'warn',
      channel: { platform: 'slack', id: 'C123' },
      quietHours: { enabled: false, start: '22:00', end: '07:00', timezone: 'America/Chicago' },
    },
    agents: {
      Loud: {
        mode: 'immediate',
        notifyOnFailure: true,
        minSeverity: 'info',
        quietHours: { enabled: true, start: '22:00', end: '07:00', timezone: 'UTC', allowFailures: true },
      },
    },
    workflows: {},
    toolsets: {},
    triggers: {
      schedule: { mode: 'failures_only', notifyOnFailure: true },
    },
  });

  assert.equal(saved.default?.mode, 'digest');
  assert.equal(saved.default?.quietHours, undefined);
  assert.equal(saved.agents?.Loud?.quietHours?.enabled, true);

  const digest = resolveNotificationPreference(undefined, saved);
  assert.equal(shouldSendNotification(digest, 'normal', 'critical'), false);
  assert.equal(shouldSendNotification(digest, 'failure', 'error'), true);
  assert.equal(shouldSendNotification(digest, 'normal', 'info'), false);

  const scheduled = resolveNotificationPreference({ trigger: 'schedule' }, saved);
  assert.equal(shouldSendNotification(scheduled, 'normal', 'warn'), false);
  assert.equal(shouldSendNotification(scheduled, 'failure', 'error'), true);

  const loud = resolveNotificationPreference({ agent: 'Loud' }, saved);
  assert.equal(shouldSendNotification(loud, 'normal', 'info', new Date('2026-06-09T12:00:00Z')), true);
  assert.equal(shouldSendNotification(loud, 'normal', 'warn', new Date('2026-06-09T23:00:00Z')), false);
  assert.equal(shouldSendNotification(loud, 'failure', 'error', new Date('2026-06-09T23:00:00Z')), true);

  assert.equal(shouldSendNotification(loud, 'normal', 'bogus' as never, new Date('2026-06-09T12:00:00Z')), true);

  console.log('notification policy tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
