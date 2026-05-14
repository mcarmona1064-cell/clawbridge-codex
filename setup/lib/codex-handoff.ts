/**
 * User-initiated handoff to interactive Codex, parallel to codex-assist.ts.
 *
 * codex-assist is for failures: it runs `codex exec --json` non-interactively,
 * parses a suggested command, and offers to run it. This module is for the
 * opposite case — the user is mid-flow, not stuck on an error, and wants
 * Codex to walk them through something the driver can't fully automate
 * (Azure portal clickthrough, writing a manifest, tunneling a port, etc.).
 *
 * Flow:
 *   1. Build a handoff prompt from the caller's context: channel, current
 *      step, completed steps, collected values (secrets redacted), relevant
 *      files to read.
 *   2. Spawn `codex --sandbox workspace-write --skip-git-repo-check
 *      <prompt>` with `stdio: 'inherit'` so Codex owns the terminal.
 *   3. When Codex exits (user types /exit, Ctrl-D, or closes the session),
 *      control returns to the setup driver. The driver can then re-offer the
 *      same step (e.g., "How did that go?" select).
 *
 * Also exports a small helper for text/password prompts: `validateWithHelpEscape`
 * wraps a validate callback so typing `?` triggers the handoff instead of
 * attempting to parse it as a real answer.
 */
import { execSync, spawn } from 'child_process';

import * as p from '@clack/prompts';
import k from 'kleur';

export interface HandoffContext {
  /** Channel this handoff is happening in (e.g., 'teams'). */
  channel: string;
  /** Short name of the current step the user is stuck on. */
  step: string;
  /** Human-readable summary of what the user was trying to do at this step. */
  stepDescription: string;
  /** Checklist of sub-steps already completed (displayed as `✓ <item>`). */
  completedSteps?: string[];
  /**
   * Key/value pairs of values collected so far. Callers should redact
   * secrets before passing (e.g., show last 4 chars). Used to give Codex
   * the state of the operator's progress.
   */
  collectedValues?: Record<string, string>;
  /**
   * Repo-relative paths Codex should consider reading. Always gets
   * logs/setup.log and the relevant SKILL.md appended by the builder.
   */
  files?: string[];
}

/**
 * Spawn interactive Codex with context pre-loaded as the initial prompt.
 * Returns when Codex exits.
 *
 * Silently no-ops (returns `false`) if `codex` isn't on PATH — setup runs
 * where the binary is guaranteed to exist (we install it in the auth step),
 * but an ultra-early flow failure could technically reach this before that
 * install, and crashing the handoff would be worse than the handoff not
 * firing.
 */
export async function offerCodexHandoff(ctx: HandoffContext): Promise<boolean> {
  if (!isCodexUsable()) {
    p.log.warn(
      "Codex isn't installed yet — can't hand you off here. Finish setup first, then retry.",
    );
    return false;
  }

  const prompt = buildPrompt(ctx);

  p.note(
    [
      "I'm handing you off to Codex in interactive mode.",
      "It has the context of where you are in setup.",
      "",
      k.dim("Type /quit (or press Ctrl-D) when you're ready to come back to setup."),
    ].join('\n'),
    'Handing off to Codex',
  );

  return new Promise<boolean>((resolve) => {
    const child = spawn(
      'codex',
      [
        '--sandbox',
        'workspace-write',
        '--skip-git-repo-check',
        prompt,
      ],
      { stdio: 'inherit' },
    );
    child.on('close', () => {
      p.log.success("Back from Codex. Let's continue.");
      resolve(true);
    });
    child.on('error', () => {
      p.log.error("Couldn't launch Codex. Continuing without handoff.");
      resolve(false);
    });
  });
}

/**
 * Sentinel returned by `validateWithHelpEscape` when the user types `?`.
 * The caller compares against this to decide whether to trigger a handoff.
 */
export const HELP_ESCAPE_SENTINEL = '__CLAWBRIDGE_HELP_ESCAPE__';

/**
 * Wrap a clack `validate` callback so typing `?` short-circuits validation
 * and returns the HELP_ESCAPE_SENTINEL. Caller should check for the sentinel
 * after awaiting the prompt and trigger offerCodexHandoff if matched.
 *
 * Usage:
 *   const answer = await p.text({
 *     message: 'Paste your Azure App ID',
 *     validate: validateWithHelpEscape((v) => {
 *       if (!/^[0-9a-f-]{36}$/.test(v)) return 'Expected a UUID';
 *       return undefined;
 *     }),
 *   });
 *   if (answer === HELP_ESCAPE_SENTINEL) { await offerCodexHandoff(ctx); ... }
 */
export function validateWithHelpEscape(
  inner?: (value: string) => string | Error | undefined,
): (value: string) => string | Error | undefined {
  return (value: string) => {
    if ((value ?? '').trim() === '?') {
      // Returning undefined lets clack accept the `?` as the "answer". The
      // caller sees a literal "?" and should compare + escape to handoff.
      return undefined;
    }
    return inner ? inner(value) : undefined;
  };
}

/**
 * True if the value returned by a text/password prompt should trigger a
 * handoff. Abstracts the sentinel check so callers don't have to import it
 * directly at every site.
 */
export function isHelpEscape(value: unknown): boolean {
  return typeof value === 'string' && value.trim() === '?';
}

function isCodexUsable(): boolean {
  try {
    execSync('command -v codex', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function buildPrompt(ctx: HandoffContext): string {
  const lines: string[] = [
    `The user is running ClawBridge's interactive \`setup:auto\` flow to wire the ${ctx.channel} channel.`,
    `They got stuck at the step: "${ctx.step}" (${ctx.stepDescription}) and asked for help.`,
    '',
    "Your job: help them complete this specific step and get back to setup.",
    "You can read files, run commands, search the web, and explain concepts.",
    "Be concise. When they're ready to resume, tell them to type /quit and",
    "they'll return to the setup flow at the same step.",
    '',
  ];

  if (ctx.completedSteps && ctx.completedSteps.length > 0) {
    lines.push('Steps they have already completed:');
    for (const s of ctx.completedSteps) lines.push(`  ✓ ${s}`);
    lines.push('');
  }

  if (ctx.collectedValues && Object.keys(ctx.collectedValues).length > 0) {
    lines.push('Values collected so far (secrets redacted):');
    for (const [k, v] of Object.entries(ctx.collectedValues)) {
      lines.push(`  ${k}: ${v}`);
    }
    lines.push('');
  }

  const files = [
    ...(ctx.files ?? []),
    'logs/setup.log',
    'logs/setup-steps/',
    `.claude/skills/add-${ctx.channel}/SKILL.md`,
    `setup/channels/${ctx.channel}.ts`,
  ].filter((v, i, a) => a.indexOf(v) === i);

  lines.push('Relevant files (read as needed):');
  for (const f of files) lines.push(`  - ${f}`);

  return lines.join('\n');
}
