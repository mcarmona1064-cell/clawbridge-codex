/**
 * Offer Codex-assisted debugging when a setup step fails.
 *
 * Flow:
 *   1. Check `codex` is on PATH and the user is signed in. If not,
 *      silently skip — pre-auth failures can't use this path.
 *   2. Ask the user for consent ("Want me to ask Codex for a fix?").
 *   3. Build a minimal prompt: the one-paragraph situation, the failing
 *      step's name/message/hint, and a short list of *file references*
 *      (not contents) so Codex can read what it needs on its own.
 *   4. Spawn `codex exec --json --sandbox read-only` with a spinner that
 *      shows elapsed time.
 *   5. Parse `REASON:` / `COMMAND:` out of the response. Show the reason
 *      in a clack note, then hand off to `setup/run-suggested.sh` for
 *      editable pre-fill + exec.
 *
 * Skippable with CLAWBRIDGE_SKIP_CODEX_ASSIST=1 for CI/scripted runs.
 */
import { execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import * as p from '@clack/prompts';
import k from 'kleur';

import { ensureAnswer } from './runner.js';
import { fitToWidth } from './theme.js';

export interface AssistContext {
  stepName: string;
  msg: string;
  hint?: string;
  /** Absolute path to the per-step raw log, if the caller has one. */
  rawLogPath?: string;
}

/**
 * File-path hints per step. Codex reads these on its own via its tools
 * rather than us stuffing contents into the prompt. Keys are step names
 * as they appear in fail() calls; values are repo-relative paths.
 */
const STEP_FILES: Record<string, string[]> = {
  bootstrap: ['setup.sh', 'setup/install-node.sh', 'clawbridge.sh'],
  environment: ['setup/environment.ts'],
  container: [
    'setup/container.ts',
    'setup/install-docker.sh',
    'container/Dockerfile',
  ],
  auth: [
    'setup/auth.ts',
    'setup/register-codex.sh',
    'setup/install-codex.sh',
  ],
  mounts: ['setup/mounts.ts'],
  service: ['setup/service.ts'],
  'cli-agent': ['setup/cli-agent.ts', 'scripts/init-cli-agent.ts'],
  timezone: ['setup/timezone.ts'],
  channel: ['setup/auto.ts'],
  verify: ['setup/verify.ts'],
  // Channel-specific sub-steps:
  'telegram-install': ['setup/add-telegram.sh', 'setup/channels/telegram.ts'],
  'telegram-validate': ['setup/channels/telegram.ts'],
  'pair-telegram': ['setup/pair-telegram.ts', 'setup/channels/telegram.ts'],
  'discord-install': ['setup/add-discord.sh', 'setup/channels/discord.ts'],
  'slack-install': ['setup/add-slack.sh', 'setup/channels/slack.ts'],
  'slack-validate': ['setup/channels/slack.ts'],
  'imessage-install': ['setup/add-imessage.sh', 'setup/channels/imessage.ts'],
  imessage: ['setup/channels/imessage.ts'],
  'teams-install': ['setup/add-teams.sh', 'setup/channels/teams.ts'],
  'teams-manifest': ['setup/lib/teams-manifest.ts', 'setup/channels/teams.ts'],
  'init-first-agent': [
    'scripts/init-first-agent.ts',
    'setup/channels/telegram.ts',
    'setup/channels/discord.ts',
  ],
};

const BIG_PICTURE_FILES = ['README.md', 'setup/auto.ts'];

/**
 * Returns `true` if the user ran a Codex-suggested fix command; callers
 * can use that signal to offer a retry instead of aborting outright.
 * Returns `false` for every other outcome (skipped, declined, no command,
 * Codex unreachable, user chose not to run).
 */
export async function offerCodexAssist(
  ctx: AssistContext,
  projectRoot: string = process.cwd(),
): Promise<boolean> {
  if (process.env.CLAWBRIDGE_SKIP_CODEX_ASSIST === '1') return false;
  if (!isCodexUsable()) return false;

  const want = ensureAnswer(
    await p.confirm({
      message: 'Want me to ask Codex to diagnose this?',
      initialValue: true,
    }),
  );
  if (!want) return false;

  const prompt = buildPrompt(ctx, projectRoot);
  const response = await queryCodexUnderSpinner(prompt, projectRoot);
  if (!response) return false;

  const parsed = parseResponse(response);
  if (!parsed) {
    p.log.warn("Codex responded but I couldn't parse a command out of it.");
    p.log.message(k.dim(response.trim().slice(0, 500)));
    return false;
  }

  p.note(
    `${parsed.reason}\n\n${k.cyan('$')} ${parsed.command}`,
    "Codex's suggestion",
  );

  const run = ensureAnswer(
    await p.confirm({
      message: 'Run this command? (you can edit it before executing)',
      initialValue: true,
    }),
  );
  if (!run) return false;

  await runSuggested(parsed.command, projectRoot);
  return true;
}

function isCodexUsable(): boolean {
  try {
    execSync('command -v codex', { stdio: 'ignore' });
  } catch {
    return false;
  }
  // We don't pre-check auth — a real query will surface the auth error
  // if the user hasn't signed in via `codex login`.
  return true;
}

function buildPrompt(ctx: AssistContext, projectRoot: string): string {
  const stepRefs = STEP_FILES[ctx.stepName] ?? [];
  const references = [
    ...BIG_PICTURE_FILES,
    ...stepRefs,
    'logs/setup.log',
    ctx.rawLogPath
      ? path.relative(projectRoot, ctx.rawLogPath)
      : 'logs/setup-steps/',
  ].filter((v, i, a) => a.indexOf(v) === i);

  const hintLine = ctx.hint ? `Hint shown to the user: ${ctx.hint}\n` : '';

  return [
    "I'm trying to set up ClawBridge on my machine and ran into an issue",
    'during the setup flow. Please read the referenced files to understand',
    'the flow and the step that failed, look at the logs to see what went',
    'wrong, then suggest a single bash command I can run to fix it.',
    '',
    `Failed step: ${ctx.stepName}`,
    `Error shown to the user: ${ctx.msg}`,
    hintLine,
    'References (read as needed):',
    ...references.map((r) => `  - ${r}`),
    '',
    'Respond in EXACTLY this format, nothing before or after:',
    '',
    'REASON: <one short line describing the root cause>',
    'COMMAND: <single bash command, one line, no backticks>',
    '',
    'If no safe single command can fix it, respond with:',
    'REASON: <why>',
    'COMMAND: none',
  ].join('\n');
}

// The thread id from the first codex-assist invocation in this process.
// Subsequent invocations pass `exec resume <id>` so Codex sees prior
// failures as conversation history.
let codexThreadId: string | null = null;

const SPINNER_FRAMES = ['◒', '◐', '◓', '◑'];
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

interface CodexEvent {
  type?: string;
  thread_id?: string;
  message?: string;
  item?: { type?: string; text?: string };
}

async function queryCodexUnderSpinner(
  prompt: string,
  projectRoot: string,
): Promise<string | null> {
  const out = process.stdout;
  const start = Date.now();
  let frameIdx = 0;

  const redraw = (): void => {
    out.write('\x1b[1A\x1b[2K');
    const elapsed = Math.round((Date.now() - start) / 1000);
    const icon = SPINNER_FRAMES[frameIdx % SPINNER_FRAMES.length];
    const suffix = ` (${elapsed}s)`;
    const header = fitToWidth('Asking Codex to diagnose…', suffix);
    out.write(`${k.cyan(icon)}  ${header}${k.dim(suffix)}\n`);
  };

  const clearBlock = (): void => {
    out.write('\x1b[1A\x1b[2K');
  };

  out.write(HIDE_CURSOR);
  out.write('\n');
  redraw();

  const restoreCursorOnExit = (): void => {
    out.write(SHOW_CURSOR);
  };
  process.once('exit', restoreCursorOnExit);

  const frameTick = setInterval(() => {
    frameIdx++;
    redraw();
  }, 250);

  return new Promise((resolve) => {
    let lineBuf = '';
    let finalText = '';
    let stderr = '';
    let settled = false;

    const finish = (kind: 'ok' | 'error', payload: string | null): void => {
      clearInterval(frameTick);
      clearBlock();
      out.write(SHOW_CURSOR);
      process.off('exit', restoreCursorOnExit);
      const elapsed = Math.round((Date.now() - start) / 1000);
      const suffix = ` (${elapsed}s)`;
      if (kind === 'ok') {
        p.log.success(`${fitToWidth('Codex replied.', suffix)}${k.dim(suffix)}`);
        resolve(payload);
      } else {
        p.log.error(
          `${fitToWidth("Codex couldn't help here.", suffix)}${k.dim(suffix)}`,
        );
        const tail = stderr.trim().split('\n').slice(-3).join('\n');
        if (tail) p.log.message(k.dim(tail));
        resolve(null);
      }
    };

    // Resume the same thread on repeat invocations so Codex carries
    // context across failures in one setup run.
    const args = codexThreadId
      ? ['exec', 'resume', '--json', '--skip-git-repo-check', codexThreadId, '--', prompt]
      : [
          'exec',
          '--json',
          '--sandbox',
          'read-only',
          '--skip-git-repo-check',
          '-C',
          projectRoot,
          '--',
          prompt,
        ];

    const child = spawn('codex', args, {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout.on('data', (c: Buffer) => {
      lineBuf += c.toString('utf-8');
      let idx: number;
      while ((idx = lineBuf.indexOf('\n')) !== -1) {
        const line = lineBuf.slice(0, idx);
        lineBuf = lineBuf.slice(idx + 1);
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as CodexEvent;
          if (
            !codexThreadId &&
            event.type === 'thread.started' &&
            typeof event.thread_id === 'string'
          ) {
            codexThreadId = event.thread_id;
          }
          if (
            event.type === 'item.completed' &&
            event.item?.type === 'agent_message' &&
            typeof event.item.text === 'string'
          ) {
            finalText = event.item.text;
          }
        } catch {
          // Malformed or non-JSON line — ignore.
        }
      }
    });
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString('utf-8');
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (code === 0 && finalText.trim()) finish('ok', finalText);
      else finish('error', null);
    });
    child.on('error', () => {
      if (settled) return;
      settled = true;
      finish('error', null);
    });
  });
}

function parseResponse(
  raw: string,
): { reason: string; command: string } | null {
  // Accept the fields anywhere in the output — Codex sometimes wraps the
  // answer in a trailing explanation we can safely ignore.
  const reasonMatch = raw.match(/^\s*REASON:\s*(.+?)\s*$/m);
  const commandMatch = raw.match(/^\s*COMMAND:\s*(.+?)\s*$/m);
  if (!reasonMatch || !commandMatch) return null;
  const command = commandMatch[1].trim();
  if (!command || command.toLowerCase() === 'none') return null;
  return { reason: reasonMatch[1].trim(), command };
}

function runSuggested(command: string, projectRoot: string): Promise<void> {
  const script = path.join(projectRoot, 'setup/run-suggested.sh');
  if (!fs.existsSync(script)) {
    p.log.error(`Missing helper: ${script}`);
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const child = spawn('bash', [script, command], {
      cwd: projectRoot,
      stdio: 'inherit',
    });
    child.on('close', () => resolve());
    child.on('error', () => resolve());
  });
}
