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
  const token = env.CLAUDE_CODE_OAUTH_TOKEN || process.env.CLAUDE_CODE_OAUTH_TOKEN;

  if (!token) {
    console.error('No Claude OAuth token found. Run clawbridge-agent setup first.');
    process.exit(1);
  }

  // Check if claude is installed
  let claudePath = '';
  try {
    claudePath = execSync('which claude', { encoding: 'utf8' }).trim();
  } catch {
    // not found
  }

  if (!claudePath) {
    console.log('Claude Code is not installed.');
    console.log('Install it with: npm install -g @anthropic-ai/claude-code\n');
    process.exit(1);
  }

  const agentName = env.ASSISTANT_NAME || process.env.ASSISTANT_NAME || 'ClawBridge';

  // Load system prompt from ~/.clawbridge/CLAUDE.md, falling back to built-in default
  const claudeMdPath = join(homedir(), '.clawbridge', 'CLAUDE.md');
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

- \`clawbridge setup\` — initial setup wizard
- \`clawbridge doctor\` — health check (add --fix to auto-repair channel issues)
- \`clawbridge upgrade\` — update to latest version + rebuild container
- \`clawbridge chat\` — this CLI chat session

Customize your persona by editing ~/.clawbridge/CLAUDE.md`;

  const systemPrompt = existsSync(claudeMdPath) ? readFileSync(claudeMdPath, 'utf8') : DEFAULT_SYSTEM_PROMPT;

  // Build args: inject --name and optionally --system-prompt before user args
  const extraArgs = process.argv.slice(3);
  const claudeArgs: string[] = ['--name', agentName];
  if (systemPrompt) {
    claudeArgs.push('--system-prompt', systemPrompt);
  }
  claudeArgs.push(...extraArgs);

  printSplash(agentName);
  console.log(`Starting Claude Code...\n`);

  // Launch claude with ClawBridge's token
  const result = spawnSync(claudePath, claudeArgs, {
    stdio: 'inherit',
    env: {
      ...process.env,
      CLAUDE_CODE_OAUTH_TOKEN: token,
    },
  });

  process.exit(result.status ?? 0);
}
