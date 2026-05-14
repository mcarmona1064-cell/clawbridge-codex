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
import path from 'path';

import { DATA_DIR } from '../config.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

registerProviderContainerConfig('codex', ({ agentGroupId }) => {
  // Per-group .codex sessions directory
  const codexDir = path.join(DATA_DIR, 'v2-sessions', agentGroupId, '.codex-shared');
  fs.mkdirSync(codexDir, { recursive: true });

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
