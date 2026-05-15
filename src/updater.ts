#!/usr/bin/env node
import { spawnSync, execSync } from 'child_process';
import { readFileSync } from 'fs';
import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';

const PACKAGE_NAME = 'clawbridge-codex';
const CLI_NAME = 'clawbridge-codex';
const REGISTRY_LATEST_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;

export async function checkForUpdate(): Promise<void> {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    const currentVersion = pkg.version;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(REGISTRY_LATEST_URL, {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) return;
    const data = (await res.json()) as { version: string };
    const latestVersion = data.version;

    if (latestVersion !== currentVersion) {
      console.log(`\n⚡ ClawBridge update available: ${currentVersion} → ${latestVersion}`);
      console.log(`   Run: clawbridge-codex upgrade\n`);
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
    const newComposeSrc = path.join(globalRoot, PACKAGE_NAME, 'integrations', 'docker-compose.yml');
    if (!fs.existsSync(newComposeSrc)) {
      console.log(`  ⚠  ${newComposeSrc} not found — skipping symlink update.`);
      return;
    }
    const destCompose = path.join(os.homedir(), '.clawbridge', 'docker-compose.yml');
    try {
      fs.unlinkSync(destCompose);
    } catch {
      /* not present */
    }
    fs.symlinkSync(newComposeSrc, destCompose);
    console.log(`  ✓ docker-compose.yml → ${newComposeSrc}`);
  } catch (err) {
    console.log(`  ⚠  docker-compose symlink update failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function rebuildContainerImage(): boolean {
  try {
    const npmRootResult = spawnSync('npm', ['root', '-g'], { encoding: 'utf-8', timeout: 10000 });
    if (npmRootResult.status !== 0) {
      console.log('  ⚠  Could not determine npm global root — skipping container rebuild.');
      return false;
    }
    const globalRoot = npmRootResult.stdout.trim();
    const buildScript = path.join(globalRoot, PACKAGE_NAME, 'container', 'build.sh');
    if (!fs.existsSync(buildScript)) {
      console.log(`  ⚠  build.sh not found at ${buildScript} — skipping container rebuild.`);
      return false;
    }

    console.log(`  Building container image\u2026`);
    const buildArgs: string[] = [];

    const result = spawnSync('bash', [buildScript, ...buildArgs], {
      stdio: 'inherit',
      encoding: 'utf-8',
      timeout: 5 * 60 * 1000, // 5 minutes
    });
    if (result.status !== 0) {
      console.log('  \u26a0  Container image build failed. Run manually: clawbridge-codex build-image');
      return false;
    }
    return true;
  } catch (err) {
    console.log(`  \u26a0  Container rebuild error: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

function detectLaunchdLabel(): string | null {
  try {
    const launchAgentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
    const plists = fs
      .readdirSync(launchAgentsDir)
      .filter((f) => f.startsWith('com.clawbridge-v2-') && f.endsWith('.plist'));
    if (plists.length === 0) return null;
    return plists[0].replace(/\.plist$/, '');
  } catch {
    return null;
  }
}

function restartSystemdService(unit: string, scope: string[]): void {
  try {
    const result = spawnSync('systemctl', [...scope, 'start', unit], { encoding: 'utf-8', timeout: 15000 });
    if (result.status === 0) {
      console.log(`  ✓ Service restarted: ${unit}`);
    } else {
      const scopeStr = scope.length > 0 ? scope.join(' ') + ' ' : '';
      console.log(`  ⚠  systemctl start failed: ${result.stderr?.trim()}`);
      console.log(`     Try manually: systemctl ${scopeStr}start ${unit}`);
    }
  } catch (err) {
    console.log(`  ⚠  Could not restart service: ${err instanceof Error ? err.message : String(err)}`);
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
  console.log('🔄 Upgrading ClawBridge Codex…\n');

  // Check current version
  let pkg: { version: string };
  try {
    pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  } catch {
    console.log('Could not read package.json. Installation may be corrupted.');
    process.exit(1);
  }
  const currentVersion = pkg.version;
  console.log(`Current version: ${currentVersion}`);

  // Check latest on npm
  let latestVersion: string;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(REGISTRY_LATEST_URL, { signal: controller.signal });
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

  // Stop the running service before installing to avoid ENOTEMPTY on Linux
  // (npm can't rename the package dir while the process has open file handles)
  const serviceLabel = detectLaunchdLabel();
  let serviceStopped = false;
  let systemdUnit: string | null = null;
  let systemdScope: string[] = [];

  if (process.platform === 'darwin' && serviceLabel) {
    console.log('\nStopping ClawBridge service before upgrade…');
    try {
      const uid = execSync('id -u', { encoding: 'utf-8' }).trim();
      spawnSync('launchctl', ['kill', 'TERM', `gui/${uid}/${serviceLabel}`], { encoding: 'utf-8', timeout: 10000 });
      serviceStopped = true;
      console.log('  ✓ Service stopped');
    } catch {
      /* proceed anyway */
    }
  } else if (process.platform === 'linux') {
    console.log('\nStopping ClawBridge service before upgrade…');
    // Try systemd user service
    const unitDirs = [path.join(os.homedir(), '.config', 'systemd', 'user'), '/etc/systemd/system'];
    for (const dir of unitDirs) {
      try {
        const files = fs.readdirSync(dir).filter((f) => f.startsWith('clawbridge-v2-') && f.endsWith('.service'));
        if (files.length > 0) {
          const unit = files[0];
          const scope = dir.includes(os.homedir()) ? ['--user'] : [];
          spawnSync('systemctl', [...scope, 'stop', unit], { encoding: 'utf-8', timeout: 10000 });
          serviceStopped = true;
          systemdUnit = unit;
          systemdScope = scope;
          console.log(`  ✓ Service stopped: ${unit}`);
          break;
        }
      } catch {
        /* dir may not exist */
      }
    }
    if (!serviceStopped) {
      console.log('  ℹ No systemd service found — proceeding without stopping');
    }
  }

  // Linux ENOTEMPTY workaround: npm arborist reuses the same temp name as both
  // the new-version staging dir and the old-version backup — pre-removing the
  // existing install dir avoids the rename collision entirely.
  // Safe because Node has already loaded the module into memory before files are removed.
  if (process.platform === 'linux') {
    const npmRootForClean = spawnSync('npm', ['root', '-g'], { encoding: 'utf-8', timeout: 10000 });
    if (npmRootForClean.status === 0) {
      const globalRoot = npmRootForClean.stdout.trim();
      try {
        fs.rmSync(path.join(globalRoot, PACKAGE_NAME), { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      try {
        for (const entry of fs.readdirSync(globalRoot)) {
          if (entry.startsWith(`.${PACKAGE_NAME}-`)) {
            fs.rmSync(path.join(globalRoot, entry), { recursive: true, force: true });
          }
        }
      } catch {
        /* ignore */
      }
    }
  }

  // Clean npm cache to avoid stale tarballs (helps with ENOTEMPTY on both platforms)
  console.log('\nCleaning npm cache…');
  spawnSync('npm', ['cache', 'clean', '--force'], { stdio: 'inherit', encoding: 'utf-8' });

  // Install
  console.log('\nInstalling…');
  const installResult = spawnSync('npm', ['install', '-g', `${PACKAGE_NAME}@latest`], {
    stdio: 'inherit',
    encoding: 'utf-8',
  });

  if (installResult.status !== 0) {
    // If stopped, try to restart before exiting
    if (serviceStopped) {
      if (serviceLabel && process.platform === 'darwin') {
        try {
          const uid = execSync('id -u', { encoding: 'utf-8' }).trim();
          spawnSync('launchctl', ['kickstart', `gui/${uid}/${serviceLabel}`], { encoding: 'utf-8', timeout: 10000 });
        } catch {
          /* best effort */
        }
      } else if (systemdUnit && process.platform === 'linux') {
        restartSystemdService(systemdUnit, systemdScope);
      }
    }
    console.error('\n✗ Upgrade failed. Try manually: npm install -g clawbridge-codex@latest');
    process.exit(1);
  }

  // Post-install: reconcile docker-compose symlink
  console.log('\nReconciling docker-compose symlink…');
  reconcileDockerComposeSymlink();

  // Rebuild container image
  console.log('\nRebuilding agent container image (this takes ~2 min)…');
  const rebuilt = rebuildContainerImage();
  if (rebuilt) {
    console.log('  ✓ Container image rebuilt successfully');
  }

  // Restart service
  console.log('\nRestarting ClawBridge service…');
  if (process.platform === 'darwin') {
    const label = detectLaunchdLabel();
    if (label) {
      restartLaunchdService(label);
    } else {
      console.log('  ⚠  No launchd service found — restart manually if needed.');
    }
  } else if (process.platform === 'linux') {
    if (systemdUnit) {
      restartSystemdService(systemdUnit, systemdScope);
    } else {
      console.log('  ⚠  No systemd service found — restart manually if needed.');
    }
  }

  // Health check
  console.log('\nRunning health check…');
  try {
    const { runDoctor } = await import('./doctor.js');
    await runDoctor();
  } catch {
    console.log('  ⚠  Could not run health check — run `clawbridge-codex doctor` manually.');
  }

  console.log(`\n✓ ClawBridge upgraded: ${currentVersion} → ${latestVersion}`);
  console.log('  Your data and memories are untouched.');
}

/** Backward-compat alias */
export const runUpdate = runUpgrade;
