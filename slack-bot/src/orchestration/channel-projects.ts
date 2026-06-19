import * as fs from 'fs';
import * as path from 'path';

/**
 * Channel → project mapping. A "project" is a workspace directory; mapping a Slack channel to a
 * project means the bot runs Claude Code in that directory (and injects a short context preamble)
 * whenever it acts in that channel. Replaces the old per-channel "working directory" system.
 *
 * Mapping is explicit only: set via the `$project map <name>` command or the App Home modal.
 * Unmapped channels and DMs fall back to a single "general" workspace.
 */

const HOME = process.env.HOME || '';
const BASE_DIRECTORY = process.env.BASE_DIRECTORY || `${HOME}/claude-workspaces`;
const MAP_PATH = process.env.CHANNEL_PROJECTS_FILE || path.join(BASE_DIRECTORY, 'channel-projects.json');
const DEFAULT_PROJECT_DIR = path.join(BASE_DIRECTORY, 'general');

export type ChannelProjectMap = Record<string, string>;

export function loadChannelProjects(): ChannelProjectMap {
  try {
    return JSON.parse(fs.readFileSync(MAP_PATH, 'utf8')) as ChannelProjectMap;
  } catch {
    return {};
  }
}

export function saveChannelProjects(map: ChannelProjectMap): void {
  fs.mkdirSync(path.dirname(MAP_PATH), { recursive: true });
  fs.writeFileSync(MAP_PATH, JSON.stringify(map, null, 2) + '\n', 'utf8');
}

/**
 * Validate/clean a project reference. Accepts an absolute path (used verbatim — owner-trusted) or a
 * bare project name (letters, digits, space, dot, dash, underscore). Returns null if invalid.
 */
export function sanitizeProject(raw: string): string | null {
  const value = (raw || '').trim();
  if (!value) return null;
  if (value.startsWith('/')) return value.includes('..') ? null : value;
  if (!/^[A-Za-z0-9 ._-]{1,80}$/.test(value)) return null;
  if (value.includes('..')) return null;
  return value;
}

/** Resolve a project reference to an absolute directory. Bare names live under BASE_DIRECTORY. */
export function projectDir(project: string): string {
  return project.startsWith('/') ? project : path.join(BASE_DIRECTORY, project);
}

export interface ResolvedProject {
  dir: string;
  project: string | null; // null = the default "general" workspace (unmapped)
}

/**
 * Decide which directory Claude should run in for a given channel. Precedence:
 *   1. explicit channel → project mapping
 *   2. a per-thread DM project (set via `project: X`)
 *   3. the default "general" workspace
 * Always returns a usable directory (created on demand) — there is no "unset" state.
 */
export function resolveProject(channelId: string, dmThreadProject?: string | null): ResolvedProject {
  const mapped = loadChannelProjects()[channelId];
  const ref = mapped || dmThreadProject || null;
  const dir = ref ? projectDir(ref) : DEFAULT_PROJECT_DIR;
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* best-effort; Claude will surface a real error if the dir is unusable */
  }
  return { dir, project: ref };
}

// ── Project manifest (project.json) ────────────────────────────────────────────────────────────
// Each project folder can carry a project.json binding it to the other systems a consulting project
// spans: its Slack channels, the Salesforce org + Account + Project__c records, and the Google Drive
// folder (a local Google-Drive-for-Desktop path). The manifest is folded into the prompt context so
// Claude auto-resolves all of these from the channel.
export interface ProjectManifest {
  name: string;
  channels?: string[];
  salesforce?: { org?: string; accountId?: string; projectId?: string };
  drivePath?: string;
  aliases?: string[]; // extra names that should auto-scope a DM to this project (e.g. "grx", "good rx")
}

function manifestPath(project: string): string {
  return path.join(projectDir(project), 'project.json');
}

export function loadManifest(project: string): ProjectManifest {
  try {
    return JSON.parse(fs.readFileSync(manifestPath(project), 'utf8')) as ProjectManifest;
  } catch {
    return { name: project };
  }
}

export function saveManifest(project: string, m: ProjectManifest): void {
  const dir = projectDir(project);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(manifestPath(project), JSON.stringify(m, null, 2) + '\n', 'utf8');
}

/** Record a channel on the project's manifest (idempotent). */
export function addChannelToManifest(project: string, channelId: string): void {
  const m = loadManifest(project);
  m.name = m.name || project;
  m.channels = Array.from(new Set([...(m.channels ?? []), channelId]));
  saveManifest(project, m);
}

export function setSalesforce(project: string, org: string, accountId: string, projectId: string): void {
  const m = loadManifest(project);
  m.name = m.name || project;
  m.salesforce = { org, accountId, projectId };
  saveManifest(project, m);
}

export function setDrivePath(project: string, drivePath: string): void {
  const m = loadManifest(project);
  m.name = m.name || project;
  m.drivePath = drivePath;
  saveManifest(project, m);
}

export function setAliases(project: string, aliases: string[]): void {
  const m = loadManifest(project);
  m.name = m.name || project;
  m.aliases = aliases.map((a) => a.trim()).filter(Boolean);
  saveManifest(project, m);
}

/** A Salesforce 15- or 18-char record id (alphanumeric). */
export function isSalesforceId(v: string): boolean {
  return /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/.test((v || '').trim());
}

// ── Auto-detecting a client name in free-text (DM convenience) ───────────────────────────────────
// Reserved workspace names that are never "clients" and must not auto-scope.
const RESERVED_PROJECTS = new Set(['general', 'admin', 'node_modules']);

/** Known projects = channel-mapped names + workspace dirs that carry a project.json. */
export function listKnownProjects(): Array<{ name: string; aliases: string[] }> {
  const names = new Set<string>();
  for (const p of Object.values(loadChannelProjects())) {
    if (p && !p.startsWith('/') && !RESERVED_PROJECTS.has(p)) names.add(p);
  }
  try {
    for (const d of fs.readdirSync(BASE_DIRECTORY, { withFileTypes: true })) {
      if (!d.isDirectory() || d.name.startsWith('.') || RESERVED_PROJECTS.has(d.name)) continue;
      if (fs.existsSync(path.join(BASE_DIRECTORY, d.name, 'project.json'))) names.add(d.name);
    }
  } catch { /* base dir missing — no projects */ }
  return [...names].map((name) => {
    const m = loadManifest(name);
    return { name, aliases: Array.isArray(m.aliases) ? m.aliases : [] };
  });
}

/**
 * Find a known project/client named in free text (DM auto-scope). Whole-word, case-insensitive,
 * longest match wins. Candidates shorter than 3 chars are ignored to avoid false positives.
 * Returns the project name, or null if none is clearly mentioned (caller then keeps current scope).
 */
export function detectProjectInText(text: string): string | null {
  const hay = (text || '').toLowerCase();
  if (!hay.trim()) return null;
  let best: { name: string; len: number } | null = null;
  for (const { name, aliases } of listKnownProjects()) {
    for (const cand of [name, ...aliases]) {
      const c = (cand || '').toLowerCase().trim();
      if (c.length < 3 || RESERVED_PROJECTS.has(c)) continue;
      const esc = c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // bounded by string edge or a non-alphanumeric char (so "goodrx's" / "goodrx," match)
      if (new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`, 'i').test(hay)) {
        if (!best || c.length > best.len) best = { name, len: c.length };
      }
    }
  }
  return best ? best.name : null;
}

/** Context note prepended to the prompt when a project is active. Includes manifest bindings. */
export function projectPreamble(project: string | null, dir: string): string {
  if (!project) return '';
  const m = loadManifest(project);
  let s =
    `[Project context] You are working on the "${project}" project for this conversation. ` +
    `Its working directory is ${dir}; treat the files there as this project's codebase.\n`;
  const sf = m.salesforce;
  if (sf && (sf.accountId || sf.projectId)) {
    const parts: string[] = [];
    if (sf.accountId) parts.push(`Account ${sf.accountId}`);
    if (sf.projectId) parts.push(`Project__c ${sf.projectId}`);
    s +=
      `Salesforce (org "${sf.org ?? '?'}"): ${parts.join(', ')} — query these with the salesforce skill / ` +
      `\`sf\` CLI using \`--target-org ${sf.org ?? '<org>'}\`.\n`;
  }
  if (m.drivePath) {
    s += `Google Drive folder (local synced path — read/write files here directly): ${m.drivePath}\n`;
  }
  return s + '\n';
}

/** Existing project folders directly under BASE_DIRECTORY (for pickers / `$project list`). */
export function listProjects(): string[] {
  try {
    return fs
      .readdirSync(BASE_DIRECTORY, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'global' && e.name !== 'system')
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}
