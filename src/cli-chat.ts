#!/usr/bin/env node
import { spawnSync, execSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

function loadEnv(): Record<string, string> {
  const envPath = join(homedir(), '.clawbridge', '.env');
  if (!existsSync(envPath)) return {};
  const env: Record<string, string> = {};
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    env[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return env;
}

function printSplash(agentName: string): void {
  // Cyan color
  const c = '\x1b[36m';
  const reset = '\x1b[0m';

  const logo = `
${c}   ██████╗██╗      █████╗ ██╗    ██╗██████╗ ██████╗ ██╗██████╗  ██████╗ ███████╗${reset}
${c}  ██╔════╝██║     ██╔══██╗██║    ██║██╔══██╗██╔══██╗██║██╔══██╗██╔════╝ ██╔════╝${reset}
${c}  ██║     ██║     ███████║██║ █╗ ██║██████╔╝██████╔╝██║██║  ██║██║  ███╗█████╗  ${reset}
${c}  ██║     ██║     ██╔══██║██║███╗██║██╔══██╗██╔══██╗██║██║  ██║██║   ██║██╔══╝  ${reset}
${c}  ╚██████╗███████╗██║  ██║╚███╔███╔╝██████╔╝██║  ██║██║██████╔╝╚██████╔╝███████╗${reset}
${c}   ╚═════╝╚══════╝╚═╝  ╚═╝ ╚══╝╚══╝ ╚═════╝ ╚═╝  ╚═╝╚═╝╚═════╝  ╚═════╝ ╚══════╝${reset}
`;

  console.log(logo);
  console.log(`${c}              INITIALIZING ${agentName.toUpperCase()} AI...${reset}\n`);

  // Brief pause for effect
  const start = Date.now();
  while (Date.now() - start < 800) {} // 0.8s dramatic pause
}

export async function main(): Promise<void> {
  const env = loadEnv();

  // Codex stores its auth in ~/.codex/auth.json — no .env token needed.
  // Just check the codex CLI is present and signed in.
  let codexPath = '';
  try {
    codexPath = execSync('which codex', { encoding: 'utf8' }).trim();
  } catch {
    // not found
  }

  if (!codexPath) {
    console.log('Codex CLI is not installed.');
    console.log('Install it with: npm install -g @openai/codex\n');
    process.exit(1);
  }

  const agentName = env.ASSISTANT_NAME || process.env.ASSISTANT_NAME || 'ClawBridge';

  // Load system prompt from ~/.clawbridge/AGENTS.md, falling back to built-in default
  const agentsMdPath = join(homedir(), '.clawbridge', 'AGENTS.md');
  const DEFAULT_SYSTEM_PROMPT = `# ClawBridge

You are ${agentName}, a self-hosted AI agent platform built on ClawBridge. You help the user manage their ClawBridge installation, connected messaging channels, agent groups, memory, and settings.

## What you know about ClawBridge

- ClawBridge connects AI agents to messaging channels (Telegram, WhatsApp, Discord, Slack, and more)
- Each agent group runs in its own Docker container with isolated memory and filesystem
- Memory is managed by Hindsight (retain/recall/reflect system)
- The host process routes messages from channels → agent containers → back to channels
- Config lives in ~/.clawbridge/.env
- Agent groups live in ~/.clawbridge/groups/
- The launchd service (com.clawbridge-v2-*) keeps everything running in the background

## CLI commands

- \`clawbridge-codex setup\` — initial setup wizard
- \`clawbridge-codex doctor\` — health check (add --fix to auto-repair channel issues)
- \`clawbridge-codex upgrade\` — update to latest version + rebuild container
- \`clawbridge-codex chat\` — this CLI chat session

Customize your persona by editing ~/.clawbridge/AGENTS.md`;

  const systemPrompt = existsSync(agentsMdPath) ? readFileSync(agentsMdPath, 'utf8') : DEFAULT_SYSTEM_PROMPT;

  // codex exec runs a single prompt; the persistent interactive mode is plain `codex`.
  // We pass the system prompt via -c instructions and pass through any user args.
  const extraArgs = process.argv.slice(3);
  const codexArgs: string[] = ['-c', `instructions=${JSON.stringify(systemPrompt)}`];
  codexArgs.push(...extraArgs);

  printSplash(agentName);
  console.log(`Starting Codex...\n`);

  const result = spawnSync(codexPath, codexArgs, {
    stdio: 'inherit',
    env: { ...process.env },
  });

  process.exit(result.status ?? 0);
}
