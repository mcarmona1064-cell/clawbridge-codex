/**
 * ClawBridge migration engine.
 *
 * Handles detection and migration from:
 *   - OpenClaw            (~/.openclaw, ~/openclaw, ~/clawdbot)
 *   - NanoClaw            (~/.nanoclaw)
 *   - clawbridge-agent    (~/.clawbridge with a non-codex AGENT_PROVIDER) —
 *                         in-place provider swap; data dir is shared with
 *                         clawbridge-codex, so this is just a config flip.
 */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import os from 'os';

import Database from 'better-sqlite3';

import { hindsightRetain, isHindsightAvailable, ensureClientBank } from '../memory/hindsight.js';
import type { MemorySegment } from '../memory/types.js';

// ─── Public types ────────────────────────────────────────────────────────────

export type MigrationSourceType = 'openclaw' | 'nanoclaw' | 'clawbridge';

export interface MigrationSource {
  type: MigrationSourceType;
  path: string;
}

export interface MigrationAudit {
  groups: string[];
  messageCount: number;
  memoryCount: number;
  scheduledTaskCount: number;
  skills: string[];
  channels: string[];
  configFiles: string[];
  tools: string[]; // MCP server names detected across groups
  apiKeys: string[]; // API key variable names found (not values)
  hasClaudeOAuth: boolean; // CLAUDE_CODE_OAUTH_TOKEN present
}

export type MigrationSelection = 'groups' | 'messages' | 'skills' | 'credentials';

export interface MigrationProgress {
  step: string;
  detail?: string;
}

export interface HindsightConfig {
  url: string;
  apiKey: string;
}

/** Raw memory row from source DB */
interface MemoryEntry {
  id?: string | number;
  content: string;
  segment: string;
  importance?: number;
  created_at?: string;
}

// ─── Detection ───────────────────────────────────────────────────────────────

const HOME = os.homedir();

const CANDIDATE_PATHS: Array<{ paths: string[]; type: MigrationSourceType }> = [
  {
    paths: [
      path.join(HOME, '.openclaw'),
      path.join(HOME, 'openclaw'),
      path.join(HOME, 'clawdbot'),
      path.join(HOME, 'Projects', 'openclaw'),
      path.join(HOME, 'projects', 'openclaw'),
    ],
    type: 'openclaw',
  },
  {
    paths: [
      path.join(HOME, '.nanoclaw'),
      path.join(HOME, 'nanoclaw'),
      path.join(HOME, 'Projects', 'nanoclaw'),
      path.join(HOME, 'projects', 'nanoclaw'),
    ],
    type: 'nanoclaw',
  },
  {
    // clawbridge-agent uses the same ~/.clawbridge/ data dir we use here.
    // We only treat it as a migration source if the existing .env declares
    // a non-codex AGENT_PROVIDER (handled in identifyType).
    paths: [path.join(HOME, '.clawbridge')],
    type: 'clawbridge',
  },
];

function identifyType(dir: string): MigrationSourceType | null {
  const pkgPath = path.join(dir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as {
        name?: string;
      };
      const name = (pkg.name ?? '').toLowerCase();
      if (name.includes('openclaw') || name.includes('clawdbot')) return 'openclaw';
      if (name.includes('nanoclaw')) return 'nanoclaw';
    } catch {
      // ignore
    }
  }
  const base = path.basename(dir).toLowerCase();
  if (base.includes('openclaw') || base.includes('clawdbot')) return 'openclaw';
  if (base.includes('nanoclaw')) return 'nanoclaw';

  // clawbridge-agent shares ~/.clawbridge/ with us. Treat it as a migration
  // source only if its .env still declares a non-codex AGENT_PROVIDER
  // (otherwise it's already migrated, or just an empty data dir).
  if (path.resolve(dir) === path.join(HOME, '.clawbridge')) {
    const envPath = path.join(dir, '.env');
    if (fs.existsSync(envPath)) {
      try {
        const env = fs.readFileSync(envPath, 'utf-8');
        const m = env.match(/^AGENT_PROVIDER=(.+)$/m);
        const provider = m ? m[1].trim().replace(/^['"]|['"]$/g, '') : '';
        if (provider && provider !== 'codex') return 'clawbridge';
      } catch {
        // unreadable .env — assume not a migration source
      }
    }
  }
  return null;
}

export async function detectInstall(): Promise<MigrationSource | null> {
  for (const { paths, type } of CANDIDATE_PATHS) {
    for (const candidate of paths) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        const detected = identifyType(candidate) ?? type;
        return { type: detected, path: candidate };
      }
    }
  }
  return null;
}

export function resolveManualPath(dir: string): MigrationSource | { error: string } {
  const resolved = path.resolve(dir);
  if (!fs.existsSync(resolved)) return { error: `Path not found: ${resolved}` };
  if (!fs.statSync(resolved).isDirectory()) return { error: `Not a directory: ${resolved}` };
  const type = identifyType(resolved);
  if (!type) {
    return {
      error: `Could not identify install type at ${resolved}. Is this an OpenClaw, NanoClaw, or clawbridge-agent directory?`,
    };
  }
  return { type, path: resolved };
}

// ─── Audit ───────────────────────────────────────────────────────────────────

function countSqliteRows(dbPath: string, table: string): number {
  try {
    const result = spawnSync('sqlite3', [dbPath, `SELECT COUNT(*) FROM ${table};`], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.status !== 0) return 0;
    return parseInt((result.stdout ?? '0').trim(), 10) || 0;
  } catch {
    return 0;
  }
}

function findDatabases(dir: string, maxDepth = 3): string[] {
  const dbs: string[] = [];
  function walk(current: string, depth: number): void {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(current, entry.name);
      if (entry.isFile() && (entry.name.endsWith('.db') || entry.name.endsWith('.sqlite'))) {
        dbs.push(full);
      } else if (entry.isDirectory() && entry.name !== 'node_modules') {
        walk(full, depth + 1);
      }
    }
  }
  walk(dir, 0);
  return dbs;
}

function findGroups(sourceDir: string): string[] {
  for (const rel of ['groups', 'data/groups', 'store/groups']) {
    const dir = path.join(sourceDir, rel);
    if (!fs.existsSync(dir)) continue;
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      // skip
    }
  }
  return [];
}

function findSkills(sourceDir: string): string[] {
  const skills: string[] = [];
  for (const rel of ['skills', 'src/skills', 'custom-skills', 'plugins']) {
    const dir = path.join(sourceDir, rel);
    if (!fs.existsSync(dir)) continue;
    try {
      fs.readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile() && (e.name.endsWith('.ts') || e.name.endsWith('.js') || e.name.endsWith('.md')))
        .forEach((e) => skills.push(e.name));
    } catch {
      // skip
    }
  }
  return skills;
}

function detectChannels(sourceDir: string): string[] {
  const channels: string[] = [];
  const envPaths = [
    path.join(sourceDir, '.env'),
    path.join(sourceDir, '.env.local'),
    path.join(sourceDir, 'config', '.env'),
  ];
  const channelPatterns: Array<[RegExp, string]> = [
    [/TELEGRAM.*TOKEN|TELEGRAM.*BOT/i, 'Telegram'],
    [/WHATSAPP/i, 'WhatsApp'],
    [/DISCORD.*TOKEN/i, 'Discord'],
    [/SLACK.*TOKEN|SLACK.*BOT/i, 'Slack'],
    [/GMAIL|GOOGLE.*OAUTH/i, 'Gmail'],
    [/SIGNAL/i, 'Signal'],
    [/TEAMS|MICROSOFT.*BOT/i, 'Teams'],
  ];
  for (const envPath of envPaths) {
    if (!fs.existsSync(envPath)) continue;
    try {
      const content = fs.readFileSync(envPath, 'utf-8');
      for (const [pattern, name] of channelPatterns) {
        if (pattern.test(content) && !channels.includes(name)) {
          channels.push(name);
        }
      }
    } catch {
      // skip
    }
  }
  return channels;
}

function findConfigFiles(sourceDir: string): string[] {
  return [
    '.env',
    '.env.local',
    'config.json',
    'config.yaml',
    'config.yml',
    'settings.json',
    'data/registered_groups.json',
    'store/groups.json',
  ].filter((rel) => fs.existsSync(path.join(sourceDir, rel)));
}

// ─── Tool / MCP server detection ─────────────────────────────────────────────

function detectTools(sourceDir: string): string[] {
  const tools: string[] = [];
  // Global container.json at source root or config/
  for (const rel of ['container.json', 'config/container.json', '.config/container.json']) {
    const p = path.join(sourceDir, rel);
    if (!fs.existsSync(p)) continue;
    try {
      const cfg = JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, unknown>;
      if (cfg['mcpServers'] && typeof cfg['mcpServers'] === 'object') {
        tools.push(...Object.keys(cfg['mcpServers'] as object));
      }
    } catch {
      /* skip */
    }
  }
  // Per-group container.json (deduplicate across groups)
  for (const rel of ['groups', 'data/groups', 'store/groups']) {
    const dir = path.join(sourceDir, rel);
    if (!fs.existsSync(dir)) continue;
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const cjPath = path.join(dir, entry.name, 'container.json');
        if (!fs.existsSync(cjPath)) continue;
        try {
          const cfg = JSON.parse(fs.readFileSync(cjPath, 'utf-8')) as Record<string, unknown>;
          if (cfg['mcpServers'] && typeof cfg['mcpServers'] === 'object') {
            for (const name of Object.keys(cfg['mcpServers'] as object)) {
              if (!tools.includes(name)) tools.push(name);
            }
          }
        } catch {
          /* skip */
        }
      }
    } catch {
      /* skip */
    }
    break; // only need the first groups dir that exists
  }
  return tools;
}

const API_KEY_PATTERNS: RegExp[] = [
  /^GROQ_API_KEY$/,
  /^ANTHROPIC_API_KEY$/,
  /^OPENAI_API_KEY$/,
  /^CLAUDE_CODE_OAUTH_TOKEN$/,
  /^HINDSIGHT_API_KEY$/,
  /^RETELL_API_KEY$/,
  /^GOOGLE_API_KEY$/,
  /^GITHUB_TOKEN$/,
  /^RESEND_API_KEY$/,
  /^STRIPE_.*KEY$/,
  /^TWILIO_/,
  /^MATRIX_/,
  /^SIGNAL_/,
  /.*_API_KEY$/,
  /.*_SECRET_KEY$/,
  /.*_ACCESS_TOKEN$/,
  /.*_AUTH_TOKEN$/,
];

function detectApiKeys(sourceDir: string): string[] {
  const keys: string[] = [];
  const envPaths = [
    path.join(sourceDir, '.env'),
    path.join(sourceDir, '.env.local'),
    path.join(sourceDir, 'config', '.env'),
  ];
  for (const envPath of envPaths) {
    if (!fs.existsSync(envPath)) continue;
    try {
      for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
        const match = line.match(/^([A-Z][A-Z0-9_]+)=(.+)/);
        if (!match) continue;
        const [, key, val] = match;
        if (val.trim() && API_KEY_PATTERNS.some((p) => p.test(key)) && !keys.includes(key)) {
          keys.push(key);
        }
      }
    } catch {
      /* skip */
    }
  }
  return keys;
}

// ─── Memory table detection ───────────────────────────────────────────────────

const MEMORY_TABLE_CANDIDATES = ['memories', 'memory_entries', 'agent_memories', 'tiered_memories'];

function detectMemoryTable(dbPath: string): string | null {
  for (const table of MEMORY_TABLE_CANDIDATES) {
    const result = spawnSync(
      'sqlite3',
      [dbPath, `SELECT name FROM sqlite_master WHERE type='table' AND name='${table}';`],
      {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    if (result.status === 0 && (result.stdout ?? '').trim() === table) {
      return table;
    }
  }
  return null;
}

function countMemoryEntries(dbPath: string): number {
  const table = detectMemoryTable(dbPath);
  if (!table) return 0;
  return countSqliteRows(dbPath, table);
}

function countScheduledTasks(dbPath: string): number {
  for (const table of ['scheduled_tasks', 'cron_tasks', 'tasks', 'jobs']) {
    const result = spawnSync(
      'sqlite3',
      [dbPath, `SELECT name FROM sqlite_master WHERE type='table' AND name='${table}';`],
      {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    if (result.status === 0 && (result.stdout ?? '').trim() === table) {
      return countSqliteRows(dbPath, table);
    }
  }
  return 0;
}

export async function auditInstall(source: MigrationSource): Promise<MigrationAudit> {
  const groups = findGroups(source.path);
  const dbs = findDatabases(source.path);
  let messageCount = 0;
  let memoryCount = 0;
  let scheduledTaskCount = 0;
  for (const db of dbs) {
    for (const table of ['messages', 'message', 'msgs']) {
      const count = countSqliteRows(db, table);
      if (count > 0) {
        messageCount += count;
        break;
      }
    }
    memoryCount += countMemoryEntries(db);
    scheduledTaskCount += countScheduledTasks(db);
  }
  const allEnvPaths = [
    path.join(source.path, '.env'),
    path.join(source.path, '.env.local'),
    path.join(source.path, 'config', '.env'),
  ];
  let hasClaudeOAuth = false;
  for (const ep of allEnvPaths) {
    if (fs.existsSync(ep) && fs.readFileSync(ep, 'utf-8').includes('CLAUDE_CODE_OAUTH_TOKEN=')) {
      hasClaudeOAuth = true;
      break;
    }
  }
  return {
    groups,
    messageCount,
    memoryCount,
    scheduledTaskCount,
    skills: findSkills(source.path),
    channels: detectChannels(source.path),
    configFiles: findConfigFiles(source.path),
    tools: detectTools(source.path),
    apiKeys: detectApiKeys(source.path),
    hasClaudeOAuth,
  };
}

// ─── SQLite full-table migration ─────────────────────────────────────────────

/**
 * Copy ALL tables from sourceDb into destDb.
 * Handles schema mismatches gracefully: only inserts columns that exist in dest.
 * Returns list of table names successfully migrated.
 */
function migrateAllSqliteTables(srcPath: string, destPath: string): string[] {
  const migrated: string[] = [];
  let srcDb: Database.Database | null = null;
  let destDb: Database.Database | null = null;

  try {
    srcDb = new Database(srcPath, { readonly: true });
    destDb = new Database(destPath);
    destDb.pragma('journal_mode = WAL');
    destDb.pragma('foreign_keys = OFF');

    // Get all user tables from source
    const srcTables = (
      srcDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);

    for (const tableName of srcTables) {
      try {
        // Get column info from source
        const srcCols = srcDb.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
          name: string;
          type: string;
          notnull: number;
          dflt_value: string | null;
          pk: number;
        }>;

        // Check if table exists in dest
        const destTableExists = destDb
          .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
          .get(tableName) as { name: string } | undefined;

        if (!destTableExists) {
          // Create table in dest using source schema
          const colDefs = srcCols
            .map((c) => {
              let def = `"${c.name}" ${c.type}`;
              if (c.pk) def += ' PRIMARY KEY';
              else if (c.notnull) def += ' NOT NULL';
              if (c.dflt_value !== null) def += ` DEFAULT ${c.dflt_value}`;
              return def;
            })
            .join(', ');
          destDb.exec(`CREATE TABLE IF NOT EXISTS "${tableName}" (${colDefs})`);
        }

        // Get dest columns (may differ from source)
        const destCols = (destDb.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>).map(
          (c) => c.name,
        );
        const srcColNames = srcCols.map((c) => c.name);

        // Only use columns that exist in both
        const sharedCols = srcColNames.filter((c) => destCols.includes(c));
        if (sharedCols.length === 0) continue;

        const colList = sharedCols.map((c) => `"${c}"`).join(', ');
        const placeholders = sharedCols.map(() => '?').join(', ');
        const insertStmt = destDb.prepare(`INSERT OR IGNORE INTO "${tableName}" (${colList}) VALUES (${placeholders})`);

        const rows = srcDb.prepare(`SELECT ${colList} FROM "${tableName}"`).all() as Record<string, unknown>[];

        const insertMany = destDb.transaction((rs: Record<string, unknown>[]) => {
          for (const row of rs) {
            const vals = sharedCols.map((c) => row[c] ?? null);
            insertStmt.run(vals);
          }
        });
        insertMany(rows);
        migrated.push(tableName);
      } catch {
        // Skip table on error — don't abort the whole migration
      }
    }
  } finally {
    srcDb?.close();
    destDb?.close();
  }

  return migrated;
}

// ─── Client slug derivation ───────────────────────────────────────────────────

/**
 * Derive a client slug from a group folder name.
 * Strips the channel prefix: "telegram_family-chat" → "family-chat"
 */
function groupFolderToSlug(folderName: string): string {
  const prefixes = ['telegram_', 'whatsapp_', 'discord_', 'slack_', 'gmail_', 'signal_', 'teams_'];
  for (const prefix of prefixes) {
    if (folderName.startsWith(prefix)) {
      return folderName.slice(prefix.length);
    }
  }
  return folderName;
}

// ─── Memory → Hindsight migration ────────────────────────────────────────────

const VALID_SEGMENTS = new Set<string>([
  'identity',
  'preference',
  'correction',
  'relationship',
  'knowledge',
  'behavioral',
  'context',
]);

function normalizeSegment(raw: string): MemorySegment {
  const lower = (raw ?? '').toLowerCase();
  if (VALID_SEGMENTS.has(lower)) return lower as MemorySegment;
  return 'knowledge'; // fallback
}

/**
 * Migrate source DB memory entries into Hindsight for a given client slug.
 * Returns { retained, failed, queued }.
 * If Hindsight is unreachable, entries are noted as "queued" (non-fatal).
 */
export async function migrateMemoryToHindsight(
  clientSlug: string,
  memories: MemoryEntry[],
  opts: { hindsightUrl: string; hindsightApiKey: string },
): Promise<{ retained: number; failed: number; queued: number }> {
  // Override env for this call
  const originalUrl = process.env['HINDSIGHT_URL'];
  const originalKey = process.env['HINDSIGHT_API_KEY'];
  process.env['HINDSIGHT_URL'] = opts.hindsightUrl;
  process.env['HINDSIGHT_API_KEY'] = opts.hindsightApiKey;

  try {
    const available = await isHindsightAvailable();
    if (!available) {
      return { retained: 0, failed: 0, queued: memories.length };
    }

    // Ensure the bank exists
    await ensureClientBank(clientSlug);

    let retained = 0;
    let failed = 0;
    const BATCH = 10;

    for (let i = 0; i < memories.length; i += BATCH) {
      const batch = memories.slice(i, i + BATCH);
      const results = await Promise.allSettled(
        batch.map((entry) =>
          hindsightRetain(clientSlug, entry.content, {
            segment: normalizeSegment(entry.segment),
            context: 'migration',
            documentId: entry.id != null ? `migrated-${clientSlug}-${entry.id}` : undefined,
            timestamp: entry.created_at ? new Date(entry.created_at) : undefined,
          }),
        ),
      );
      for (const r of results) {
        if (r.status === 'fulfilled') retained++;
        else failed++;
      }
    }

    return { retained, failed, queued: 0 };
  } finally {
    // Restore env
    if (originalUrl !== undefined) process.env['HINDSIGHT_URL'] = originalUrl;
    else delete process.env['HINDSIGHT_URL'];
    if (originalKey !== undefined) process.env['HINDSIGHT_API_KEY'] = originalKey;
    else delete process.env['HINDSIGHT_API_KEY'];
  }
}

/**
 * Read all memory entries for a given group from the source DB.
 */
function readMemoryEntries(dbPath: string, groupSlug?: string): MemoryEntry[] {
  const table = detectMemoryTable(dbPath);
  if (!table) return [];

  let srcDb: Database.Database | null = null;
  try {
    srcDb = new Database(dbPath, { readonly: true });
    const cols = (srcDb.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
    const hasClientId = cols.includes('client_id');
    const hasGroupSlug = cols.includes('group_slug');

    let rows: Record<string, unknown>[];
    if (groupSlug && hasClientId) {
      rows = srcDb.prepare(`SELECT * FROM "${table}" WHERE client_id = ?`).all(groupSlug) as Record<string, unknown>[];
    } else if (groupSlug && hasGroupSlug) {
      rows = srcDb.prepare(`SELECT * FROM "${table}" WHERE group_slug = ?`).all(groupSlug) as Record<string, unknown>[];
    } else {
      rows = srcDb.prepare(`SELECT * FROM "${table}"`).all() as Record<string, unknown>[];
    }

    return rows
      .map((r) => ({
        id: r['id'] as string | number | undefined,
        content: String(r['content'] ?? ''),
        segment: String(r['segment'] ?? r['type'] ?? 'knowledge'),
        importance: typeof r['importance'] === 'number' ? r['importance'] : 0.6,
        created_at: r['created_at'] as string | undefined,
      }))
      .filter((e) => e.content.trim().length > 0);
  } catch {
    return [];
  } finally {
    srcDb?.close();
  }
}

// OneCLI removed in v2.0.33 — credentials now injected directly from ~/.clawbridge/.env

// ─── Migration ───────────────────────────────────────────────────────────────

const CLAWBRIDGE_HOME = path.join(HOME, '.clawbridge');

function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirRecursive(srcPath, destPath);
    else if (entry.isFile()) fs.copyFileSync(srcPath, destPath);
  }
}

function resolveGroupsDir(sourceDir: string): string | null {
  for (const rel of ['groups', 'data/groups', 'store/groups']) {
    const dir = path.join(sourceDir, rel);
    if (fs.existsSync(dir)) return dir;
  }
  return null;
}

function resolveSkillsDir(sourceDir: string): string | null {
  for (const rel of ['skills', 'src/skills', 'custom-skills', 'plugins']) {
    const dir = path.join(sourceDir, rel);
    if (fs.existsSync(dir)) return dir;
  }
  return null;
}

function resolvePrimaryDb(sourceDir: string): string | null {
  for (const candidate of [
    path.join(sourceDir, 'store', 'messages.db'),
    path.join(sourceDir, 'data', 'messages.db'),
    path.join(sourceDir, 'messages.db'),
    path.join(sourceDir, 'data', 'data.db'),
    path.join(sourceDir, 'store', 'data.db'),
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return findDatabases(sourceDir)[0] ?? null;
}

export interface MigrationResult {
  tablesMigrated: string[];
  hindsightRetained: number;
  hindsightFailed: number;
  hindsightQueued: number;
  scheduledTasksMigrated: number;
}

export async function runMigration(
  source: MigrationSource,
  audit: MigrationAudit,
  selections: MigrationSelection[],
  onProgress?: (p: MigrationProgress) => void,
  hindsightCfg?: HindsightConfig,
): Promise<MigrationResult> {
  const emit = (step: string, detail?: string): void => onProgress?.({ step, detail });

  const result: MigrationResult = {
    tablesMigrated: [],
    hindsightRetained: 0,
    hindsightFailed: 0,
    hindsightQueued: 0,
    scheduledTasksMigrated: 0,
  };

  // clawbridge-agent → clawbridge-codex is an in-place migration: source is
  // the same ~/.clawbridge/ data dir we'd be migrating *into*. No copies
  // needed — just flip AGENT_PROVIDER so the next service start picks up the
  // codex docker image and codex provider modules.
  if (source.type === 'clawbridge') {
    emit('provider-swap', 'Switching AGENT_PROVIDER to codex in ~/.clawbridge/.env');
    const envPath = path.join(CLAWBRIDGE_HOME, '.env');
    if (fs.existsSync(envPath)) {
      let envContent = fs.readFileSync(envPath, 'utf-8');
      const providerLine = /^AGENT_PROVIDER=.*$/m;
      if (providerLine.test(envContent)) {
        envContent = envContent.replace(providerLine, 'AGENT_PROVIDER=codex');
      } else {
        envContent = envContent.trimEnd() + '\nAGENT_PROVIDER=codex\n';
      }
      fs.writeFileSync(envPath, envContent, 'utf-8');
    }
    emit('provider-swap', 'Done. Re-run `clawbridge-codex setup` (or restart the service) to pick up the codex image.');
    return result;
  }

  // 1. Backup existing ClawBridge data
  emit('backup', 'Creating backup of existing ClawBridge data…');
  const backupDir = path.join(CLAWBRIDGE_HOME, 'migration-backup');
  if (fs.existsSync(CLAWBRIDGE_HOME)) {
    fs.mkdirSync(backupDir, { recursive: true });
    for (const subdir of ['groups', 'skills', 'store']) {
      const src = path.join(CLAWBRIDGE_HOME, subdir);
      if (fs.existsSync(src)) copyDirRecursive(src, path.join(backupDir, subdir));
    }
  }

  // 2. Groups (including legacy CLAUDE.md/CLAUDE.local.md and conversations/ subdirs — full recursive copy; rename to AGENTS.* happens at first spawn via migrateGroupsToAgentsLocal)
  if (selections.includes('groups') && audit.groups.length > 0) {
    emit('groups', `Migrating ${audit.groups.length} group(s) (including persona files and conversation history)…`);
    const srcGroupsDir = resolveGroupsDir(source.path);
    if (srcGroupsDir) {
      const destGroupsDir = path.join(CLAWBRIDGE_HOME, 'groups');
      fs.mkdirSync(destGroupsDir, { recursive: true });
      for (const group of audit.groups) {
        emit('groups', `  Copying: ${group}`);
        // copyDirRecursive copies everything recursively — persona files, conversations/, etc.
        copyDirRecursive(path.join(srcGroupsDir, group), path.join(destGroupsDir, group));
      }
    }
  }

  // 3. Message history — full SQLite migration (all tables)
  if (selections.includes('messages') && audit.messageCount > 0) {
    emit('messages', `Migrating ${audit.messageCount.toLocaleString()} messages (all tables)…`);
    const srcDb = resolvePrimaryDb(source.path);
    if (srcDb) {
      const destStoreDir = path.join(CLAWBRIDGE_HOME, 'store');
      fs.mkdirSync(destStoreDir, { recursive: true });
      const destDb = path.join(destStoreDir, 'messages.db');

      // Full table-by-table copy
      emit('messages', '  Copying all SQLite tables…');
      result.tablesMigrated = migrateAllSqliteTables(srcDb, destDb);
      emit('messages', `  Tables migrated: ${result.tablesMigrated.join(', ') || 'none'}`);

      // Count scheduled tasks in dest
      if (result.tablesMigrated.some((t) => ['scheduled_tasks', 'cron_tasks', 'tasks', 'jobs'].includes(t))) {
        for (const table of ['scheduled_tasks', 'cron_tasks', 'tasks', 'jobs']) {
          if (result.tablesMigrated.includes(table)) {
            result.scheduledTasksMigrated = countSqliteRows(destDb, table);
            emit('messages', `  Scheduled tasks migrated: ${result.scheduledTasksMigrated}`);
            break;
          }
        }
      }

      // Migrate memories to Hindsight if enabled
      if (hindsightCfg && audit.memoryCount > 0) {
        emit('hindsight', `Migrating ${audit.memoryCount} memory entries to Hindsight…`);
        const allMemories = readMemoryEntries(srcDb);

        if (allMemories.length > 0) {
          // Group memories by client slug if possible, otherwise use a shared bank
          const bySlug = new Map<string, MemoryEntry[]>();
          for (const mem of allMemories) {
            // Try to get client_id from the raw row — readMemoryEntries returns flat list
            // Default to 'global' if no per-client grouping is found
            const slug = 'global';
            const list = bySlug.get(slug) ?? [];
            list.push(mem);
            bySlug.set(slug, list);
          }

          // Also try per-group migration for groups that were migrated
          if (selections.includes('groups')) {
            for (const group of audit.groups) {
              const slug = groupFolderToSlug(group);
              const groupMemories = readMemoryEntries(srcDb, slug);
              if (groupMemories.length > 0) {
                bySlug.set(slug, groupMemories);
                // Remove from global if found per-group
                const globalList = bySlug.get('global') ?? [];
                bySlug.set(
                  'global',
                  globalList.filter((m) => !groupMemories.includes(m)),
                );
              }
            }
          }

          for (const [slug, memories] of bySlug) {
            if (memories.length === 0) continue;
            emit('hindsight', `  Retaining ${memories.length} memories for bank: ${slug}…`);
            const { retained, failed, queued } = await migrateMemoryToHindsight(slug, memories, {
              hindsightUrl: hindsightCfg.url,
              hindsightApiKey: hindsightCfg.apiKey,
            });
            result.hindsightRetained += retained;
            result.hindsightFailed += failed;
            result.hindsightQueued += queued;
          }

          if (result.hindsightQueued > 0) {
            // Persist queued memories to disk so they survive restarts and sync on next startup
            const queuePath = path.join(CLAWBRIDGE_HOME, 'memory-migration-queue.json');
            const queuePayload = { queuedAt: new Date().toISOString(), entries: allMemories };
            fs.mkdirSync(CLAWBRIDGE_HOME, { recursive: true });
            fs.writeFileSync(queuePath, JSON.stringify(queuePayload, null, 2));
            emit(
              'hindsight',
              `  ⚠ Hindsight not reachable — ${result.hindsightQueued} memories saved to ~/.clawbridge/memory-migration-queue.json for first-startup sync`,
            );
          } else {
            emit('hindsight', `  Retained: ${result.hindsightRetained}, Failed: ${result.hindsightFailed}`);
          }
        }
      }
    }
  }

  // 4. Skills
  if (selections.includes('skills') && audit.skills.length > 0) {
    emit('skills', `Migrating ${audit.skills.length} skill(s)…`);
    const srcSkillsDir = resolveSkillsDir(source.path);
    if (srcSkillsDir) {
      const destSkillsDir = path.join(CLAWBRIDGE_HOME, 'skills');
      fs.mkdirSync(destSkillsDir, { recursive: true });
      for (const skill of audit.skills) {
        emit('skills', `  Copying: ${skill}`);
        fs.copyFileSync(path.join(srcSkillsDir, skill), path.join(destSkillsDir, skill));
      }
    }
  }

  // 4b. Global container.json (MCP servers + installed packages at root level)
  for (const rel of ['container.json', 'config/container.json']) {
    const srcCj = path.join(source.path, rel);
    if (fs.existsSync(srcCj)) {
      const destCj = path.join(CLAWBRIDGE_HOME, 'container.json');
      if (!fs.existsSync(destCj)) {
        fs.copyFileSync(srcCj, destCj);
        emit('skills', `  Copied global container.json (MCP servers / tools config)`);
      } else {
        // Merge mcpServers from source into existing dest without overwriting
        try {
          const src = JSON.parse(fs.readFileSync(srcCj, 'utf-8')) as Record<string, unknown>;
          const dest = JSON.parse(fs.readFileSync(destCj, 'utf-8')) as Record<string, unknown>;
          const srcMcp = (src['mcpServers'] ?? {}) as Record<string, unknown>;
          const destMcp = (dest['mcpServers'] ?? {}) as Record<string, unknown>;
          let merged = 0;
          for (const [name, cfg] of Object.entries(srcMcp)) {
            if (!(name in destMcp)) {
              destMcp[name] = cfg;
              merged++;
            }
          }
          if (merged > 0) {
            dest['mcpServers'] = destMcp;
            fs.writeFileSync(destCj, JSON.stringify(dest, null, 2));
            emit('skills', `  Merged ${merged} MCP server(s) from source container.json`);
          }
        } catch {
          /* skip merge on parse error */
        }
      }
      break;
    }
  }

  // 5. Credentials
  if (selections.includes('credentials')) {
    emit('credentials', 'Migrating channel credentials…');
    const envSrc = path.join(source.path, '.env');
    if (fs.existsSync(envSrc)) {
      const envMigratedPath = path.join(CLAWBRIDGE_HOME, '.env.migrated');
      fs.copyFileSync(envSrc, envMigratedPath);
      emit('credentials', '  .env saved to ~/.clawbridge/.env.migrated');

      // Try to merge relevant channel tokens into ClawBridge .env
      const srcEnvContent = fs.readFileSync(envSrc, 'utf-8');
      const clawbridgeEnvPath = path.join(CLAWBRIDGE_HOME, '.env');
      // Migrate ALL non-empty keys from source .env that aren't already set.
      // Covers channel tokens, API keys, Claude OAuth, and any custom integrations.
      // Keys managed by ClawBridge's own setup flow are still included — the setup
      // wizard will prompt to confirm/override if needed.
      const srcLines = srcEnvContent.split('\n');
      const srcAllKeys: string[] = [];
      for (const line of srcLines) {
        const m = line.match(/^([A-Za-z][A-Za-z0-9_]+)=(.+)/);
        if (m && m[2].trim()) srcAllKeys.push(m[1]);
      }
      const MIGRATABLE_KEYS =
        srcAllKeys.length > 0
          ? srcAllKeys
          : [
              'TELEGRAM_BOT_TOKEN',
              'TELEGRAM_CHAT_ID',
              'WHATSAPP_SESSION',
              'DISCORD_TOKEN',
              'DISCORD_GUILD_ID',
              'SLACK_BOT_TOKEN',
              'SLACK_APP_TOKEN',
              'RETELL_API_KEY',
              'GROQ_API_KEY',
              'ANTHROPIC_API_KEY',
              'OPENAI_API_KEY',
              'CLAUDE_CODE_OAUTH_TOKEN',
              'RESEND_API_KEY',
              'GITHUB_TOKEN',
              'GOOGLE_API_KEY',
            ];
      if (fs.existsSync(clawbridgeEnvPath)) {
        const existingEnv = fs.readFileSync(clawbridgeEnvPath, 'utf-8');
        const linesToAdd: string[] = [];
        for (const key of MIGRATABLE_KEYS) {
          const match = srcEnvContent.match(new RegExp(`^${key}=(.*)$`, 'm'));
          if (match && !existingEnv.includes(`${key}=`)) {
            linesToAdd.push(`${key}=${match[1]}`);
          } else if (match && existingEnv.includes(`${key}=`)) {
            emit('credentials', `  Skipping ${key} — already present in .env`);
          }
        }
        if (linesToAdd.length > 0) {
          fs.appendFileSync(clawbridgeEnvPath, `\n# Migrated from ${source.type}\n${linesToAdd.join('\n')}\n`);
          emit('credentials', `  Merged ${linesToAdd.length} channel credential(s) into .env`);
        }
      }
    }

    // 5a. WhatsApp Baileys session — check multiple common paths, copy first found
    let whatsappCopied = false;
    const whatsappPaths = [
      'config/whatsapp',
      'session',
      'auth_info_baileys',
      'store/auth',
      'whatsapp-session',
      'store/whatsapp',
      'data/whatsapp',
      '.wwebjs_auth',
    ];
    for (const rel of whatsappPaths) {
      const srcDir = path.join(source.path, rel);
      if (fs.existsSync(srcDir) && fs.statSync(srcDir).isDirectory()) {
        copyDirRecursive(srcDir, path.join(CLAWBRIDGE_HOME, 'credentials', 'whatsapp'));
        emit('credentials', `  Copied WhatsApp session from ${rel}`);
        whatsappCopied = true;
        break; // only copy first found to avoid overwriting with empty
      }
    }

    // 5b. Other channel credentials (skip whatsapp if already copied above)
    for (const rel of ['config/telegram', 'config/whatsapp', 'config/discord']) {
      if (whatsappCopied && rel === 'config/whatsapp') continue;
      const srcDir = path.join(source.path, rel);
      if (fs.existsSync(srcDir)) {
        const channelName = path.basename(rel);
        copyDirRecursive(srcDir, path.join(CLAWBRIDGE_HOME, 'credentials', channelName));
        emit('credentials', `  Copied ${channelName} credentials`);
      }
    }
  }

  // 5c. Registered groups config
  emit('groups', 'Migrating registered groups config…');
  const registeredGroupsSrcPaths = [
    path.join(source.path, 'data', 'registered_groups.json'),
    path.join(source.path, 'store', 'groups.json'),
    path.join(source.path, 'config', 'groups.json'),
    path.join(source.path, 'registered_groups.json'),
  ];
  for (const srcPath of registeredGroupsSrcPaths) {
    if (fs.existsSync(srcPath)) {
      const destDataDir = path.join(CLAWBRIDGE_HOME, 'data');
      fs.mkdirSync(destDataDir, { recursive: true });
      const destPath = path.join(destDataDir, 'registered_groups.json');
      fs.copyFileSync(srcPath, destPath);
      emit('groups', '  Registered groups activated at ~/.clawbridge/data/registered_groups.json ✓');
      break;
    }
  }

  // 6. (OneCLI token migration removed in v2.0.33)

  // 7. Write manifest
  fs.mkdirSync(CLAWBRIDGE_HOME, { recursive: true });
  fs.writeFileSync(
    path.join(CLAWBRIDGE_HOME, 'migration-manifest.json'),
    JSON.stringify(
      {
        migratedAt: new Date().toISOString(),
        source: { type: source.type, path: source.path },
        selections,
        audit: {
          groups: audit.groups,
          messageCount: audit.messageCount,
          memoryCount: audit.memoryCount,
          scheduledTaskCount: audit.scheduledTaskCount,
          skills: audit.skills,
          channels: audit.channels,
        },
        result,
      },
      null,
      2,
    ),
  );
  emit('done', 'Migration complete.');

  return result;
}

// ─── Rollback ────────────────────────────────────────────────────────────────

export async function rollback(_source: MigrationSource): Promise<void> {
  const backupDir = path.join(CLAWBRIDGE_HOME, 'migration-backup');
  if (!fs.existsSync(backupDir)) {
    throw new Error('No migration backup found at ~/.clawbridge/migration-backup/. Cannot roll back.');
  }
  for (const subdir of ['groups', 'skills', 'store']) {
    const target = path.join(CLAWBRIDGE_HOME, subdir);
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
  }
  for (const entry of fs.readdirSync(backupDir, { withFileTypes: true })) {
    const src = path.join(backupDir, entry.name);
    const dest = path.join(CLAWBRIDGE_HOME, entry.name);
    if (entry.isDirectory()) copyDirRecursive(src, dest);
    else if (entry.isFile()) fs.copyFileSync(src, dest);
  }
  fs.rmSync(backupDir, { recursive: true, force: true });
  const manifest = path.join(CLAWBRIDGE_HOME, 'migration-manifest.json');
  if (fs.existsSync(manifest)) fs.unlinkSync(manifest);
}

export function deactivateSource(source: MigrationSource): void {
  // clawbridge-agent shares ~/.clawbridge/ with us — writing a deactivation
  // marker would tag our own data dir as deactivated. Skip; the in-place
  // migration handled the provider swap already.
  if (source.type === 'clawbridge') return;

  fs.writeFileSync(
    path.join(source.path, '.clawbridge-deactivated'),
    JSON.stringify(
      {
        deactivatedAt: new Date().toISOString(),
        reason: 'Migrated to ClawBridge',
        clawbridgeHome: CLAWBRIDGE_HOME,
      },
      null,
      2,
    ),
  );
  const isMac = process.platform === 'darwin';
  const stopCmds: Record<MigrationSourceType, string[][]> = {
    openclaw: isMac
      ? [
          ['launchctl', 'unload', path.join(os.homedir(), 'Library/LaunchAgents/com.openclaw.plist')],
          ['launchctl', 'stop', 'com.openclaw'],
        ]
      : [['systemctl', '--user', 'stop', 'openclaw']],
    nanoclaw: isMac
      ? [
          ['launchctl', 'unload', path.join(os.homedir(), 'Library/LaunchAgents/com.nanoclaw.plist')],
          ['launchctl', 'stop', 'com.nanoclaw'],
        ]
      : [['systemctl', '--user', 'stop', 'nanoclaw']],
    // clawbridge-agent shares the launchd label and data dir with us — no
    // deactivation needed. The user's next setup run will re-register the
    // service against the codex binary.
    clawbridge: [],
  };
  // Try each command, ignore failures
  for (const cmd of stopCmds[source.type]) {
    try {
      spawnSync(cmd[0], cmd.slice(1), { stdio: 'ignore' });
    } catch {
      // service may not be registered — ignore
    }
  }
  // Scan LaunchAgents dir for any matching plists (handles non-standard names)
  if (isMac) {
    const launchAgentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
    try {
      const plists = fs
        .readdirSync(launchAgentsDir)
        .filter((f) => f.toLowerCase().includes('openclaw') || f.toLowerCase().includes('nanoclaw'));
      for (const plist of plists) {
        const plistPath = path.join(launchAgentsDir, plist);
        spawnSync('launchctl', ['unload', plistPath], { stdio: 'ignore' });
      }
    } catch {
      // LaunchAgents dir may not exist — ignore
    }
  }
}

// ─── Post-migration Verification ─────────────────────────────────────────────

export interface VerificationCheck {
  label: string;
  passed: boolean;
  message: string;
}

export interface VerificationResult {
  passed: boolean;
  checks: VerificationCheck[];
}

export async function verifyMigration(
  source: MigrationSource,
  audit: MigrationAudit,
  selections: MigrationSelection[],
  migrationResult?: MigrationResult,
  _hindsightCfg?: HindsightConfig,
): Promise<VerificationResult> {
  const checks: VerificationCheck[] = [];

  const srcAccessible = (() => {
    try {
      return fs.existsSync(source.path) && fs.statSync(source.path).isDirectory();
    } catch {
      return false;
    }
  })();

  // ── Groups & memory ───────────────────────────────────────────────────────
  if (selections.includes('groups')) {
    const srcGroupsDir = resolveGroupsDir(source.path);
    const destGroupsDir = path.join(CLAWBRIDGE_HOME, 'groups');

    const srcGroupCount = audit.groups.length;
    let destGroupCount = 0;
    try {
      if (fs.existsSync(destGroupsDir)) {
        destGroupCount = fs.readdirSync(destGroupsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
      }
    } catch {
      // treat as 0
    }

    // Count memory entries (.md files) across group subdirs
    let srcMemoryCount = 0;
    let destMemoryCount = 0;
    const countMdFiles = (dir: string): number => {
      let n = 0;
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isFile() && entry.name.endsWith('.md')) n++;
          else if (entry.isDirectory()) n += countMdFiles(full);
        }
      } catch {
        // skip
      }
      return n;
    };

    if (srcAccessible && srcGroupsDir) srcMemoryCount = countMdFiles(srcGroupsDir);
    destMemoryCount = countMdFiles(destGroupsDir);

    if (destGroupCount < srcGroupCount) {
      const missing = srcGroupCount - destGroupCount;
      checks.push({
        label: 'Groups',
        passed: false,
        message: `Groups: ${destGroupCount}/${srcGroupCount} ⚠ (${missing} missing)`,
      });
    } else {
      checks.push({ label: 'Groups', passed: true, message: `Groups: ${destGroupCount}/${srcGroupCount} ✓` });
    }

    if (srcAccessible && srcMemoryCount > 0) {
      if (destMemoryCount < srcMemoryCount) {
        const missing = srcMemoryCount - destMemoryCount;
        checks.push({
          label: 'Memory',
          passed: false,
          message: `Memory entries: ${destMemoryCount}/${srcMemoryCount} ⚠ (${missing} missing)`,
        });
      } else {
        checks.push({
          label: 'Memory',
          passed: true,
          message: `Memory entries: ${destMemoryCount}/${srcMemoryCount} ✓`,
        });
      }
    }
  }

  // ── Message history ───────────────────────────────────────────────────────
  if (selections.includes('messages')) {
    const srcDb = resolvePrimaryDb(source.path);
    const destDb = path.join(CLAWBRIDGE_HOME, 'store', 'messages.db');

    let srcCount = 0;
    let destCount = 0;

    if (srcAccessible && srcDb) {
      for (const table of ['messages', 'message', 'msgs']) {
        const c = countSqliteRows(srcDb, table);
        if (c > 0) {
          srcCount = c;
          break;
        }
      }
    } else {
      srcCount = audit.messageCount;
    }

    if (fs.existsSync(destDb)) {
      for (const table of ['messages', 'message', 'msgs']) {
        const c = countSqliteRows(destDb, table);
        if (c > 0) {
          destCount = c;
          break;
        }
      }
    }

    if (destCount === 0 && srcCount > 0) {
      checks.push({
        label: 'Messages',
        passed: false,
        message: `Messages: 0/${srcCount.toLocaleString()} ⚠ (none found in destination)`,
      });
    } else if (srcCount > 0 && destCount < srcCount) {
      checks.push({
        label: 'Messages',
        passed: false,
        message: `Messages: ${destCount.toLocaleString()}/${srcCount.toLocaleString()} ⚠ (partial)`,
      });
    } else {
      const displayCount = destCount > 0 ? destCount : srcCount;
      checks.push({ label: 'Messages', passed: true, message: `Messages: ${displayCount.toLocaleString()} ✓` });
    }

    // ── SQLite tables migrated ─────────────────────────────────────────────
    if (migrationResult && migrationResult.tablesMigrated.length > 0) {
      checks.push({
        label: 'SQLite Tables',
        passed: true,
        message: `SQLite tables migrated: ${migrationResult.tablesMigrated.join(', ')} ✓`,
      });
    }

    // ── Scheduled tasks ────────────────────────────────────────────────────
    if (audit.scheduledTaskCount > 0 || (migrationResult && migrationResult.scheduledTasksMigrated > 0)) {
      const destTaskCount = migrationResult?.scheduledTasksMigrated ?? 0;
      const srcTaskCount = audit.scheduledTaskCount;
      if (srcTaskCount > 0 && destTaskCount < srcTaskCount) {
        checks.push({
          label: 'Scheduled Tasks',
          passed: false,
          message: `Scheduled tasks: ${destTaskCount}/${srcTaskCount} ⚠`,
        });
      } else {
        const count = destTaskCount > 0 ? destTaskCount : srcTaskCount;
        checks.push({
          label: 'Scheduled Tasks',
          passed: true,
          message: `Scheduled tasks: ${count} migrated ✓`,
        });
      }
    }

    // ── Memory entries in DB ───────────────────────────────────────────────
    if (srcAccessible && srcDb && audit.memoryCount > 0) {
      const destMemDbCount = fs.existsSync(destDb) ? countMemoryEntries(destDb) : 0;
      if (destMemDbCount < audit.memoryCount) {
        checks.push({
          label: 'DB Memory Entries',
          passed: false,
          message: `DB memory entries: ${destMemDbCount}/${audit.memoryCount} ⚠`,
        });
      } else {
        checks.push({
          label: 'DB Memory Entries',
          passed: true,
          message: `DB memory entries: ${destMemDbCount}/${audit.memoryCount} ✓`,
        });
      }
    }

    // ── Hindsight retention (informational) ───────────────────────────────
    if (migrationResult && (migrationResult.hindsightRetained > 0 || migrationResult.hindsightQueued > 0)) {
      if (migrationResult.hindsightQueued > 0) {
        checks.push({
          label: 'Hindsight',
          passed: true, // non-fatal — will sync on startup
          message: `Hindsight: ${migrationResult.hindsightQueued} memories queued for first-startup sync ⚠`,
        });
      } else {
        checks.push({
          label: 'Hindsight',
          passed: true,
          message: `Hindsight: ${migrationResult.hindsightRetained} memories retained ✓${migrationResult.hindsightFailed > 0 ? ` (${migrationResult.hindsightFailed} failed)` : ''}`,
        });
      }
    }
  }

  // ── Custom skills ─────────────────────────────────────────────────────────
  if (selections.includes('skills')) {
    const srcSkillsDir = resolveSkillsDir(source.path);
    const destSkillsDir = path.join(CLAWBRIDGE_HOME, 'skills');
    const skillFailures: string[] = [];

    for (const skill of audit.skills) {
      const destFile = path.join(destSkillsDir, skill);
      if (!fs.existsSync(destFile)) {
        skillFailures.push(skill);
        continue;
      }
      if (srcAccessible && srcSkillsDir) {
        const srcFile = path.join(srcSkillsDir, skill);
        try {
          const srcSize = fs.statSync(srcFile).size;
          const destSize = fs.statSync(destFile).size;
          const diff = Math.abs(srcSize - destSize) / (srcSize || 1);
          if (diff > 0.01) {
            skillFailures.push(`${skill} (size mismatch: ${srcSize}B → ${destSize}B)`);
          }
        } catch {
          // can't stat src, skip size check
        }
      }
    }

    const okCount = audit.skills.length - skillFailures.length;
    if (skillFailures.length > 0) {
      checks.push({
        label: 'Skills',
        passed: false,
        message: `Skills: ${okCount}/${audit.skills.length} ⚠ — issues: ${skillFailures.join(', ')}`,
      });
    } else {
      checks.push({
        label: 'Skills',
        passed: true,
        message: `Skills: ${audit.skills.length}/${audit.skills.length} ✓`,
      });
    }
  }

  // ── Channel credentials ───────────────────────────────────────────────────
  if (selections.includes('credentials')) {
    const srcEnvPath = path.join(source.path, '.env');
    const destEnvPath = path.join(CLAWBRIDGE_HOME, '.env.migrated');

    if (fs.existsSync(srcEnvPath) && fs.existsSync(destEnvPath)) {
      const parseEnv = (content: string): Map<string, string> => {
        const map = new Map<string, string>();
        for (const line of content.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const eqIdx = trimmed.indexOf('=');
          if (eqIdx === -1) continue;
          const key = trimmed.slice(0, eqIdx).trim();
          const val = trimmed.slice(eqIdx + 1).trim();
          if (key) map.set(key, val);
        }
        return map;
      };

      const channelKeyPatterns = [
        /TELEGRAM.*TOKEN|TELEGRAM.*BOT/i,
        /WHATSAPP/i,
        /DISCORD.*TOKEN/i,
        /SLACK.*TOKEN|SLACK.*BOT|SLACK.*SECRET/i,
        /GMAIL|GOOGLE.*OAUTH/i,
        /SIGNAL/i,
        /TEAMS|MICROSOFT.*BOT/i,
      ];

      let srcEnvContent = '';
      let destEnvContent = '';
      try {
        srcEnvContent = fs.readFileSync(srcEnvPath, 'utf-8');
      } catch {
        /* skip */
      }
      try {
        destEnvContent = fs.readFileSync(destEnvPath, 'utf-8');
      } catch {
        /* skip */
      }

      const srcEnv = parseEnv(srcEnvContent);
      const destEnv = parseEnv(destEnvContent);

      const missingKeys: string[] = [];
      for (const [key, val] of srcEnv) {
        if (!val) continue;
        const isChannelKey = channelKeyPatterns.some((pat) => pat.test(key));
        if (!isChannelKey) continue;
        const destVal = destEnv.get(key);
        if (!destVal) {
          missingKeys.push(key);
        }
      }

      if (missingKeys.length > 0) {
        checks.push({
          label: 'Credentials',
          passed: false,
          message: `Credentials: missing keys in .env.migrated — ${missingKeys.join(', ')}`,
        });
      } else {
        checks.push({ label: 'Credentials', passed: true, message: 'Credentials: all channel keys present ✓' });
      }
    } else if (fs.existsSync(srcEnvPath) && !fs.existsSync(destEnvPath)) {
      checks.push({
        label: 'Credentials',
        passed: false,
        message: 'Credentials: .env.migrated not found in destination',
      });
    } else {
      checks.push({ label: 'Credentials', passed: true, message: 'Credentials: .env.migrated present ✓' });
    }
  }

  // ── WhatsApp credentials ─────────────────────────────────────────────────
  if (selections.includes('credentials')) {
    const waCredDir = path.join(CLAWBRIDGE_HOME, 'credentials', 'whatsapp');
    const waExists = fs.existsSync(waCredDir) && fs.readdirSync(waCredDir).length > 0;
    if (!waExists) {
      // Non-fatal: WhatsApp may not have been configured in source
      const waSource = [
        'config/whatsapp',
        'session',
        'auth_info_baileys',
        'store/auth',
        'whatsapp-session',
        'store/whatsapp',
        'data/whatsapp',
        '.wwebjs_auth',
      ].some((rel) => fs.existsSync(path.join(source.path, rel)));
      if (waSource) {
        checks.push({
          label: 'WhatsApp Credentials',
          passed: false,
          message: 'WhatsApp credentials: source found but not copied ⚠',
        });
      }
    } else {
      checks.push({ label: 'WhatsApp Credentials', passed: true, message: 'WhatsApp credentials: present ✓' });
    }
  }

  // ── Registered groups ─────────────────────────────────────────────────────
  const registeredGroupsMigrated = path.join(CLAWBRIDGE_HOME, 'data', 'registered_groups.migrated.json'); // legacy path
  const registeredGroupsActive = path.join(CLAWBRIDGE_HOME, 'data', 'registered_groups.json');
  if (fs.existsSync(registeredGroupsMigrated)) {
    checks.push({
      label: 'Registered Groups',
      passed: true,
      message: 'Registered groups: activated at registered_groups.json ✓',
    });
  } else if (fs.existsSync(registeredGroupsActive)) {
    checks.push({ label: 'Registered Groups', passed: true, message: 'Registered groups: active ✓' });
  }

  // ── .env channel tokens ───────────────────────────────────────────────────
  if (selections.includes('credentials')) {
    const clawbridgeEnvPath = path.join(CLAWBRIDGE_HOME, '.env');
    if (fs.existsSync(clawbridgeEnvPath)) {
      const envContent = fs.readFileSync(clawbridgeEnvPath, 'utf-8');
      const hasSomeToken = [/TELEGRAM_BOT_TOKEN=/, /DISCORD_TOKEN=/, /SLACK_BOT_TOKEN=/, /WHATSAPP_SESSION=/].some(
        (pat) => pat.test(envContent),
      );
      if (!hasSomeToken) {
        checks.push({
          label: '.env Tokens',
          passed: false,
          message: '.env: no channel tokens found — run setup to configure channels',
        });
      } else {
        checks.push({ label: '.env Tokens', passed: true, message: '.env: channel tokens present ✓' });
      }
    }
  }

  // ── Service stopped ───────────────────────────────────────────────────────
  {
    const deactivatedMarker = path.join(source.path, '.clawbridge-deactivated');
    if (fs.existsSync(deactivatedMarker)) {
      checks.push({ label: 'Source Deactivated', passed: true, message: `Source ${source.type} deactivated ✓` });
    }
    // Check whether the systemd/launchd service is still running
    const isMac = process.platform === 'darwin';
    if (!isMac) {
      const result = spawnSync('systemctl', ['--user', 'is-active', source.type], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const isActive = (result.stdout ?? '').trim() === 'active';
      if (isActive) {
        checks.push({
          label: 'Service',
          passed: false,
          message: `${source.type} systemd service still active — stop it to avoid conflicts`,
        });
      }
    }
  }

  const failed = checks.filter((c) => !c.passed);
  return { passed: failed.length === 0, checks };
}
