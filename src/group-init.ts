import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from './config.js';
import { initContainerConfig } from './container-config.js';
import { log } from './log.js';
import type { AgentGroup } from './types.js';

const DEFAULT_SETTINGS_JSON =
  JSON.stringify(
    {
      env: {
        CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
        CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
      },
      permissions: {
        allow: [
          'Bash(ls*)',
          'Bash(ls -* *)',
          'Bash(cat *)',
          'Bash(head *)',
          'Bash(tail *)',
          'Bash(grep *)',
          'Bash(grep -* *)',
          'Bash(find *)',
          'Bash(wc *)',
          'Bash(echo *)',
          'Bash(pwd)',
          'Bash(which *)',
          'Bash(file *)',
          'Bash(stat *)',
          'Bash(du *)',
          'Bash(df *)',
          'Bash(ps *)',
          'Bash(env)',
          'Bash(printenv *)',
          'Bash(sort *)',
          'Bash(uniq *)',
          'Bash(cut *)',
          'Bash(awk *)',
          'Bash(sed -n *)',
          'Bash(jq *)',
          'Bash(python3 -c *)',
          'Bash(node -e *)',
          'Bash(date*)',
          'Bash(id)',
          'Bash(whoami)',
          'Bash(uname *)',
          'Read(*)',
          'Glob(*)',
        ],
      },
    },
    null,
    2,
  ) + '\n';

/**
 * Initialize the on-disk filesystem state for an agent group. Idempotent —
 * every step is gated on the target not already existing, so re-running on
 * an already-initialized group is a no-op.
 *
 * Called once per group lifetime at creation, or defensively from
 * `buildMounts()` for groups that pre-date this code path.
 *
 * Source code and skills are shared RO mounts — not copied per-group.
 * Skill symlinks are synced at spawn time by container-runner.ts.
 *
 * The composed `CLAUDE.md` is NOT written here — it's regenerated on every
 * spawn by `composeGroupClaudeMd()` (see `claude-md-compose.ts`). Initial
 * per-group instructions (if provided) seed `CLAUDE.local.md`.
 */
export function initGroupFilesystem(group: AgentGroup, opts?: { instructions?: string }): void {
  const initialized: string[] = [];

  // 1. groups/<folder>/ — group memory + working dir
  const groupDir = path.resolve(GROUPS_DIR, group.folder);
  if (!fs.existsSync(groupDir)) {
    fs.mkdirSync(groupDir, { recursive: true });
    initialized.push('groupDir');
  }

  // groups/<folder>/CLAUDE.local.md — user-editable agent persona, auto-loaded
  // by Claude Code alongside the machine-managed _composed.md entry point.
  // Seeded with caller-provided instructions, or a default template on first
  // creation. The underscore-prefixed _composed.md is internal — this is the
  // only CLAUDE.md file the user should ever edit.
  const claudeLocalFile = path.join(groupDir, 'CLAUDE.local.md');
  if (!fs.existsSync(claudeLocalFile)) {
    const defaultBody = `# Your Agent Persona

Edit this file to customize your agent's personality, knowledge, and behavior.
This file is merged with the system configuration automatically.

## About me
I am ClawBridge, your AI assistant.

## My personality
- Helpful and direct
- Remember important context about users
- Proactive with reminders and follow-ups
`;
    const body = opts?.instructions ? opts.instructions + '\n' : defaultBody;
    fs.writeFileSync(claudeLocalFile, body);
    initialized.push('CLAUDE.local.md');
  }

  // groups/<folder>/container.json — empty container config, replaces the
  // former agent_groups.container_config DB column. Self-modification flows
  // read and write this file directly.
  if (initContainerConfig(group.folder)) {
    initialized.push('container.json');
  }

  // 2. data/v2-sessions/<id>/.claude-shared/ — Claude state + per-group skills
  const claudeDir = path.join(DATA_DIR, 'v2-sessions', group.id, '.claude-shared');
  if (!fs.existsSync(claudeDir)) {
    fs.mkdirSync(claudeDir, { recursive: true });
    initialized.push('.claude-shared');
  }

  const settingsFile = path.join(claudeDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(settingsFile, DEFAULT_SETTINGS_JSON);
    initialized.push('settings.json');
  }

  // Skills directory — created empty here; symlinks are synced at spawn
  // time by container-runner.ts based on container.json skills selection.
  const skillsDst = path.join(claudeDir, 'skills');
  if (!fs.existsSync(skillsDst)) {
    fs.mkdirSync(skillsDst, { recursive: true });
    initialized.push('skills/');
  }

  if (initialized.length > 0) {
    log.info('Initialized group filesystem', {
      group: group.name,
      folder: group.folder,
      id: group.id,
      steps: initialized,
    });
  }
}
