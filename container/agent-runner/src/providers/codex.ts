/**
 * OpenAI Codex CLI provider (@openai/codex@0.129.0).
 *
 * Runs `codex app-server --listen stdio://` as a persistent subprocess and
 * communicates via JSON-RPC over its stdin/stdout.
 *
 * Auth model: subscription OAuth only — `codex login --device-auth`.
 * OPENAI_API_KEY and CODEX_API_KEY must NOT be present in env to avoid
 * bypassing subscription OAuth with API billing.
 */

import { spawn, type ChildProcess } from 'child_process';

import { registerProvider } from './provider-registry.js';
import type {
  AgentProvider,
  AgentQuery,
  McpServerConfig,
  ProviderEvent,
  ProviderOptions,
  QueryInput,
} from './types.js';

function log(msg: string): void {
  console.error(`[codex-provider] ${msg}`);
}

/**
 * Serialize MCP server configs to TOML dotted-key lines for Codex
 * `-c mcp_servers=...` flag.
 *
 * Each server becomes lines like:
 *   mcp_servers.myserver.command = "node"
 *   mcp_servers.myserver.args = ["/path/to/server.js"]
 *   mcp_servers.myserver.env.KEY = "value"
 */
function serializeMcpToToml(servers: Record<string, McpServerConfig>): string {
  const lines: string[] = [];
  for (const [name, cfg] of Object.entries(servers)) {
    const prefix = `mcp_servers.${tomlKey(name)}`;
    lines.push(`${prefix}.command = ${tomlStr(cfg.command)}`);
    if (cfg.args.length > 0) {
      lines.push(`${prefix}.args = [${cfg.args.map(tomlStr).join(', ')}]`);
    }
    for (const [k, v] of Object.entries(cfg.env)) {
      lines.push(`${prefix}.env.${tomlKey(k)} = ${tomlStr(v)}`);
    }
  }
  return lines.join('\n');
}

function tomlStr(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function tomlKey(k: string): string {
  return /^[A-Za-z0-9_-]+$/.test(k) ? k : `"${k.replace(/"/g, '\\"')}"`;
}

/** Stale-session detection for Codex error messages. */
const STALE_SESSION_RE = /session.*not found|unknown.*thread|invalid.*session/i;

export class CodexProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;

  private mcpServers: Record<string, McpServerConfig>;
  private additionalDirectories?: string[];

  constructor(options: ProviderOptions = {}) {
    this.mcpServers = options.mcpServers ?? {};
    this.additionalDirectories = options.additionalDirectories;
    // Note: assistantName not used by Codex — system prompt is set via -c instructions
    void options.assistantName;
    void this.additionalDirectories;
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return STALE_SESSION_RE.test(msg);
  }

  query(input: QueryInput): AgentQuery {
    const args = buildCodexArgs(this.mcpServers, input);

    // Strip API key env vars — must not be present for subscription OAuth
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env['OPENAI_API_KEY'];
    delete env['CODEX_API_KEY'];
    delete env['OPENAI_BASE_URL'];

    log(`Spawning: codex ${args.join(' ')}`);
    const proc = spawn('codex', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      cwd: input.cwd,
    });

    let aborted = false;
    const pushQueue: string[] = [];
    let ended = false;

    const pushToProc = (text: string) => {
      if (aborted || ended) return;
      const msg = JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'turn/submit', params: { input: text } });
      proc.stdin!.write(msg + '\n');
    };

    let nextId = 1;

    // Send initial turn after process starts
    const sendInitial = () => {
      if (input.continuation) {
        const resumeMsg = JSON.stringify({
          jsonrpc: '2.0', id: nextId++, method: 'session/resume', params: { sessionId: input.continuation },
        });
        proc.stdin!.write(resumeMsg + '\n');
      }
      pushToProc(input.prompt);
      // Drain any queued messages
      for (const msg of pushQueue) pushToProc(msg);
      pushQueue.length = 0;
    };

    proc.on('spawn', sendInitial);

    const events = translateEvents(proc, () => aborted);

    return {
      push: (msg) => {
        if (proc.pid) {
          pushToProc(msg);
        } else {
          pushQueue.push(msg);
        }
      },
      end: () => {
        ended = true;
        try { proc.stdin!.end(); } catch { /* ignore */ }
      },
      events,
      abort: () => {
        aborted = true;
        ended = true;
        try { proc.kill('SIGTERM'); } catch { /* ignore */ }
      },
    };
  }
}

function buildCodexArgs(
  mcpServers: Record<string, McpServerConfig>,
  input: QueryInput,
): string[] {
  const args = ['app-server', '--listen', 'stdio://'];

  if (Object.keys(mcpServers).length > 0) {
    const toml = serializeMcpToToml(mcpServers);
    args.push('-c', `mcp_servers=${toml}`);
  }

  const instructions = input.systemContext?.instructions;
  if (instructions) {
    const escaped = instructions.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
    args.push('-c', `instructions="${escaped}"`);
  }

  return args;
}

async function* translateEvents(
  proc: ChildProcess,
  isAborted: () => boolean,
): AsyncGenerator<ProviderEvent> {
  let buffer = '';
  let continuation: string | undefined;

  const lines = lineIterator(proc, isAborted);

  for await (const line of lines) {
    if (isAborted()) return;
    if (!line.trim()) continue;

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // Non-JSON stdout (progress/debug), ignore
      continue;
    }

    // Yield activity on every message for poll-loop idle timer
    yield { type: 'activity' };

    const method = msg['method'] as string | undefined;
    const params = msg['params'] as Record<string, unknown> | undefined;
    const error = msg['error'] as Record<string, unknown> | undefined;

    if (error) {
      const message = String(error['message'] ?? 'Codex error');
      const code = error['code'];
      const retryable = code === -32603 || code === 429;
      yield { type: 'error', message, retryable };
      return;
    }

    if (method === 'session/created' || method === 'session/resumed') {
      if (params && typeof params['sessionId'] === 'string') {
        continuation = params['sessionId'];
        log(`Session: ${continuation}`);
        yield { type: 'init', continuation };
      }
    } else if (method === 'output/text') {
      if (params && typeof params['text'] === 'string') {
        yield { type: 'progress', message: params['text'] };
      }
    } else if (method === 'turn/complete') {
      const result = params && typeof params['text'] === 'string' ? params['text'] : null;
      yield { type: 'result', text: result };
      return;
    } else if (method === 'turn/delta') {
      // Streaming delta — activity already yielded above
    }
  }

  // Process ended without turn/complete
  if (!isAborted()) {
    yield { type: 'result', text: null };
  }
}

async function* lineIterator(
  proc: ChildProcess,
  isAborted: () => boolean,
): AsyncGenerator<string> {
  let buffer = '';
  const queue: string[] = [];
  let resolve: (() => void) | null = null;
  let done = false;

  proc.stdout!.setEncoding('utf8');
  proc.stdout!.on('data', (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) queue.push(line);
    resolve?.();
  });

  proc.stderr!.setEncoding('utf8');
  proc.stderr!.on('data', (chunk: string) => {
    for (const line of chunk.trim().split('\n')) {
      if (line) log(`stderr: ${line}`);
    }
  });

  proc.on('close', () => {
    if (buffer.trim()) queue.push(buffer);
    done = true;
    resolve?.();
  });

  proc.on('error', (err) => {
    log(`process error: ${err.message}`);
    done = true;
    resolve?.();
  });

  while (true) {
    while (queue.length > 0) {
      yield queue.shift()!;
    }
    if (done || isAborted()) return;
    await new Promise<void>((r) => { resolve = r; });
    resolve = null;
  }
}

registerProvider('codex', (opts) => new CodexProvider(opts));
