import { execFile } from 'child_process';

export interface CodexPromptOptions {
  sandbox?: 'read-only' | 'workspace-write';
  timeout?: number;
  cwd?: string;
  maxBuffer?: number;
}

export async function runCodexPrompt(
  prompt: string,
  { sandbox = 'read-only', timeout = 120_000, cwd = process.cwd(), maxBuffer = 1024 * 1024 }: CodexPromptOptions = {},
): Promise<string> {
  const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFile(
      'codex',
      ['exec', '--sandbox', sandbox, '--skip-git-repo-check', prompt],
      {
        timeout,
        cwd,
        maxBuffer,
      },
      (execErr, stdout, stderr) => {
        if (execErr) {
          const err = execErr as Error & { stderr?: string };
          err.stderr = String(stderr || '');
          reject(err);
          return;
        }
        resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
      },
    );
  });

  return result.stdout.trim() || result.stderr.trim();
}
