// TODO: This scripted path is incomplete — use `clawbridge-agent setup` (interactive wizard) instead.
// See Bug 6 in diagnostic report 2026-04-27.
/**
 * Non-interactive setup driver — the step sequencer for `pnpm run setup:auto`.
 *
 * Responsibility: orchestrate the sequence of steps end-to-end and route
 * between them. The runner, spawning, status parsing, spinner, abort, and
 * prompt primitives live in `setup/lib/runner.ts`; theming in
 * `setup/lib/theme.ts`; Telegram's full flow in `setup/channels/telegram.ts`.
 *
 * Config via env:
 *   CLAWBRIDGE_DISPLAY_NAME  how the agents address the operator — skips the
 *                          prompt. Defaults to $USER.
 *   CLAWBRIDGE_AGENT_NAME    messaging-channel agent name (consumed by the
 *                          channel flow). The CLI scratch agent is always
 *                          "Terminal Agent".
 *   CLAWBRIDGE_SKIP          comma-separated step names to skip
 *                          (environment|container|auth|mounts|
 *                           service|cli-agent|timezone|channel|verify|
 *                           first-chat)
 *
 * Timezone is auto-detected after the CLI agent step. UTC resolves are
 * confirmed with the user, and free-text replies fall through to a
 * headless `codex exec` call for IANA-zone resolution.
 */
import fs from 'fs';
import path from 'path';
import { spawn, spawnSync } from 'child_process';

import * as p from '@clack/prompts';
import k from 'kleur';

import { runDiscordChannel } from './channels/discord.js';
import { runIMessageChannel } from './channels/imessage.js';
import { runSignalChannel } from './channels/signal.js';
import { runSlackChannel } from './channels/slack.js';
import { runTeamsChannel } from './channels/teams.js';
import { runTelegramChannel } from './channels/telegram.js';
import { runWhatsAppChannel } from './channels/whatsapp.js';
import { pingCliAgent, type PingResult } from './lib/agent-ping.js';
import { brightSelect } from './lib/bright-select.js';
import { runWindowedStep } from './lib/windowed-runner.js';
import { getLaunchdLabel, getSystemdUnit } from '../src/install-slug.js';
import * as setupLog from './logs.js';
import { ensureAnswer, fail, runQuietStep } from './lib/runner.js';
import { emit as phEmit } from './lib/diagnostics.js';
import { brandBold, brandChip, dimWrap, fitToWidth, wrapForGutter } from './lib/theme.js';
import { isValidTimezone } from '../src/timezone.js';

const CLI_AGENT_NAME = 'Terminal Agent';
const RUN_START = Date.now();

type ChannelChoice =
  | 'telegram'
  | 'discord'
  | 'whatsapp'
  | 'signal'
  | 'teams'
  | 'slack'
  | 'imessage'
  | 'skip';

async function main(): Promise<void> {
  printIntro();
  initProgressionLog();
  phEmit('auto_started');

  const skip = new Set(
    (process.env.CLAWBRIDGE_SKIP ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

  if (!skip.has('environment')) {
    const res = await runQuietStep('environment', {
      running: 'Checking your system…',
      done: 'Your system looks good.',
    });
    if (!res.ok) {
      await fail(
        'environment',
        "Your system doesn't look quite right.",
        'See logs/setup-steps/ for details, then retry.',
      );
    }
  }

  if (!skip.has('container')) {
    p.log.message(
      dimWrap(
        'Your assistant lives in its own sandbox. It can only see what you explicitly share.',
        4,
      ),
    );
    p.log.message(
      dimWrap(
        'The first build pulls a base image and installs a few tools. On a fresh machine this usually takes 3–10 minutes.',
        4,
      ),
    );
    const res = await runWindowedStep('container', {
      running: "Preparing your assistant's sandbox…",
      done: 'Sandbox ready.',
      failed: "Couldn't prepare the sandbox.",
    });
    if (!res.ok) {
      const err = res.terminal?.fields.ERROR;
      if (err === 'runtime_not_available') {
        await fail(
          'container',
          "Docker isn't available.",
          'Install Docker Desktop (or start it if already installed), then retry.',
        );
      }
      if (err === 'docker_group_not_active') {
        await fail(
          'container',
          "Docker was just installed but your shell doesn't know yet.",
          'Log out and back in (or run `newgrp docker` in a new shell), then retry.',
        );
      }
      await fail(
        'container',
        "Couldn't build the sandbox.",
        'If Docker has a stale cache, try: `docker builder prune -f`, then retry.',
      );
    }
    maybeReexecUnderSg();
  }

  if (!skip.has('auth')) {
    await runAuthStep();
  }

  if (!skip.has('mounts')) {
    const res = await runQuietStep(
      'mounts',
      {
        running: "Setting your assistant's access rules…",
        done: 'Access rules set.',
        skipped: 'Access rules already set.',
      },
      ['--empty'],
    );
    if (!res.ok) {
      await fail('mounts', "Couldn't write access rules.");
    }
  }

  if (!skip.has('service')) {
    const res = await runQuietStep('service', {
      running: 'Starting ClawBridge in the background…',
      done: 'ClawBridge is running.',
    });
    if (!res.ok) {
      await fail(
        'service',
        "Couldn't start ClawBridge.",
        'See logs/clawbridge.error.log for details.',
      );
    }
    if (res.terminal?.fields.DOCKER_GROUP_STALE === 'true') {
      p.log.warn(
        "ClawBridge's permissions need a tweak before it can reach Docker.",
      );
      p.log.message(
        '  sudo setfacl -m u:$(whoami):rw /var/run/docker.sock\n' +
          `  systemctl --user restart ${getSystemdUnit()}`,
      );
    }
  }

  let displayName: string | undefined;
  const needsDisplayName = !skip.has('cli-agent') || !skip.has('channel');
  if (needsDisplayName) {
    const fallback = process.env.USER?.trim() || 'Operator';
    const preset = process.env.CLAWBRIDGE_DISPLAY_NAME?.trim();
    displayName = preset || (await askDisplayName(fallback));
  }

  if (!skip.has('cli-agent')) {
    const res = await runQuietStep(
      'cli-agent',
      {
        running: 'Bringing your assistant online…',
        done: 'Assistant wired up.',
      },
      ['--display-name', displayName!, '--agent-name', CLI_AGENT_NAME],
    );
    if (!res.ok) {
      await fail(
        'cli-agent',
        "Couldn't bring your assistant online.",
        `You can retry later with \`pnpm exec tsx scripts/init-cli-agent.ts --display-name "${displayName!}" --agent-name "${CLI_AGENT_NAME}"\`.`,
      );
    }
    if (!skip.has('first-chat')) {
      p.log.message(
        dimWrap(
          "Your assistant runs in an isolated sandbox. I'm going to send it a quick test message (ping) and wait for a reply (pong) to confirm it's responding. First startup typically takes 30–60 seconds while the sandbox warms up.",
          4,
        ),
      );
      const ping = await confirmAssistantResponds();
      if (ping === 'ok') {
        phEmit('first_chat_ready');
        const next = ensureAnswer(
          await p.select({
            message: 'What next?',
            options: [
              {
                value: 'continue',
                label: 'Continue with setup',
                hint: 'recommended',
              },
              {
                value: 'chat',
                label: 'Pause here and chat with your agent from the terminal',
              },
            ],
          }),
        ) as 'continue' | 'chat';
        setupLog.userInput('first_chat_choice', next);
        if (next === 'chat') await runFirstChat();
      } else {
        phEmit('first_chat_failed', { reason: ping });
        renderPingFailureNote(ping);
      }
    }
  }

  if (!skip.has('timezone')) {
    await runTimezoneStep();
  }

  let channelChoice: ChannelChoice = 'skip';
  if (!skip.has('channel')) {
    channelChoice = await askChannelChoice();
    if (channelChoice === 'telegram') {
      await runTelegramChannel(displayName!);
    } else if (channelChoice === 'discord') {
      await runDiscordChannel(displayName!);
    } else if (channelChoice === 'whatsapp') {
      await runWhatsAppChannel(displayName!);
    } else if (channelChoice === 'signal') {
      await runSignalChannel(displayName!);
    } else if (channelChoice === 'teams') {
      await runTeamsChannel(displayName!);
    } else if (channelChoice === 'slack') {
      await runSlackChannel(displayName!);
    } else if (channelChoice === 'imessage') {
      await runIMessageChannel(displayName!);
    } else {
      p.log.info(
        wrapForGutter(
          'No messaging app for now. You can add one later (like Telegram, Discord, WhatsApp, Teams, Slack, or iMessage).',
          4,
        ),
      );
    }
  }

  if (!skip.has('verify')) {
    const res = await runQuietStep('verify', {
      running: 'Making sure everything works together…',
      done: "Everything's connected.",
      failed: 'A few things still need your attention.',
    });
    if (!res.ok) {
      const notes: string[] = [];
      if (res.terminal?.fields.CREDENTIALS !== 'configured') {
        notes.push('• Your Codex account isn\'t connected. Re-run setup and try again.');
      }
      const service = res.terminal?.fields.SERVICE;
      if (service === 'running_other_checkout') {
        const label = getLaunchdLabel();
        notes.push(
          wrapForGutter(
            [
              '• Your ClawBridge service is running from a different folder on this machine.',
              '  Point it at this checkout with:',
              `    launchctl bootout gui/$(id -u)/${label}`,
              `    launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/${label}.plist`,
            ].join('\n'),
            6,
          ),
        );
      } else {
        const agentPing = res.terminal?.fields.AGENT_PING;
        if (agentPing && agentPing !== 'ok' && agentPing !== 'skipped') {
          notes.push(
            "• Your assistant didn't reply to a test message. " +
              'Check `logs/clawbridge.log` for clues, then try `pnpm run chat hi`.',
          );
        }
      }
      if (!res.terminal?.fields.CONFIGURED_CHANNELS) {
        notes.push('• Want to chat from your phone? Add a messaging app with `/add-telegram`, `/add-slack`, or `/add-discord`.');
      }
      if (notes.length > 0) {
        p.note(notes.join('\n'), "What's left");
      }
      // "What's left" is a soft failure — we don't abort like fail(), but the
      // user is still stuck; downstream LLM assist hook was removed in the codex port.
      const summary = notes
        .map((n) => n.replace(/^•\s*/, '').split('\n')[0].trim())
        .filter(Boolean)
        .join(' · ');
      phEmit('setup_incomplete', {
        unresolved_count: notes.length,
        service_running: res.terminal?.fields.SERVICE === 'running',
        has_credentials: res.terminal?.fields.CREDENTIALS === 'configured',
        agent_responds: res.terminal?.fields.AGENT_PING === 'ok',
      });
      p.outro(k.yellow('Almost there. A few things still need your attention.'));
      return;
    }
  }

  const rows: [string, string][] = [
    ['Chat in the terminal:', 'pnpm run chat hi'],
    ["See what's happening:", 'tail -f logs/clawbridge.log'],
    ['Open Codex:', 'codex'],
  ];
  const labelWidth = Math.max(...rows.map(([l]) => l.length));
  const nextSteps = rows
    .map(([l, c]) => `${k.cyan(l.padEnd(labelWidth))}  ${c}`)
    .join('\n');
  p.note(nextSteps, 'Try these');

  // Always-on warning goes before the "check your DMs" directive so the
  // caveat doesn't land after the user's already looked away at their phone.
  p.note(
    wrapForGutter(
      "ClawBridge runs on this machine. It's only reachable while this computer is on and connected to the internet. For always-on availability, run it on a cloud VM — or keep this machine awake.",
      6,
    ),
    'Heads up',
  );

  setupLog.complete(Date.now() - RUN_START);
  phEmit('setup_completed', { duration_ms: Date.now() - RUN_START });
  const dmTarget = channelDmLabel(channelChoice);
  if (dmTarget) {
    // Bright framed banner (not dim) — the whole point of the feedback was
    // that the welcome-message signal was too easy to miss. Use p.note so it
    // renders with a visible box, cyan-bold the directive line, and put it
    // as the last thing before outro.
    p.note(
      `${brandBold('→')} ${k.bold(`Check your ${dmTarget} — your assistant is saying hi.`)}`,
      'Go say hi',
    );
    p.outro(k.green("You're set."));
  } else {
    p.outro(k.green("You're ready! Chat with `pnpm run chat hi`."));
  }
}

function channelDmLabel(choice: ChannelChoice): string | null {
  switch (choice) {
    case 'telegram':
      return 'Telegram';
    case 'discord':
      return 'Discord DMs';
    case 'whatsapp':
      return 'WhatsApp';
    case 'signal':
      return 'Signal';
    case 'teams':
      return 'Teams';
    case 'imessage':
      return 'iMessage';
    case 'slack':
      // Slack install doesn't wire an agent or send a welcome DM — the
      // driver prints its own "finish in your Slack app" note. Falling
      // through to null avoids a misleading "check your Slack DMs" banner.
      return null;
    default:
      return null;
  }
}

// ─── first-chat step ───────────────────────────────────────────────────

/**
 * Round-trip ping against the CLI socket before we ask the user to chat.
 * Renders its own spinner with elapsed time because a cold-start container
 * boot can take 30–60s — the elapsed counter is the difference between
 * "patient" and "is this hung?". Returns the raw result so the caller can
 * branch between the chat loop (ok) and a diagnostic note (anything else).
 */
async function confirmAssistantResponds(): Promise<PingResult> {
  const s = p.spinner();
  const start = Date.now();
  const label = 'Waking your assistant…';
  s.start(fitToWidth(label, ' (999s)'));
  const tick = setInterval(() => {
    const elapsed = Math.round((Date.now() - start) / 1000);
    const suffix = ` (${elapsed}s)`;
    s.message(`${fitToWidth(label, suffix)}${k.dim(suffix)}`);
  }, 1000);

  const result = await pingCliAgent();

  clearInterval(tick);
  const elapsed = Math.round((Date.now() - start) / 1000);
  const suffix = ` (${elapsed}s)`;
  if (result === 'ok') {
    s.stop(`${k.bold(fitToWidth('Your assistant is ready.', suffix))}${k.dim(suffix)}`);
  } else {
    const msg =
      result === 'socket_error'
        ? "Couldn't reach the ClawBridge service."
        : "Your assistant didn't reply in time.";
    s.stop(`${k.bold(fitToWidth(msg, suffix))}${k.dim(suffix)}`, 1);
  }
  return result;
}

function renderPingFailureNote(result: PingResult): void {
  const body =
    result === 'socket_error'
      ? [
          wrapForGutter(
            "The ClawBridge service isn't listening on its local socket. Try restarting it, then chat with `pnpm run chat hi`:",
            6,
          ),
          '',
          `  macOS:  launchctl kickstart -k gui/$(id -u)/${getLaunchdLabel()}`,
          `  Linux:  systemctl --user restart ${getSystemdUnit()}`,
        ].join('\n')
      : wrapForGutter(
          'No reply from your assistant within 30 seconds. Check `logs/clawbridge.log` for clues, then try `pnpm run chat hi`.',
          6,
        );
  p.note(body, 'Skipping the first chat');
}

/**
 * Chat loop. Each message is piped through `pnpm run chat`, which uses
 * the same Unix-socket path the ping just exercised, so output streams
 * back inline as the agent replies. An empty input ends the loop.
 *
 * The intro note teaches the sandbox mental model — users reported being
 * confused about what the terminal chat *is* (vs the phone channel they'd
 * set up next) and what happens to the agent when they walk away. We
 * explain once, then offer "message or Enter to continue" so the chat is
 * clearly optional.
 */
async function runFirstChat(): Promise<void> {
  p.note(
    wrapForGutter(
      [
        'Your assistant runs in a sandbox on this machine.',
        'It wakes up when you send a message and goes back to sleep when',
        "you're not talking — so it isn't burning resources in the background.",
        'Its memory and environment persist between conversations.',
      ].join(' '),
      6,
    ),
    'How this works',
  );
  let first = true;
  while (true) {
    const answer = ensureAnswer(
      await p.text({
        message: first
          ? 'Try a quick hello — or press Enter to continue setup'
          : 'Another message? Press Enter to continue setup',
        placeholder: first
          ? 'e.g. "hi, what can you do?"'
          : 'press Enter to continue',
      }),
    );
    first = false;
    const text = ((answer as string | undefined) ?? '').trim();
    if (!text) return;
    await sendChatMessage(text);
  }
}

function sendChatMessage(message: string): Promise<void> {
  return new Promise((resolve) => {
    // `pnpm --silent` suppresses the `> clawbridge@… chat` preamble so the
    // agent's reply reads as a clean block under the prompt. Splitting on
    // whitespace mirrors `pnpm run chat hello world` — chat.ts joins argv
    // with spaces on the far side.
    const child = spawn(
      'pnpm',
      ['--silent', 'run', 'chat', ...message.split(/\s+/)],
      { stdio: ['ignore', 'inherit', 'inherit'] },
    );
    child.on('close', () => resolve());
    child.on('error', () => resolve());
  });
}

// ─── auth step (select → branch) ────────────────────────────────────────

async function runAuthStep(): Promise<void> {
  if (codexAuthExists()) {
    p.log.success('Codex is already signed in.');
    setupLog.step('auth', 'skipped', 0, { REASON: 'secret-already-present' });
    return;
  }

  setupLog.userInput('auth_method', 'subscription');
  phEmit('auth_method_chosen', { method: 'subscription' });
  await runSubscriptionAuth();
}

async function runSubscriptionAuth(): Promise<void> {
  p.log.step('Opening the Codex sign-in flow…');
  console.log(
    k.dim('   (a browser will open for device-auth sign-in; this part is interactive)'),
  );
  console.log();
  const start = Date.now();
  const code = await runInheritScript('bash', [
    'setup/register-codex.sh',
  ]);
  const durationMs = Date.now() - start;
  console.log();
  if (code !== 0) {
    setupLog.step('auth', 'failed', durationMs, {
      EXIT_CODE: code,
      METHOD: 'subscription',
    });
    await fail(
      'auth',
      "Couldn't complete the Codex sign-in.",
      'Re-run setup and try again.',
    );
  }
  setupLog.step('auth', 'interactive', durationMs, { METHOD: 'subscription' });
  p.log.success('Codex account connected.');
}


// ─── timezone step ─────────────────────────────────────────────────────

/**
 * Auto-detect TZ, confirm with the user when it comes back as UTC (a
 * common sign we're on a VPS that wasn't localised), and persist through
 * the usual `--step timezone -- --tz <zone>` path. Free-text answers get
 * a headless `codex exec` pass to resolve them to a real IANA zone.
 */
async function runTimezoneStep(): Promise<void> {
  const res = await runQuietStep('timezone', {
    running: 'Checking your timezone…',
    done: 'Timezone set.',
  });
  if (!res.ok && res.terminal?.fields.NEEDS_USER_INPUT !== 'true') {
    await fail('timezone', "Couldn't determine your timezone.");
  }

  const fields = res.terminal?.fields ?? {};
  const resolvedTz = fields.RESOLVED_TZ;
  const needsInput = fields.NEEDS_USER_INPUT === 'true';
  const isUtc =
    resolvedTz === 'UTC' ||
    resolvedTz === 'Etc/UTC' ||
    resolvedTz === 'Universal';

  // Three branches:
  //   - no TZ detected: ask where they are (or leave as UTC)
  //   - detected UTC: confirm (likely VPS, but worth checking)
  //   - detected specific zone: confirm explicitly rather than silently
  //     persisting — users shouldn't be surprised the agent "already knew"
  //     their timezone from system settings they didn't think about.
  if (!needsInput && !isUtc && resolvedTz && resolvedTz !== 'none') {
    const confirmed = ensureAnswer(
      await p.confirm({
        message: `I detected ${resolvedTz} from your computer settings. Is that right?`,
        initialValue: true,
      }),
    );
    setupLog.userInput('timezone_confirm_detected', String(confirmed));
    if (confirmed) return;
  }

  const message = needsInput
    ? "Your system didn't expose a timezone. Which one are you in?"
    : !isUtc
      ? "Where are you, then?"
      : "Your system reports UTC as the timezone. Is that right, or are you somewhere else?";

  // For the non-UTC "detected-but-wrong" branch we skip the select and jump
  // straight to the free-text prompt — the user already said "not that".
  let choice: 'keep' | 'answer' = 'answer';
  if (needsInput || isUtc) {
    choice = ensureAnswer(
      await brightSelect({
        message,
        options: needsInput
          ? [
              { value: 'answer', label: "I'll tell you where I am" },
              { value: 'keep', label: 'Leave it as UTC' },
            ]
          : [
              { value: 'keep', label: 'Keep UTC', hint: 'remote server / happy with UTC' },
              { value: 'answer', label: "I'm somewhere else" },
            ],
      }),
    ) as 'keep' | 'answer';
    setupLog.userInput('timezone_choice', choice);
  }

  if (choice === 'keep') return;

  const answer = ensureAnswer(
    await p.text({
      message: "Where are you? (city, region, or IANA zone)",
      placeholder: 'e.g. New York, London, Asia/Tokyo',
      validate: (v) => (v && v.trim() ? undefined : 'Required'),
    }),
  );
  const raw = (answer as string).trim();
  setupLog.userInput('timezone_input', raw);

  let tz: string | null = isValidTimezone(raw) ? raw : null;
  if (!tz) {
    p.log.warn(
      wrapForGutter(
        "That's not a standard IANA zone — try again with a zone like `America/New_York` or `Europe/London`.",
        4,
      ),
    );
  }

  if (!tz) {
    // One retry with a direct-IANA ask; if that fails too, leave the
    // previously-detected value in .env and move on rather than looping.
    const retryAnswer = ensureAnswer(
      await p.text({
        message: 'Enter an IANA timezone string',
        placeholder: 'e.g. America/New_York',
        validate: (v) => {
          const s = (v ?? '').trim();
          if (!s) return 'Required';
          if (!isValidTimezone(s)) return 'Not a valid IANA zone';
          return undefined;
        },
      }),
    );
    tz = (retryAnswer as string).trim();
    setupLog.userInput('timezone_retry', tz);
  }

  const persist = await runQuietStep(
    'timezone',
    {
      running: `Saving timezone ${tz}…`,
      done: `Timezone set to ${tz}.`,
    },
    ['--tz', tz],
  );
  if (!persist.ok) {
    await fail('timezone', `Couldn't save timezone ${tz}.`);
  }
}

// ─── prompts owned by the sequencer ────────────────────────────────────

async function askDisplayName(fallback: string): Promise<string> {
  const answer = ensureAnswer(
    await p.text({
      message: 'What should your assistant call you?',
      placeholder: fallback,
      defaultValue: fallback,
    }),
  );
  const value = (answer as string).trim() || fallback;
  setupLog.userInput('display_name', value);
  return value;
}

async function askChannelChoice(): Promise<ChannelChoice> {
  const isMac = process.platform === 'darwin';
  const choice = ensureAnswer(
    await brightSelect<ChannelChoice>({
      message: 'Want to chat with your assistant from your phone?',
      options: [
        { value: 'telegram', label: 'Yes, connect Telegram', hint: 'recommended' },
        { value: 'discord', label: 'Yes, connect Discord' },
        { value: 'whatsapp', label: 'Yes, connect WhatsApp' },
        {
          value: 'signal',
          label: 'Yes, connect Signal',
          hint: 'needs signal-cli installed',
        },
        {
          value: 'imessage',
          label: 'Yes, connect iMessage (experimental)',
          hint: isMac ? 'local macOS mode' : 'remote Photon only',
        },
        {
          value: 'slack',
          label: 'Yes, connect Slack (experimental)',
          hint: 'needs public URL',
        },
        { value: 'teams', label: 'Yes, connect Microsoft Teams', hint: 'complex setup' },
        { value: 'skip', label: 'Skip for now', hint: "I'll just use the terminal" },
      ],
    }),
  );
  setupLog.userInput('channel_choice', String(choice));
  phEmit('channel_chosen', { channel: String(choice) });
  return choice;
}

// ─── interactive / env helpers ─────────────────────────────────────────

function codexAuthExists(): boolean {
  try {
    const authFile = path.join(os.homedir(), '.codex', 'auth.json');
    return fs.existsSync(authFile);
  } catch {
    return false;
  }
}

function runInheritScript(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'inherit' });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

/**
 * After installing Docker, this process's supplementary groups are still
 * frozen from login — subsequent steps that talk to /var/run/docker.sock
 * (service start, …) fail with EACCES even though the
 * daemon is up. Detect that and re-exec the whole driver under `sg docker`
 * so the rest of the run inherits the docker group without a re-login.
 */
function maybeReexecUnderSg(): void {
  if (process.env.CLAWBRIDGE_REEXEC_SG === '1') return;
  if (process.platform !== 'linux') return;
  const info = spawnSync('docker', ['info'], { encoding: 'utf-8' });
  if (info.status === 0) return;
  const err = `${info.stderr ?? ''}\n${info.stdout ?? ''}`;
  if (!/permission denied/i.test(err)) return;
  if (spawnSync('which', ['sg'], { stdio: 'ignore' }).status !== 0) return;

  p.log.warn('Docker socket not accessible in current group. Re-executing under `sg docker`.');
  const res = spawnSync('sg', ['docker', '-c', 'pnpm run setup:auto'], {
    stdio: 'inherit',
    env: { ...process.env, CLAWBRIDGE_REEXEC_SG: '1' },
  });
  process.exit(res.status ?? 1);
}

// ─── intro + progression-log init ──────────────────────────────────────

function printIntro(): void {
  const isReexec = process.env.CLAWBRIDGE_REEXEC_SG === '1';
  const wordmark = `${k.bold('Claw')}${brandBold('Bridge')}`;

  if (isReexec) {
    p.intro(
      `${brandChip(' Welcome ')}  ${wordmark}  ${k.dim('· picking up where we left off')}`,
    );
    return;
  }

  // Always include the wordmark inside the clack intro line. When bash ran
  // first (CLAWBRIDGE_BOOTSTRAPPED=1) it already printed its own wordmark
  // above us; the small repeat is worth it to keep the brand anchored at
  // the visible top of the clack session once the bash output scrolls away.
  p.intro(`${wordmark}  ${k.dim("Let's get you set up.")}`);

}

/**
 * Bootstrap (clawbridge.sh) normally initializes logs/setup.log and writes
 * the bootstrap entry before we even boot. If someone runs `pnpm run
 * setup:auto` directly, start a fresh progression log here so we don't
 * append to a stale one from a previous run.
 */
function initProgressionLog(): void {
  if (process.env.CLAWBRIDGE_BOOTSTRAPPED === '1') return;
  let commit = '';
  try {
    commit = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
      encoding: 'utf-8',
    }).stdout.trim();
  } catch {
    // git not available or not a repo — skip
  }
  let branch = '';
  try {
    branch = spawnSync('git', ['branch', '--show-current'], {
      encoding: 'utf-8',
    }).stdout.trim();
  } catch {
    // skip
  }
  setupLog.reset({
    invocation: 'setup:auto (standalone)',
    user: process.env.USER ?? 'unknown',
    cwd: process.cwd(),
    branch: branch || 'unknown',
    commit: commit || 'unknown',
  });
}

main().catch((err) => {
  p.log.error(err instanceof Error ? err.message : String(err));
  p.cancel('Setup aborted.');
  process.exit(1);
});
