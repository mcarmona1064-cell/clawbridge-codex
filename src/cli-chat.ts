#!/usr/bin/env node
import readline from 'readline';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

import { readEnvFile } from './env.js';

// Load env vars into process.env for this CLI session
const envVars = readEnvFile(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ASSISTANT_NAME']);
for (const [key, value] of Object.entries(envVars)) {
  process.env[key] = value;
}

const apiKey = process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY;
const agentName = process.env.ASSISTANT_NAME || 'ClawBridge';

if (!apiKey) {
  console.error('No Claude OAuth token found. Run clawbridge-agent setup first.');
  process.exit(1);
}

// Conversation history
const messages: Array<{ role: string; content: string }> = [];

// Load CLAUDE.md as system prompt if exists
let systemPrompt = `You are ${agentName}, an AI agent assistant. Be helpful, concise, and friendly.`;
const claudeMdPath = join(homedir(), '.clawbridge', 'CLAUDE.md');
if (existsSync(claudeMdPath)) {
  systemPrompt = readFileSync(claudeMdPath, 'utf8');
}

async function chat(userMessage: string): Promise<string> {
  messages.push({ role: 'user', content: userMessage });

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 8096,
      system: systemPrompt,
      messages,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`API error: ${response.status} ${err}`);
  }

  const data = (await response.json()) as { content: Array<{ text: string }> };
  const assistantMessage = data.content[0].text;
  messages.push({ role: 'assistant', content: assistantMessage });
  return assistantMessage;
}

export async function main(): Promise<void> {
  const nameLabel = agentName.padEnd(28).slice(0, 28);
  console.log(`\n  ╭──────────────────────────────────╮`);
  console.log(`  │  ${nameLabel} — Chat  │`);
  console.log(`  │  Type /exit or Ctrl+C to quit      │`);
  console.log(`  ╰──────────────────────────────────╯\n`);

  process.stdin.resume();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise<void>((resolve) => {
    rl.on('close', () => {
      console.log('\nGoodbye!');
      resolve();
    });

    const prompt = (): void => {
      rl.question('\x1b[36mYou:\x1b[0m ', (input) => {
        const trimmed = input.trim();

        if (!trimmed) {
          prompt();
          return;
        }

        if (trimmed === '/exit' || trimmed === '/quit') {
          rl.close();
          return;
        }

        if (trimmed === '/clear') {
          messages.length = 0;
          console.log('\x1b[90m[Conversation cleared]\x1b[0m\n');
          prompt();
          return;
        }

        chat(trimmed)
          .then((reply) => {
            console.log(`\n\x1b[33m${agentName}:\x1b[0m ${reply}\n`);
            prompt();
          })
          .catch((err: Error) => {
            console.error(`\x1b[31mError: ${err.message}\x1b[0m\n`);
            prompt();
          });
      });
    };

    prompt();
  });
}
