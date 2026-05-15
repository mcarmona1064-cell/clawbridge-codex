/**
 * Host-side container config for the Codex provider.
 *
 * Registers a ProviderContainerContribution that:
 * - Mounts the per-group .codex/ sessions directory at /home/node/.codex
 * - Strips OPENAI_API_KEY / CODEX_API_KEY from the container env so Codex
 *   uses subscription OAuth rather than API-key billing.
 *
 * No extra env vars are forwarded — credentials are injected by the Codex
 * CLI's own OAuth credential store (populated via `codex login --device-auth`).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

function syncCodexOAuthAuth(codexDir: string): void {
  const hostAuth = path.join(os.homedir(), '.codex', 'auth.json');
  const groupAuth = path.join(codexDir, 'auth.json');
  if (!fs.existsSync(hostAuth)) return;

  try {
    const hostContent = fs.readFileSync(hostAuth);
    const current = fs.existsSync(groupAuth) ? fs.readFileSync(groupAuth) : undefined;
    if (!current || !current.equals(hostContent)) {
      fs.copyFileSync(hostAuth, groupAuth);
      try {
        fs.chmodSync(groupAuth, 0o600);
      } catch {
        /* best effort only */
      }
    }
  } catch {
    // Spawn should still proceed; doctor reports missing/broken Codex auth.
  }
}

registerProviderContainerConfig('codex', ({ agentGroupId }) => {
  // Per-group .codex sessions directory
  const codexDir = path.join(DATA_DIR, 'v2-sessions', agentGroupId, '.codex-shared');
  fs.mkdirSync(codexDir, { recursive: true });
  syncCodexOAuthAuth(codexDir);

  return {
    mounts: [
      {
        hostPath: codexDir,
        containerPath: '/home/node/.codex',
        readonly: false,
      },
    ],
    // No env passthrough — Codex reads its own OAuth token from ~/.codex/
    // which is bind-mounted above. Explicitly do NOT forward OPENAI_API_KEY.
  };
});
