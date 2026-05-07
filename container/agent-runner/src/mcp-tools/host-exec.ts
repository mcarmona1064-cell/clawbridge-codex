/**
 * host_exec MCP tool — file-IPC bridge to a host-side command runner.
 *
 * Container writes a request JSON under /workspace/exec/requests/<id>.json
 * and polls /workspace/exec/responses/<id>.json for the result. The host
 * runs a watcher loop (see src/modules/host-exec/ on the host side) that
 * picks up requests, executes them, and writes the response back.
 *
 * Gated by `allowHostExec` in /workspace/agent/container.json. Default off.
 * The host re-enforces the gate before executing — defense in depth.
 */
import fs from 'fs';
import path from 'path';

import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const REQUESTS_DIR = '/workspace/exec/requests';
const RESPONSES_DIR = '/workspace/exec/responses';
const CONTAINER_CONFIG = '/workspace/agent/container.json';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 600_000;
const POLL_INTERVAL_MS = 200;

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

function isAllowed(): boolean {
  try {
    const raw = fs.readFileSync(CONTAINER_CONFIG, 'utf-8');
    const cfg = JSON.parse(raw) as { allowHostExec?: boolean };
    return cfg.allowHostExec === true;
  } catch {
    return false;
  }
}

function writeAtomic(filepath: string, data: string): void {
  const tmp = `${filepath}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filepath);
}

interface ExecResponse {
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string;
}

export const hostExec: McpToolDefinition = {
  tool: {
    name: 'host_exec',
    description:
      'Execute a shell command on the host machine and wait for its output. Returns stdout, stderr, and exit code. Requires `allowHostExec: true` in container.json (defaults off). Use for system administration, package installs, process management, and any terminal operation that needs to run outside the container.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        command: { type: 'string', description: 'The bash command to execute on the host.' },
        timeout: {
          type: 'integer',
          description: `Timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS}, max: ${MAX_TIMEOUT_MS}).`,
        },
        cwd: {
          type: 'string',
          description: 'Working directory for the command (default: host home directory).',
        },
      },
      required: ['command'],
    },
  },
  async handler(args) {
    if (!isAllowed()) {
      return err(
        'host_exec is disabled for this agent group. Set "allowHostExec": true in container.json to enable, then restart the container.',
      );
    }

    const command = (args.command as string)?.trim();
    if (!command) return err('command is required');

    const timeout = Math.min(Math.max(Number(args.timeout) || DEFAULT_TIMEOUT_MS, 1_000), MAX_TIMEOUT_MS);
    const cwd = (args.cwd as string) || undefined;

    const requestId = `exec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    fs.mkdirSync(REQUESTS_DIR, { recursive: true });
    fs.mkdirSync(RESPONSES_DIR, { recursive: true });

    const reqPath = path.join(REQUESTS_DIR, `${requestId}.json`);
    writeAtomic(
      reqPath,
      JSON.stringify({ id: requestId, command, timeout, cwd, createdAt: new Date().toISOString() }),
    );

    const resPath = path.join(RESPONSES_DIR, `${requestId}.json`);
    const deadline = Date.now() + timeout + 10_000; // extra buffer for IPC latency

    while (Date.now() < deadline) {
      if (fs.existsSync(resPath)) {
        try {
          const raw = fs.readFileSync(resPath, 'utf-8');
          const result = JSON.parse(raw) as ExecResponse;
          try {
            fs.unlinkSync(resPath);
          } catch {
            /* already gone */
          }
          let text = `Exit code: ${result.exitCode}`;
          if (result.stdout) text += `\n--- stdout ---\n${result.stdout}`;
          if (result.stderr) text += `\n--- stderr ---\n${result.stderr}`;
          if (result.error) text += `\n--- error ---\n${result.error}`;
          return { content: [{ type: 'text' as const, text }], isError: result.exitCode !== 0 };
        } catch {
          // partially-written file — keep polling, the host's atomic rename will land shortly.
        }
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }

    // Best-effort cleanup of the orphaned request so the host doesn't run it later.
    try {
      fs.unlinkSync(reqPath);
    } catch {
      /* host may have already picked it up */
    }
    return err(
      `host_exec timed out after ${timeout}ms. The host watcher may not be running — verify the clawbridge service is up.`,
    );
  },
};

registerTools([hostExec]);
