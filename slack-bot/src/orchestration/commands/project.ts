import * as fs from 'fs';
import { CommandContext } from './types';
import {
  loadChannelProjects,
  saveChannelProjects,
  sanitizeProject,
  projectDir,
  listProjects,
  loadManifest,
  addChannelToManifest,
  setSalesforce,
  setDrivePath,
  isSalesforceId,
} from '../channel-projects';

/**
 * `$project` — manage a channel's project and its cross-system bindings. A mapped channel makes the
 * bot run Claude in that project's directory, with a context preamble carrying the project's
 * Salesforce records and Google Drive folder.
 *
 *   $project                          show this channel's project + bindings
 *   $project map <name>               map this channel to project <name> (or an absolute path)
 *   $project unmap                    remove this channel's mapping
 *   $project list                     list known project folders
 *   $project sf <org> <acctId> <projId>   bind the Salesforce org + Account + Project__c
 *   $project drive <absolute path>    bind the Google Drive folder (local synced path)
 */
export class ProjectCommand {
  async handle(ctx: CommandContext): Promise<boolean> {
    const { text, channel, thread_ts, ts, say } = ctx;
    const trimmed = text.trim();
    if (!/^\$project(\s|$)/i.test(trimmed)) return false;

    const reply = (t: string) => say({ text: t, thread_ts: thread_ts || ts });
    const arg = trimmed.slice('$project'.length).trim();
    const isDM = channel.startsWith('D');
    const currentProject = () => loadChannelProjects()[channel];

    // $project list
    if (/^list$/i.test(arg)) {
      const projects = listProjects();
      await reply(projects.length ? `*Projects:*\n${projects.map((p) => `• \`${p}\``).join('\n')}` : '_No project folders yet._');
      return true;
    }

    // $project map <name>
    if (/^map(\s|$)/i.test(arg)) {
      if (isDM) {
        await reply('Channel mapping only works in a channel. In a DM, start a message with `project: <name>` to scope this thread.');
        return true;
      }
      const name = sanitizeProject(arg.replace(/^map\s*/i, ''));
      if (!name) {
        await reply('Usage: `$project map <name>` — e.g. `$project map acme-api` (or an absolute path).');
        return true;
      }
      const map = loadChannelProjects();
      map[channel] = name;
      try {
        saveChannelProjects(map);
        addChannelToManifest(name, channel);
      } catch (err) {
        await reply(`⚠️ Couldn't save the mapping (${String(err).slice(0, 120)}).`);
        return true;
      }
      await reply(`✅ Mapped this channel → 📁 *${name}*\nWorking dir: \`${projectDir(name)}\`\nNow bind its systems: \`$project sf <org> <accountId> <projectId>\` and \`$project drive <path>\`.`);
      return true;
    }

    // $project unmap
    if (/^unmap$/i.test(arg)) {
      const map = loadChannelProjects();
      if (!map[channel]) {
        await reply('This channel isn’t mapped to a project.');
        return true;
      }
      delete map[channel];
      try {
        saveChannelProjects(map);
      } catch (err) {
        await reply(`⚠️ Couldn't save the change (${String(err).slice(0, 120)}).`);
        return true;
      }
      await reply('✅ Unmapped. Messages here now use the *general* workspace. (The project folder + its `project.json` are left intact.)');
      return true;
    }

    // $project sf <org> <accountId> <projectId>
    if (/^sf(\s|$)/i.test(arg)) {
      const proj = currentProject();
      if (!proj) {
        await reply('Map this channel to a project first: `$project map <name>`.');
        return true;
      }
      const [org, acct, projId] = arg.replace(/^sf\s*/i, '').trim().split(/\s+/);
      if (!org || !acct || !projId) {
        await reply('Usage: `$project sf <org-alias> <AccountId> <Project__cId>` — paste the 15/18-char record IDs from Salesforce.');
        return true;
      }
      if (!isSalesforceId(acct) || !isSalesforceId(projId)) {
        await reply('That doesn’t look like a Salesforce record ID (expected 15 or 18 alphanumeric chars). Check the Account Id and Project__c Id.');
        return true;
      }
      try {
        setSalesforce(proj, org, acct, projId);
      } catch (err) {
        await reply(`⚠️ Couldn't save (${String(err).slice(0, 120)}).`);
        return true;
      }
      await reply(`✅ *${proj}* → Salesforce org \`${org}\`, Account \`${acct}\`, Project__c \`${projId}\`.\nI'll query these automatically when working here.`);
      return true;
    }

    // $project drive <path>
    if (/^drive(\s|$)/i.test(arg)) {
      const proj = currentProject();
      if (!proj) {
        await reply('Map this channel to a project first: `$project map <name>`.');
        return true;
      }
      const p = arg.replace(/^drive\s*/i, '').trim().replace(/^["']|["']$/g, '');
      if (!p || !p.startsWith('/')) {
        await reply('Usage: `$project drive <absolute path>` — e.g. the synced Google Drive folder `/Users/you/Library/CloudStorage/GoogleDrive-…/My Drive/Clients/Acme`.');
        return true;
      }
      try {
        setDrivePath(proj, p);
      } catch (err) {
        await reply(`⚠️ Couldn't save (${String(err).slice(0, 120)}).`);
        return true;
      }
      const exists = fs.existsSync(p);
      await reply(`✅ *${proj}* → Drive folder \`${p}\`${exists ? '' : '\n⚠️ That path doesn’t exist yet — double-check it (Google Drive for Desktop must be syncing it).'}`);
      return true;
    }

    // $project (show)
    const proj = currentProject();
    if (proj) {
      const m = loadManifest(proj);
      const lines = [`📁 This channel → *${proj}*`, `Working dir: \`${projectDir(proj)}\``];
      if (m.salesforce && (m.salesforce.accountId || m.salesforce.projectId)) {
        lines.push(`Salesforce: org \`${m.salesforce.org ?? '?'}\` · Account \`${m.salesforce.accountId ?? '—'}\` · Project__c \`${m.salesforce.projectId ?? '—'}\``);
      } else {
        lines.push('Salesforce: _not bound_ — `$project sf <org> <accountId> <projectId>`');
      }
      lines.push(m.drivePath ? `Drive: \`${m.drivePath}\`` : 'Drive: _not bound_ — `$project drive <path>`');
      if (m.channels && m.channels.length) lines.push(`Channels: ${m.channels.map((c) => `<#${c}>`).join(' ')}`);
      await reply(lines.join('\n'));
    } else if (isDM) {
      await reply('This DM uses the *general* workspace. Start a message with `project: <name>` to scope a thread.');
    } else {
      await reply('This channel isn’t mapped — it uses the *general* workspace.\nMap it with `$project map <name>` (or via the App Home tab), then bind `$project sf …` and `$project drive …`.');
    }
    return true;
  }
}
