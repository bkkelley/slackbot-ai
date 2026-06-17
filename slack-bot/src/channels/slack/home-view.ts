import { fetchInbox, fetchCalendar } from './outlook';
import { loadChannelProjects, projectDir, listProjects } from '../../orchestration/channel-projects';

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const section = (text: string): Record<string, unknown> => ({ type: 'section', text: { type: 'mrkdwn', text } });

/**
 * App Home tab: 📥 last 10 Outlook emails, 📅 upcoming events, and 📁 channel → project mappings.
 * Outlook data is pulled on open + the Refresh button. Owner-lock is enforced by the caller.
 */
export async function buildHomeBlocks(): Promise<object[]> {
  const [inbox, cal] = await Promise.all([fetchInbox(10), fetchCalendar(7, 10)]);
  const mappings = Object.entries(loadChannelProjects());

  const blocks: Record<string, unknown>[] = [
    { type: 'header', text: { type: 'plain_text', text: '🤖 Claude Bot' } },
    section('Mention me in a mapped channel and I’ll work in that project. DM me anytime.'),
    { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: '🔄 Refresh' }, action_id: 'home_refresh' }] },
  ];

  // 📥 Inbox
  blocks.push({ type: 'divider' }, { type: 'header', text: { type: 'plain_text', text: '📥 Inbox' } });
  if (inbox.ok) {
    for (const m of inbox.messages) {
      blocks.push(section(`*${esc(m.sender)}*  ·  ${esc(m.subject)}\n_${esc(m.time)}_`));
    }
  } else {
    blocks.push(section(`_${esc(inbox.reason)}_`));
  }

  // 📅 Upcoming
  blocks.push({ type: 'divider' }, { type: 'header', text: { type: 'plain_text', text: '📅 Upcoming' } });
  if (cal.ok) {
    for (const ev of cal.events) {
      blocks.push(section(`*${esc(ev.subject)}*\n_${esc(ev.when)}_`));
    }
  } else {
    blocks.push(section(`_${esc(cal.reason)}_`));
  }

  // 📁 Channel → project mappings
  blocks.push({ type: 'divider' }, { type: 'header', text: { type: 'plain_text', text: '📁 Channel → project' } });
  if (!mappings.length) {
    blocks.push(section('_No channels mapped._ Add one below, or run `$project map <name>` from inside a channel.'));
  } else {
    const MAX = 80;
    for (const [cid, proj] of mappings.slice(0, MAX)) {
      blocks.push({
        type: 'section',
        block_id: `map_${cid}`,
        text: { type: 'mrkdwn', text: `<#${cid}>  →  📁 *${esc(proj)}*\n\`${esc(projectDir(proj))}\`` },
        accessory: {
          type: 'button',
          text: { type: 'plain_text', text: 'Unmap' },
          style: 'danger',
          value: cid,
          action_id: `home_unmap:${cid}`,
          confirm: {
            title: { type: 'plain_text', text: 'Unmap channel?' },
            text: { type: 'mrkdwn', text: 'Messages there will use the *general* workspace.' },
            confirm: { type: 'plain_text', text: 'Unmap' },
            deny: { type: 'plain_text', text: 'Keep' },
          },
        },
      });
    }
    if (mappings.length > MAX) {
      blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `…and ${mappings.length - MAX} more.` }] });
    }
  }
  blocks.push({ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: '➕ Add / change a mapping' }, action_id: 'home_add_mapping' }] });

  blocks.push(
    { type: 'divider' },
    { type: 'context', elements: [{ type: 'mrkdwn', text: 'In a channel: `$project map <name>` · `$project unmap`. In a DM: `project: <name>` to scope a thread. `$help` for all commands.' }] }
  );

  return blocks;
}

/** Non-owner Home view (owner-lock notice). */
export function privateHomeBlocks(): object[] {
  return [section('🔒 This assistant is private to its owner.')];
}

/** Modal for adding/changing a channel → project mapping (callback_id home_map_submit). */
export function buildMapModal(): object {
  const projects = listProjects();
  const projBlocks: Record<string, unknown>[] = [];
  if (projects.length) {
    projBlocks.push({
      type: 'input',
      block_id: 'proj_select',
      optional: true,
      label: { type: 'plain_text', text: 'Existing project' },
      element: {
        type: 'static_select',
        action_id: 'val',
        placeholder: { type: 'plain_text', text: 'Pick a project…' },
        options: projects.slice(0, 100).map((p) => ({ text: { type: 'plain_text', text: p.slice(0, 75) }, value: p })),
      },
    });
  }
  projBlocks.push({
    type: 'input',
    block_id: 'proj_new',
    optional: projects.length > 0,
    label: { type: 'plain_text', text: 'Or a new project name / absolute path' },
    element: { type: 'plain_text_input', action_id: 'val', placeholder: { type: 'plain_text', text: 'e.g. acme-api' } },
  });

  const input = (block_id: string, label: string, placeholder: string): Record<string, unknown> => ({
    type: 'input',
    block_id,
    optional: true,
    label: { type: 'plain_text', text: label },
    element: { type: 'plain_text_input', action_id: 'val', placeholder: { type: 'plain_text', text: placeholder } },
  });

  return {
    type: 'modal',
    callback_id: 'home_map_submit',
    title: { type: 'plain_text', text: 'Map a channel' },
    submit: { type: 'plain_text', text: 'Save' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: 'chan',
        label: { type: 'plain_text', text: 'Channel' },
        element: { type: 'conversations_select', action_id: 'val', filter: { include: ['public', 'private'], exclude_bot_users: true } },
      },
      ...projBlocks,
      { type: 'divider' },
      { type: 'context', elements: [{ type: 'mrkdwn', text: '_Optional bindings — Salesforce (paste 15/18-char IDs) and the Google Drive folder path._' }] },
      input('sf_org', 'Salesforce org alias', 'e.g. ka'),
      input('sf_account', 'Salesforce Account Id', '001…'),
      input('sf_project', 'Salesforce Project__c Id', 'a0X…'),
      input('drive_path', 'Google Drive folder (absolute path)', '/Users/…/GoogleDrive-…/My Drive/Clients/Acme'),
    ],
  };
}
