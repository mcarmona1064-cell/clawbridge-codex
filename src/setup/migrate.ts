/**
 * ClawBridge migration engine.
 *
 * Handles detection and migration from:
 *   - OpenClaw  (~/.openclaw, ~/openclaw, ~/clawdbot)
 *   - NanoClaw  (~/.nanoclaw)
 *   - Cyndra    (~/.cyndra)
 */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import os from 'os';

// ─── Public types ────────────────────────────────────────────────────────────

export type MigrationSourceType = 'openclaw' | 'nanoclaw' | 'cyndra';

export interface MigrationSource {
  type: MigrationSourceType;
  path: string;
}

export interface MigrationAudit {
  groups: string[];
  messageCount: number;
  skills: string[];
  channels: string[];
  configFiles: string[];
}

export type MigrationSelection = 'groups' | 'messages' | 'skills' | 'credentials';

export interface MigrationProgress {
  step: string;
  detail?: string;
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
    paths: [
      path.join(HOME, '.cyndra'),
      path.join(HOME, 'cyndra'),
      path.join(HOME, 'Projects', 'cyndra'),
      path.join(HOME, 'projects', 'cyndra'),
    ],
    type: 'cyndra',
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
      if (name.includes('cyndra')) return 'cyndra';
    } catch {
      // ignore
    }
  }
  const base = path.basename(dir).toLowerCase();
  if (base.includes('openclaw') || base.includes('clawdbot')) return 'openclaw';
  if (base.includes('nanoclaw')) return 'nanoclaw';
  if (base.includes('cyndra')) return 'cyndra';
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
      error: `Could not identify install type at ${resolved}. Is this an OpenClaw, NanoClaw, or Cyndra directory?`,
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

export async function auditInstall(source: MigrationSource): Promise<MigrationAudit> {
  const groups = findGroups(source.path);
  const dbs = findDatabases(source.path);
  let messageCount = 0;
  for (const db of dbs) {
    for (const table of ['messages', 'message', 'msgs']) {
      const count = countSqliteRows(db, table);
      if (count > 0) {
        messageCount += count;
        break;
      }
    }
  }
  return {
    groups,
    messageCount,
    skills: findSkills(source.path),
    channels: detectChannels(source.path),
    configFiles: findConfigFiles(source.path),
  };
}

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

export async function runMigration(
  source: MigrationSource,
  audit: MigrationAudit,
  selections: MigrationSelection[],
  onProgress?: (p: MigrationProgress) => void,
): Promise<void> {
  const emit = (step: string, detail?: string): void => onProgress?.({ step, detail });

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

  // 2. Groups
  if (selections.includes('groups') && audit.groups.length > 0) {
    emit('groups', `Migrating ${audit.groups.length} group(s)…`);
    const srcGroupsDir = resolveGroupsDir(source.path);
    if (srcGroupsDir) {
      const destGroupsDir = path.join(CLAWBRIDGE_HOME, 'groups');
      fs.mkdirSync(destGroupsDir, { recursive: true });
      for (const group of audit.groups) {
        emit('groups', `  Copying: ${group}`);
        copyDirRecursive(path.join(srcGroupsDir, group), path.join(destGroupsDir, group));
      }
    }
  }

  // 3. Message history
  if (selections.includes('messages') && audit.messageCount > 0) {
    emit('messages', `Migrating ${audit.messageCount.toLocaleString()} messages…`);
    const srcDb = resolvePrimaryDb(source.path);
    if (srcDb) {
      const destStoreDir = path.join(CLAWBRIDGE_HOME, 'store');
      fs.mkdirSync(destStoreDir, { recursive: true });
      fs.copyFileSync(srcDb, path.join(destStoreDir, 'messages.db'));
      const note =
        source.type === 'openclaw'
          ? '  Copied (OpenClaw schema — verify with `sqlite3 ~/.clawbridge/store/messages.db .tables`)'
          : '  Direct copy (compatible schema)';
      emit('messages', note);
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

  // 5. Credentials
  if (selections.includes('credentials')) {
    emit('credentials', 'Migrating channel credentials…');
    const envSrc = path.join(source.path, '.env');
    if (fs.existsSync(envSrc)) {
      fs.copyFileSync(envSrc, path.join(CLAWBRIDGE_HOME, '.env.migrated'));
      emit('credentials', '  .env saved to ~/.clawbridge/.env.migrated — review before applying');
    }
    for (const rel of ['config/telegram', 'config/whatsapp', 'config/discord']) {
      const srcDir = path.join(source.path, rel);
      if (fs.existsSync(srcDir)) {
        const channelName = path.basename(rel);
        copyDirRecursive(srcDir, path.join(CLAWBRIDGE_HOME, 'credentials', channelName));
        emit('credentials', `  Copied ${channelName} credentials`);
      }
    }
  }

  // 6. Write manifest
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
          skills: audit.skills,
          channels: audit.channels,
        },
      },
      null,
      2,
    ),
  );
  emit('done', 'Migration complete.');
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
  const stopCmds: Record<MigrationSourceType, string[]> = {
    openclaw: ['systemctl', '--user', 'stop', 'openclaw'],
    nanoclaw: ['systemctl', '--user', 'stop', 'nanoclaw'],
    cyndra: ['systemctl', '--user', 'stop', 'cyndra'],
  };
  try {
    const [cmd, ...args] = stopCmds[source.type];
    spawnSync(cmd, args, { stdio: 'ignore' });
  } catch {
    // service may not be registered — ignore
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
        destGroupCount = fs
          .readdirSync(destGroupsDir, { withFileTypes: true })
          .filter((e) => e.isDirectory()).length;
      }
    } catch {
      // treat as 0
    }

    // Also count memory entries (any .md files across group subdirs)
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
      checks.push({ label: 'Groups', passed: false, message: `Groups: ${destGroupCount}/${srcGroupCount} ⚠ (${missing} missing)` });
    } else {
      checks.push({ label: 'Groups', passed: true, message: `Groups: ${destGroupCount}/${srcGroupCount} ✓` });
    }

    if (srcAccessible && srcMemoryCount > 0) {
      if (destMemoryCount < srcMemoryCount) {
        const missing = srcMemoryCount - destMemoryCount;
        checks.push({ label: 'Memory', passed: false, message: `Memory entries: ${destMemoryCount}/${srcMemoryCount} ⚠ (${missing} missing)` });
      } else {
        checks.push({ label: 'Memory', passed: true, message: `Memory entries: ${destMemoryCount}/${srcMemoryCount} ✓` });
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
        if (c > 0) { srcCount = c; break; }
      }
    } else {
      srcCount = audit.messageCount;
    }

    if (fs.existsSync(destDb)) {
      for (const table of ['messages', 'message', 'msgs']) {
        const c = countSqliteRows(destDb, table);
        if (c > 0) { destCount = c; break; }
      }
    }

    if (destCount === 0 && srcCount > 0) {
      checks.push({ label: 'Messages', passed: false, message: `Messages: 0/${srcCount.toLocaleString()} ⚠ (none found in destination)` });
    } else if (srcCount > 0 && destCount < srcCount) {
      checks.push({ label: 'Messages', passed: false, message: `Messages: ${destCount.toLocaleString()}/${srcCount.toLocaleString()} ⚠ (partial)` });
    } else {
      const displayCount = destCount > 0 ? destCount : srcCount;
      checks.push({ label: 'Messages', passed: true, message: `Messages: ${displayCount.toLocaleString()} ✓` });
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
      checks.push({ label: 'Skills', passed: false, message: `Skills: ${okCount}/${audit.skills.length} ⚠ — issues: ${skillFailures.join(', ')}` });
    } else {
      checks.push({ label: 'Skills', passed: true, message: `Skills: ${audit.skills.length}/${audit.skills.length} ✓` });
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
      try { srcEnvContent = fs.readFileSync(srcEnvPath, 'utf-8'); } catch { /* skip */ }
      try { destEnvContent = fs.readFileSync(destEnvPath, 'utf-8'); } catch { /* skip */ }

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
        checks.push({ label: 'Credentials', passed: false, message: `Credentials: missing keys in .env.migrated — ${missingKeys.join(', ')}` });
      } else {
        checks.push({ label: 'Credentials', passed: true, message: 'Credentials: all channel keys present ✓' });
      }
    } else if (fs.existsSync(srcEnvPath) && !fs.existsSync(destEnvPath)) {
      checks.push({ label: 'Credentials', passed: false, message: 'Credentials: .env.migrated not found in destination' });
    } else {
      checks.push({ label: 'Credentials', passed: true, message: 'Credentials: .env.migrated present ✓' });
    }
  }

  const failed = checks.filter((c) => !c.passed);
  return { passed: failed.length === 0, checks };
}
