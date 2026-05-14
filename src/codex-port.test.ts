import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(process.cwd());

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else files.push(full);
  }
  return files;
}

describe('Codex port regression checks', () => {
  it('keeps runtime LLM calls on OpenAI-compatible endpoints', () => {
    const runtimeFiles = [
      'src/memory/extractor.ts',
      'src/memory/reflection-agent.ts',
      'src/memory/cross-client.ts',
      'src/error-handler.ts',
    ];

    for (const rel of runtimeFiles) {
      const content = read(rel);
      expect(content, rel).toContain('api.openai.com/v1/chat/completions');
      expect(content, rel).not.toMatch(
        /api\.anthropic\.com|claude-(?:opus|haiku|sonnet)|ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN/,
      );
    }
  });

  it('uses Codex/OpenAI auth keys in setup and doctor code', () => {
    for (const rel of ['setup/auth.ts', 'src/doctor.ts', 'setup/register.ts', 'setup/probe.sh']) {
      const content = read(rel);
      expect(content, rel).not.toMatch(/ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|claude setup-token/);
    }

    expect(read('setup/auth.ts')).toContain('OPENAI_API_KEY');
    expect(read('src/doctor.ts')).toContain("'OPENAI_API_KEY'");
    expect(read('setup/register.ts')).toContain('AGENTS.local.md');
  });

  it('writes and mounts AGENTS.md instead of Claude Code persona files', () => {
    expect(read('src/group-init.ts')).toContain('AGENTS.local.md');
    expect(read('src/group-init.ts')).not.toMatch(/CLAUDE_CODE_|settings\.json/);

    const runner = read('src/container-runner.ts');
    expect(runner).toContain('/workspace/agent/AGENTS.md');
    expect(runner).not.toContain('/workspace/agent/CLAUDE.md');
  });

  it('does not keep tracked backup files with stale Claude-era auth logic', () => {
    expect(fs.existsSync(path.join(ROOT, 'src/doctor.ts.bak'))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, 'src/env.ts.bak'))).toBe(false);
  });

  it('keeps active source/setup/integration code free of direct Anthropic credentials', () => {
    const scannedRoots = ['src', 'setup', 'integrations', 'container/agent-runner/src'].map((rel) =>
      path.join(ROOT, rel),
    );
    const allowedLegacyFiles = new Set([
      path.join(ROOT, 'src/setup/migrate.ts'), // migration must detect legacy Claude env/files to import old installs
      path.join(ROOT, 'src/agents-md-compose.ts'), // migration comments/paths rename CLAUDE.md -> AGENTS.local.md
      path.join(ROOT, 'src/codex-port.test.ts'), // this test contains the forbidden strings as regex fixtures
    ]);
    const forbidden =
      /api\.anthropic\.com|ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|claude-opus|claude-haiku|Claude Code SDK|CLAUDE_CODE_/;

    const offenders = scannedRoots
      .flatMap((root) => walk(root))
      .filter((file) => /\.(ts|tsx|js|sh|md|ya?ml)$/.test(file))
      .filter((file) => !allowedLegacyFiles.has(file))
      .filter((file) => forbidden.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(ROOT, file));

    expect(offenders).toEqual([]);
  });
});
