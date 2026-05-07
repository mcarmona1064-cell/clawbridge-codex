/**
 * Host-side host_exec watcher.
 *
 * Pairs with container/agent-runner/src/mcp-tools/host-exec.ts. The container
 * tool drops a JSON request file under `<sessionDir>/exec/requests/`; this
 * module scans active sessions, runs the command via child_process.exec, and
 * writes the result back to `<sessionDir>/exec/responses/<id>.json`.
 *
 * Gating happens here too (defense in depth — the container tool also gates):
 * a session's agent group must have `allowHostExec: true` in container.json.
 * Anything else gets a permission-denied response and the request is removed.
 */
import { exec } from 'child_process';
import fs from 'fs';
import { homedir } from 'os';
import path from 'path';

import { readContainerConfig } from '../../container-config.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getActiveSessions } from '../../db/sessions.js';
import { log } from '../../log.js';
import { sessionDir } from '../../session-manager.js';

const POLL_INTERVAL_MS = 250;

interface ExecRequest {
  id: string;
  command: string;
  timeout: number;
  cwd?: string;
}

interface ExecResponse {
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string;
}

const inflight = new Set<string>();

function writeAtomic(filepath: string, data: string): void {
  const tmp = `${filepath}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filepath);
}

function runCommand(req: ExecRequest): Promise<ExecResponse> {
  return new Promise((resolve) => {
    const cwd = req.cwd || homedir();
    exec(
      req.command,
      { cwd, timeout: req.timeout, maxBuffer: 10 * 1024 * 1024, shell: '/bin/bash' },
      (error, stdout, stderr) => {
        if (error) {
          // ChildProcess errors carry exit code on `code` and signal on `signal`.
          const e = error as NodeJS.ErrnoException & { code?: number | string; signal?: string };
          const exitCode = typeof e.code === 'number' ? e.code : 1;
          resolve({
            exitCode,
            stdout: String(stdout ?? ''),
            stderr: String(stderr ?? ''),
            error: e.signal ? `${error.message} (signal: ${e.signal})` : error.message,
          });
          return;
        }
        resolve({ exitCode: 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      },
    );
  });
}

async function processRequest(reqDir: string, resDir: string, filename: string, allowed: boolean): Promise<void> {
  const reqPath = path.join(reqDir, filename);
  const inflightKey = reqPath;
  if (inflight.has(inflightKey)) return;
  inflight.add(inflightKey);

  try {
    let req: ExecRequest;
    try {
      req = JSON.parse(fs.readFileSync(reqPath, 'utf-8')) as ExecRequest;
    } catch (err) {
      // Partially-written or malformed file — leave it; either the writer's
      // atomic rename will land on the next tick, or we'll surface it as an
      // error if it stays unparseable.
      log.debug('host_exec: request not yet parseable', { reqPath, err: (err as Error).message });
      return;
    }

    if (!req.id || !req.command) {
      log.warn('host_exec: invalid request, removing', { reqPath });
      try {
        fs.unlinkSync(reqPath);
      } catch {
        /* ignore */
      }
      return;
    }

    const resPath = path.join(resDir, `${req.id}.json`);
    fs.mkdirSync(resDir, { recursive: true });

    let response: ExecResponse;
    if (!allowed) {
      response = {
        exitCode: 126,
        stdout: '',
        stderr: '',
        error: 'host_exec is not enabled for this agent group (allowHostExec is false in container.json).',
      };
      log.warn('host_exec: rejected — allowHostExec is false', { reqId: req.id });
    } else {
      log.info('host_exec: running', { reqId: req.id, command: req.command, cwd: req.cwd, timeout: req.timeout });
      response = await runCommand(req);
      log.info('host_exec: completed', { reqId: req.id, exitCode: response.exitCode });
    }

    writeAtomic(resPath, JSON.stringify(response));
    try {
      fs.unlinkSync(reqPath);
    } catch {
      /* ignore — request may have been removed already */
    }
  } finally {
    inflight.delete(inflightKey);
  }
}

let polling = false;

export async function pollOnce(): Promise<void> {
  const sessions = getActiveSessions();
  for (const session of sessions) {
    const dir = sessionDir(session.agent_group_id, session.id);
    const reqDir = path.join(dir, 'exec', 'requests');
    if (!fs.existsSync(reqDir)) continue;

    let files: string[];
    try {
      files = fs.readdirSync(reqDir).filter((f) => f.endsWith('.json'));
    } catch {
      continue;
    }
    if (files.length === 0) continue;

    const resDir = path.join(dir, 'exec', 'responses');
    const group = getAgentGroup(session.agent_group_id);
    const allowed = group ? readContainerConfig(group.folder).allowHostExec === true : false;

    for (const f of files) {
      // Fire-and-forget so a single slow command doesn't block other sessions.
      void processRequest(reqDir, resDir, f, allowed);
    }
  }
}

async function loop(): Promise<void> {
  while (polling) {
    try {
      await pollOnce();
    } catch (err) {
      log.error('host_exec poll error', { err: (err as Error).message });
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

export function startHostExecWatcher(): void {
  if (polling) return;
  polling = true;
  void loop();
  log.info('host_exec watcher started');
}

export function stopHostExecWatcher(): void {
  polling = false;
}
