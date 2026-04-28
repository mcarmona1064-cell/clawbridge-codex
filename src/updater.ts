#!/usr/bin/env node
import { spawnSync, execSync } from 'child_process';
import { readFileSync } from 'fs';
import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';

export async function checkForUpdate(): Promise<void> {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    const currentVersion = pkg.version;

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
      console.log(`   Run: clawbridge upgrade\n`);
    }
  } catch {
    // Silently ignore — no network, npm down, etc.
  }
}

async function askQuestion(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function reconcileDockerComposeSymlink(): void {
  try {
    // Find the globally installed package root via `npm root -g`
    const npmRootResult = spawnSync('npm', ['root', '-g'], { encoding: 'utf-8', timeout: 10000 });
    if (npmRootResult.status !== 0) {
      console.log('  ⚠  Could not determine npm global root — skipping docker-compose symlink update.');
      return;
    }
    const globalRoot = npmRootResult.stdout.trim();
    const newComposeSrc = path.join(globalRoot, 'clawbridge-agent', 'integrations', 'docker-compose.yml');
    if (!fs.existsSync(newComposeSrc)) {
      console.log(`  ⚠  ${newComposeSrc} not found — skipping symlink update.`);
      return;
    }
    const destCompose = path.join(os.homedir(), '.clawbridge', 'docker-compose.yml');
    try { fs.unlinkSync(destCompose); } catch { /* not present */ }
    fs.symlinkSync(newComposeSrc, destCompose);
    console.log(`  ✓ docker-compose.yml → ${newComposeSrc}`);
  } catch (err) {
    console.log(`  ⚠  docker-compose symlink update failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function detectLaunchdLabel(): string | null {
  try {
    const launchAgentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
    const plists = fs.readdirSync(launchAgentsDir)
      .filter((f) => f.startsWith('com.clawbridge-v2-') && f.endsWith('.plist'));
    if (plists.length === 0) return null;
    return plists[0].replace(/\.plist$/, '');
  } catch {
    return null;
  }
}

function restartLaunchdService(label: string): void {
  try {
    const uid = execSync('id -u', { encoding: 'utf-8' }).trim();
    const result = spawnSync('launchctl', ['kickstart', '-k', `gui/${uid}/${label}`], {
      encoding: 'utf-8',
      timeout: 15000,
    });
    if (result.status === 0) {
      console.log(`  ✓ Service restarted: ${label}`);
    } else {
      console.log(`  ⚠  launchctl kickstart failed: ${result.stderr?.trim()}`);
      console.log(`     Try manually: launchctl kickstart -k gui/${uid}/${label}`);
    }
  } catch (err) {
    console.log(`  ⚠  Could not restart service: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function runUpgrade(): Promise<void> {
  console.log('🔄 Upgrading ClawBridge Agent…\n');

  // Check current version
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  const currentVersion = pkg.version;
  console.log(`Current version: ${currentVersion}`);

  // Check latest on npm
  let latestVersion: string;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch('https://registry.npmjs.org/clawbridge-agent/latest', { signal: controller.signal });
    clearTimeout(timeout);
    const data = (await res.json()) as { version: string };
    latestVersion = data.version;
    console.log(`Latest version:  ${latestVersion}`);
  } catch {
    console.log('Could not reach npm registry. Check your internet connection.');
    process.exit(1);
  }

  if (latestVersion === currentVersion) {
    console.log('\n✓ Already up to date!');
    if (process.stdout.isTTY) {
      const answer = await askQuestion('Force-reinstall anyway? [y/N] ');
      if (!answer.toLowerCase().startsWith('y')) {
        console.log('Nothing to do.');
        return;
      }
      console.log('');
    } else {
      return;
    }
  }

  // Install
  console.log('\nInstalling…');
  const installResult = spawnSync('npm', ['install', '-g', 'clawbridge-agent@latest'], {
    stdio: 'inherit',
    encoding: 'utf-8',
  });

  if (installResult.status !== 0) {
    console.error('\n✗ Upgrade failed. Try manually: npm install -g clawbridge-agent@latest');
    process.exit(1);
  }

  // Post-install: reconcile docker-compose symlink
  console.log('\nReconciling docker-compose symlink…');
  reconcileDockerComposeSymlink();

  // Restart launchd service
  const label = detectLaunchdLabel();
  if (label) {
    console.log('\nRestarting ClawBridge service…');
    restartLaunchdService(label);
  } else {
    console.log('\n⚠  No launchd service found — restart manually if needed.');
  }

  console.log(`\n✓ ClawBridge upgraded: ${currentVersion} → ${latestVersion}`);
  console.log('  Your data and memories are untouched.');
}

/** Backward-compat alias */
export const runUpdate = runUpgrade;
