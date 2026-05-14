import fs from 'fs';
import os from 'os';
import path from 'path';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { getMemories } from './db.js';

// ── Auth ─────────────────────────────────────────────────────────────────────

const envCfg = readEnvFile(['OPENAI_API_KEY']);

function getApiKey(): string | null {
  return process.env['OPENAI_API_KEY'] || envCfg['OPENAI_API_KEY'] || null;
}

// ── Keyword overlap helper ────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'have',
  'they',
  'will',
  'uses',
  'their',
  'been',
  'also',
  'into',
  'about',
  'client',
  'user',
  'agent',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOP_WORDS.has(w));
}

// ── Cross-client pattern detection ───────────────────────────────────────────

interface Theme {
  keyword: string;
  count: number;
  examples: string[];
}

function findCommonThemes(allMemoryContents: string[], minClients: number): Theme[] {
  const keywordToClients = new Map<string, Set<number>>();
  const keywordToExamples = new Map<string, string[]>();

  allMemoryContents.forEach((content, idx) => {
    const tokens = tokenize(content);
    for (const token of tokens) {
      if (!keywordToClients.has(token)) {
        keywordToClients.set(token, new Set());
        keywordToExamples.set(token, []);
      }
      keywordToClients.get(token)!.add(idx);
      const examples = keywordToExamples.get(token)!;
      if (examples.length < 3 && !examples.includes(content)) {
        examples.push(content);
      }
    }
  });

  const themes: Theme[] = [];
  for (const [keyword, clients] of keywordToClients) {
    if (clients.size >= minClients) {
      themes.push({
        keyword,
        count: clients.size,
        examples: keywordToExamples.get(keyword) ?? [],
      });
    }
  }

  return themes.sort((a, b) => b.count - a.count).slice(0, 20);
}

// ── Report generation ─────────────────────────────────────────────────────────

/**
 * Analyzes memories across all provided client IDs, finds common patterns,
 * calls OpenAI to generate an agency-level insight report, and saves it.
 *
 * Returns the report as a markdown string.
 */
export async function generateCrossClientReport(clientIds: string[]): Promise<string> {
  if (clientIds.length < 2) {
    log.debug('[memory:cross-client] Not enough clients for pattern analysis', { count: clientIds.length });
    return '';
  }

  const apiKey = getApiKey();
  if (!apiKey) {
    log.warn('[memory:cross-client] No OPENAI_API_KEY — skipping');
    return '';
  }

  // Gather all memory contents per client
  const allContents: string[] = [];
  const perClientContents = new Map<string, string[]>();

  for (const clientId of clientIds) {
    const memories = getMemories(clientId, 0.2);
    const contents = memories.map((m) => m.content);
    perClientContents.set(clientId, contents);
    allContents.push(...contents);
  }

  if (allContents.length < 10) {
    log.debug('[memory:cross-client] Not enough total memories for report', { total: allContents.length });
    return '';
  }

  const minClients = Math.max(2, Math.floor(clientIds.length * 0.3));
  const themes = findCommonThemes(allContents, minClients);

  if (themes.length === 0) {
    log.debug('[memory:cross-client] No common themes found across clients');
    return '';
  }

  const themeSummary = themes
    .map((t) => `- "${t.keyword}" (${t.count} clients): ${t.examples.slice(0, 2).join(' | ')}`)
    .join('\n');

  const systemPrompt = `You are an AI agency analyst. Analyze patterns across multiple AI agent clients and generate actionable insights for the agency owner.

Focus on:
- Features or capabilities clients repeatedly ask about (opportunities to build)
- Common pain points or frustrations
- Patterns in how clients use the agent
- Proactive suggestions the agency can act on

Format as markdown with bullet points. Max 300 words. Be specific and actionable.`;

  const userPrompt = `Agency has ${clientIds.length} active clients. Common themes found across clients:\n\n${themeSummary}\n\nGenerate a weekly agency insight report.`;

  let report: string;
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 600,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
    });

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      error?: { message: string };
    };

    if (data.error) {
      log.error('[memory:cross-client] OpenAI API error', { error: data.error.message });
      return '';
    }

    report = data.choices?.[0]?.message?.content ?? '';
  } catch (err) {
    log.error('[memory:cross-client] Report generation failed', { err });
    return '';
  }

  if (!report) return '';

  // Save report to disk
  const reportsDir = path.join(os.homedir(), '.clawbridge', 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const reportPath = path.join(reportsDir, `weekly-${date}.md`);
  const fullReport = `# Weekly Cross-Client Insight Report\n_Generated: ${new Date().toISOString()}_\n_Clients analyzed: ${clientIds.length}_\n\n${report}`;
  fs.writeFileSync(reportPath, fullReport, 'utf-8');

  log.info('[memory:cross-client] Weekly report saved', { path: reportPath, clients: clientIds.length });
  return fullReport;
}
