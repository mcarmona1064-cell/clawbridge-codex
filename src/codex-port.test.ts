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
  it('keeps runtime LLM calls routed through configured runtime providers or Codex CLI OAuth', () => {
    const codexSubscriptionFiles = [
      'src/error-handler.ts',
      'src/memory/extractor.ts',
      'src/memory/reflection-agent.ts',
      'src/memory/cross-client.ts',
    ];

    for (const rel of codexSubscriptionFiles) {
      const content = read(rel);
      expect(content, rel).toContain('runCodexPrompt');
      expect(content, rel).not.toMatch(
        /OPENAI_API_KEY|api\.openai\.com\/v1\/chat\/completions|Authorization:\s*`Bearer/,
      );
    }

    const codexCli = read('src/codex-cli.ts');
    expect(codexCli).toMatch(/execFile\(\s*'codex'/);
    expect(codexCli).toContain("'--sandbox', sandbox");
    expect(codexCli).toContain("sandbox = 'read-only'");
  });

  it('setup auth requires Codex subscription OAuth and does not accept/create API-key runtime auth', () => {
    const auth = read('setup/auth.ts');

    expect(auth).toMatch(/\.codex['"],\s*['"]auth\.json/);
    expect(auth).toContain('codex login --device-auth');
    expect(auth).not.toMatch(/OPENAI_API_KEY/);
    expect(auth).not.toMatch(/OPENAI_OK/);
    expect(auth).not.toMatch(/hasApiKey/);
    expect(auth).not.toMatch(/writeEnvKey/);
    expect(auth).not.toMatch(/CREATED:\s*true/);

    for (const rel of ['src/doctor.ts', 'setup/register.ts', 'setup/probe.sh', 'src/setup/index.ts']) {
      const content = read(rel);
      expect(content, rel).not.toMatch(/ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|claude setup-token|sk-ant/);
    }

    expect(read('src/doctor.ts')).toContain('~/.codex/auth.json');
    expect(read('setup/register.ts')).toContain('AGENTS.local.md');
  });

  it('quick-start hands off to durable interactive setup, not setup:auto', () => {
    const quickStart = read('clawbridge.sh');
    expect(quickStart).not.toMatch(/pnpm\s+(?:--silent\s+)?run\s+setup:auto\b/);
    expect(quickStart).toMatch(/exec\s+pnpm\s+(?:--silent\s+)?run\s+setup:wizard\b/);
    expect(quickStart).toContain('$HOME/.local/share/clawbridge-codex/source');
  });

  it('keeps active command hints on clawbridge-codex names', () => {
    const activeHintFiles = [
      'src/doctor.ts',
      'src/container-runner.ts',
      'src/updater.ts',
      'src/setup/index.ts',
      'setup/index.ts',
      'setup/service.ts',
      'setup/verify.ts',
      'clawbridge.sh',
    ];

    const forbiddenHint =
      /(?:run:\s*|Run:\s*|retry:\s*|reinstall:\s*|npm install -g\s+)(?:npx\s+)?(?:clawbridge-agent(?:@latest)?|clawbridge\b(?!-codex))/;

    for (const rel of activeHintFiles) {
      const content = read(rel);
      expect(content, rel).not.toMatch(forbiddenHint);
    }
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
      /api\.anthropic\.com|ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|sk-ant|claude-opus|claude-haiku|Claude Code SDK|CLAUDE_CODE_/;

    const offenders = scannedRoots
      .flatMap((root) => walk(root))
      .filter((file) => /\.(ts|tsx|js|sh|md|ya?ml)$/.test(file))
      .filter((file) => !allowedLegacyFiles.has(file))
      .filter((file) => forbidden.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(ROOT, file));

    expect(offenders).toEqual([]);
  });

  it('setup service registration detects macOS, Linux systemd, root systemd, and nohup fallback', () => {
    const setupWizard = read('src/setup/index.ts');
    expect(setupWizard).toContain("process.platform === 'darwin'");
    expect(setupWizard).toContain("process.platform === 'linux' && hasSystemd()");
    expect(setupWizard).toContain('process.getuid?.() === 0');
    expect(setupWizard).toContain("'/etc/systemd/system'");
    expect(setupWizard).toContain('systemctl --user');
    expect(setupWizard).toContain('registerNohup');
    expect(setupWizard).toContain('nohup');
  });

  it('migration only treats ~/.clawbridge as legacy clawbridge-agent when provider is non-codex', () => {
    const migrate = read('src/setup/migrate.ts');
    expect(migrate).toContain("provider && provider !== 'codex'");
    expect(migrate).toContain("if (type === 'clawbridge') continue");
  });

  it('keeps container active runtime free of Anthropic/Claude runtime artifacts', () => {
    const activeContainerFiles = [
      ...walk(path.join(ROOT, 'container', 'agent-runner', 'src')),
      path.join(ROOT, 'container', 'agent-runner', 'package.json'),
      path.join(ROOT, 'container', 'Dockerfile'),
    ].filter((file) => fs.existsSync(file));

    const forbidden =
      /@anthropic-ai|api\.anthropic\.com|ANTHROPIC_[A-Z0-9_]*|CLAUDE_CODE_[A-Z0-9_]*|Claude Code|claude-code/i;
    const offenders = activeContainerFiles
      .filter((file) => /\.(ts|tsx|js|json|md)$/.test(file) || path.basename(file) === 'Dockerfile')
      .filter((file) => forbidden.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(ROOT, file));

    expect(offenders).toEqual([]);
  });

  it('keeps upgrade/update pointed at the codex package', () => {
    const updater = read('src/updater.ts');
    expect(updater).toContain("PACKAGE_NAME = 'clawbridge-codex'");
    expect(updater).toContain("CLI_NAME = 'clawbridge-codex'");
    expect(updater).not.toMatch(/clawbridge-agent\/latest|clawbridge-agent@latest|globalRoot, 'clawbridge-agent'/);
  });
});
