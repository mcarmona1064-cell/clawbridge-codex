#!/usr/bin/env node
import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

export async function checkForUpdate(): Promise<void> {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const currentVersion = pkg.version;

    // Fetch latest version from npm registry (5s timeout)
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(`https://registry.npmjs.org/clawbridge-agent/latest`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) return;
    const data = (await res.json()) as { version: string };
    const latestVersion = data.version;

    if (latestVersion !== currentVersion) {
      console.log(`\n⚡ ClawBridge update available: ${currentVersion} → ${latestVersion}`);
      console.log(`   Run: npm install -g clawbridge-agent@latest\n`);
    }
  } catch {
    // Silently ignore — no network, npm down, etc.
  }
}

export async function runUpdate(): Promise<void> {
  console.log('🔄 Updating ClawBridge Agent...\n');

  // Check current version
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  console.log(`Current version: ${pkg.version}`);

  // Check latest on npm
  try {
    const res = await fetch('https://registry.npmjs.org/clawbridge-agent/latest');
    const data = (await res.json()) as { version: string };
    console.log(`Latest version:  ${data.version}`);

    if (data.version === pkg.version) {
      console.log('\n✓ Already up to date!');
      process.exit(0);
    }
  } catch {
    console.log('Could not reach npm registry. Check your internet connection.');
    process.exit(1);
  }

  console.log('\nInstalling update...');
  const result = spawnSync('npm', ['install', '-g', 'clawbridge-agent@latest'], {
    stdio: 'inherit',
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    console.error('\n✗ Update failed. Try manually: npm install -g clawbridge-agent@latest');
    process.exit(1);
  }

  console.log('\n✓ ClawBridge updated successfully!');
  console.log('  Your data and memories are untouched.');
  console.log('  Restart ClawBridge to use the new version.');
  process.exit(0);
}
