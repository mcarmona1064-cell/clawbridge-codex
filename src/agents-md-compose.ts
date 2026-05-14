/**
 * AGENTS.md composition for agent groups.
 *
 * Codex CLI reads AGENTS.md from the working directory on every invocation.
 * Unlike Claude Code, it does not follow `@./file.md` import syntax, so we
 * inline all fragment contents directly into the composed entry point.
 *
 * Composes:
 *   - shared base (`container/AGENTS.md` mounted RO inside the container,
 *     read from disk here and inlined into the output)
 *   - skill fragments (each `container/skills/<n>/instructions.md`)
 *   - built-in module fragments (each `<m>.instructions.md` next to its
 *     MCP tool implementation under `container/agent-runner/src/mcp-tools/`)
 *   - inline MCP server fragments declared in `container.json`
 *   - per-group memory (`AGENTS.local.md`, user-editable)
 *
 * Runs on every spawn from `container-runner.buildMounts()`. Deterministic —
 * same inputs produce the same AGENTS.md, and stale fragments naturally
 * disappear because the file is rewritten from scratch each time.
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { readContainerConfig } from './container-config.js';
import { log } from './log.js';
import type { AgentGroup } from './types.js';

const MCP_TOOLS_HOST_SUBPATH = path.join('container', 'agent-runner', 'src', 'mcp-tools');
const SKILLS_HOST_SUBPATH = path.join('container', 'skills');
const SHARED_BASE_HOST_SUBPATH = path.join('container', 'AGENTS.md');

const COMPOSED_HEADER =
  '<!-- Composed at spawn — do not edit. Edit AGENTS.local.md for per-group content. -->';

interface Fragment {
  title: string;
  content: string;
}

/**
 * Regenerate `groups/<folder>/_composed.md` (mounted RO as
 * `/workspace/agent/AGENTS.md`) by concatenating the shared base, enabled
 * skill fragments, MCP fragments, and per-group `AGENTS.local.md` content.
 *
 * Creates an empty `AGENTS.local.md` if missing so the user has a file to
 * edit for per-group customization.
 */
export function composeGroupAgentsMd(group: AgentGroup): void {
  const groupDir = path.resolve(GROUPS_DIR, group.folder);
  if (!fs.existsSync(groupDir)) {
    fs.mkdirSync(groupDir, { recursive: true });
  }

  const fragments: Fragment[] = [];

  // 1. Shared base
  const sharedBasePath = path.join(process.cwd(), SHARED_BASE_HOST_SUBPATH);
  if (fs.existsSync(sharedBasePath)) {
    fragments.push({
      title: 'Shared base',
      content: fs.readFileSync(sharedBasePath, 'utf8').trim(),
    });
  }

  // 2. Skill fragments — every skill that ships an `instructions.md`.
  // TODO (shared-source refactor): respect `container.json` skill selection.
  const skillsHostDir = path.join(process.cwd(), SKILLS_HOST_SUBPATH);
  if (fs.existsSync(skillsHostDir)) {
    for (const skillName of fs.readdirSync(skillsHostDir).sort()) {
      const hostFragment = path.join(skillsHostDir, skillName, 'instructions.md');
      if (fs.existsSync(hostFragment)) {
        fragments.push({
          title: `Skill: ${skillName}`,
          content: fs.readFileSync(hostFragment, 'utf8').trim(),
        });
      }
    }
  }

  // 3. Built-in MCP tool module fragments — sibling `<name>.instructions.md`
  // next to each MCP tool source file. Always included.
  const mcpToolsHostDir = path.join(process.cwd(), MCP_TOOLS_HOST_SUBPATH);
  if (fs.existsSync(mcpToolsHostDir)) {
    for (const entry of fs.readdirSync(mcpToolsHostDir).sort()) {
      const match = entry.match(/^(.+)\.instructions\.md$/);
      if (!match) continue;
      const moduleName = match[1];
      const fragPath = path.join(mcpToolsHostDir, entry);
      fragments.push({
        title: `Module: ${moduleName}`,
        content: fs.readFileSync(fragPath, 'utf8').trim(),
      });
    }
  }

  // 4. MCP server inline instructions from container.json.
  const config = readContainerConfig(group.folder);
  for (const [name, mcp] of Object.entries(config.mcpServers).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (mcp.instructions) {
      fragments.push({
        title: `MCP server: ${name}`,
        content: mcp.instructions.trim(),
      });
    }
  }

  // 5. Per-group user-editable memory.
  const localFile = path.join(groupDir, 'AGENTS.local.md');
  if (!fs.existsSync(localFile)) {
    fs.writeFileSync(localFile, '');
  }
  const localContent = fs.readFileSync(localFile, 'utf8').trim();
  if (localContent) {
    fragments.push({ title: 'Per-group instructions', content: localContent });
  }

  // Assemble final document.
  const parts = [COMPOSED_HEADER];
  for (const frag of fragments) {
    parts.push(`# ${frag.title}\n\n${frag.content}`);
  }
  writeAtomic(path.join(groupDir, '_composed.md'), parts.join('\n\n') + '\n');
}

/**
 * One-time cutover from the legacy CLAUDE.md / CLAUDE.local.md model.
 * Idempotent — safe to run on every host startup.
 *
 * For each group dir:
 *   - rename `CLAUDE.local.md` → `AGENTS.local.md` (if AGENTS.local.md
 *     doesn't already exist)
 *   - rename legacy `CLAUDE.md` → `AGENTS.local.md` only when it is NOT
 *     a machine-composed file (no AGENTS.local.md exists). Composed
 *     CLAUDE.md files are removed outright.
 *   - remove stale `.claude-shared.md`, `.claude-global.md`, and
 *     `.claude-fragments/` artifacts left over from the import-based model
 *
 * Globally:
 *   - delete `groups/global/` (its content lives in `container/AGENTS.md`)
 */
export function migrateGroupsToAgentsLocal(): void {
  if (!fs.existsSync(GROUPS_DIR)) return;

  const actions: string[] = [];

  for (const entry of fs.readdirSync(GROUPS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'global') continue;

    const groupDir = path.join(GROUPS_DIR, entry.name);

    // Remove stale Claude-era artifacts.
    for (const stale of ['.claude-global.md', '.claude-shared.md']) {
      const p = path.join(groupDir, stale);
      try {
        fs.lstatSync(p);
        fs.unlinkSync(p);
        actions.push(`${entry.name}/${stale} removed`);
      } catch {
        /* already gone */
      }
    }
    const staleFragments = path.join(groupDir, '.claude-fragments');
    if (fs.existsSync(staleFragments)) {
      fs.rmSync(staleFragments, { recursive: true, force: true });
      actions.push(`${entry.name}/.claude-fragments removed`);
    }

    const oldLocal = path.join(groupDir, 'CLAUDE.local.md');
    const newLocal = path.join(groupDir, 'AGENTS.local.md');
    const oldClaudeMd = path.join(groupDir, 'CLAUDE.md');
    const composedMd = path.join(groupDir, '_composed.md');

    // 1. CLAUDE.local.md → AGENTS.local.md
    if (fs.existsSync(oldLocal) && !fs.existsSync(newLocal)) {
      fs.renameSync(oldLocal, newLocal);
      actions.push(`${entry.name}/CLAUDE.local.md → AGENTS.local.md`);
    } else if (fs.existsSync(oldLocal) && fs.existsSync(newLocal)) {
      fs.unlinkSync(oldLocal);
      actions.push(`${entry.name}/CLAUDE.local.md removed (AGENTS.local.md already present)`);
    }

    // 2. CLAUDE.md — composed copies are pruned; user-authored content is
    // migrated only if no AGENTS.local.md yet exists.
    if (fs.existsSync(oldClaudeMd)) {
      let isComposed = false;
      try {
        const firstLine = fs.readFileSync(oldClaudeMd, 'utf8').split('\n')[0];
        isComposed = firstLine.includes('Composed at spawn');
      } catch {
        /* ignore */
      }
      if (isComposed) {
        fs.unlinkSync(oldClaudeMd);
        actions.push(`${entry.name}/CLAUDE.md removed (was composed)`);
      } else if (!fs.existsSync(newLocal)) {
        fs.renameSync(oldClaudeMd, newLocal);
        actions.push(`${entry.name}/CLAUDE.md → AGENTS.local.md`);
      } else {
        fs.unlinkSync(oldClaudeMd);
        actions.push(`${entry.name}/CLAUDE.md removed (AGENTS.local.md already present)`);
      }
    }

    // 3. Stale composed entry from the old import model — remove if older
    // than this code path; will be regenerated on next spawn.
    if (fs.existsSync(composedMd)) {
      try {
        const firstLine = fs.readFileSync(composedMd, 'utf8').split('\n')[0];
        if (firstLine.includes('Edit CLAUDE.local.md')) {
          fs.unlinkSync(composedMd);
          actions.push(`${entry.name}/_composed.md removed (stale Claude-era format)`);
        }
      } catch {
        /* ignore */
      }
    }
  }

  const globalDir = path.join(GROUPS_DIR, 'global');
  if (fs.existsSync(globalDir)) {
    fs.rmSync(globalDir, { recursive: true, force: true });
    actions.push('groups/global/ removed');
  }

  if (actions.length > 0) {
    log.info('Migrated groups to AGENTS.local.md model', { actions });
  }
}

function writeAtomic(filePath: string, content: string): void {
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}
