import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from './config.js';
import { initContainerConfig } from './container-config.js';
import { log } from './log.js';
import type { AgentGroup } from './types.js';

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
 * The composed `AGENTS.md` is NOT written here — it's regenerated on every
 * spawn by `composeGroupAgentsMd()` (see `agents-md-compose.ts`). Initial
 * per-group instructions (if provided) seed `AGENTS.local.md`.
 */
export function initGroupFilesystem(group: AgentGroup, opts?: { instructions?: string }): void {
  const initialized: string[] = [];

  // 1. groups/<folder>/ — group memory + working dir
  const groupDir = path.resolve(GROUPS_DIR, group.folder);
  if (!fs.existsSync(groupDir)) {
    fs.mkdirSync(groupDir, { recursive: true });
    initialized.push('groupDir');
  }

  // groups/<folder>/AGENTS.local.md — user-editable agent persona, read at
  // compose time and inlined into the machine-managed _composed.md
  // (mounted RO as AGENTS.md inside the container). Seeded with
  // caller-provided instructions, or a default template on first creation.
  const agentsLocalFile = path.join(groupDir, 'AGENTS.local.md');
  if (!fs.existsSync(agentsLocalFile)) {
    const defaultBody = `# Your Agent Persona

Edit this file to customize your agent's personality, knowledge, and behavior.
The contents are inlined into AGENTS.md (which Codex CLI reads) on every spawn.

## About me
I am ClawBridge, your AI assistant.

## My personality
- Helpful and direct
- Remember important context about users
- Proactive with reminders and follow-ups
`;
    const body = opts?.instructions ? opts.instructions + '\n' : defaultBody;
    fs.writeFileSync(agentsLocalFile, body);
    initialized.push('AGENTS.local.md');
  }

  // groups/<folder>/container.json — empty container config, replaces the
  // former agent_groups.container_config DB column. Self-modification flows
  // read and write this file directly.
  if (initContainerConfig(group.folder)) {
    initialized.push('container.json');
  }

  // 2. data/v2-sessions/<id>/.codex-shared/ — Codex per-group state +
  // per-group skill symlinks
  const stateDir = path.join(DATA_DIR, 'v2-sessions', group.id, '.codex-shared');
  if (!fs.existsSync(stateDir)) {
    fs.mkdirSync(stateDir, { recursive: true });
    initialized.push('.codex-shared');
  }

  // Skills directory — created empty here; symlinks are synced at spawn
  // time by container-runner.ts based on container.json skills selection.
  const skillsDst = path.join(stateDir, 'skills');
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
