/**
 * Container runtime abstraction for ClawBridge.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync } from 'child_process';
import os from 'os';

import { CONTAINER_INSTALL_LABEL } from './config.js';
import { log } from './log.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'docker';

/** CLI args needed for the container to resolve the host gateway. */
export function hostGatewayArgs(): string[] {
  // On Linux, host.docker.internal isn't built-in — add it explicitly
  if (os.platform() === 'linux') {
    return ['--add-host=host.docker.internal:host-gateway'];
  }
  return [];
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(hostPath: string, containerPath: string): string[] {
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

/** Stop a container by name. Uses execFileSync to avoid shell injection. */
export function stopContainer(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
  execSync(`${CONTAINER_RUNTIME_BIN} stop -t 1 ${name}`, { stdio: 'pipe' });
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    log.debug('Container runtime already running');
  } catch (err) {
    log.error('Failed to reach container runtime', { err });
    console.error('\n╔════════════════════════════════════════════════════════════════╗');
    console.error('║  FATAL: Container runtime failed to start                      ║');
    console.error('║                                                                ║');
    console.error('║  Agents cannot run without a container runtime. To fix:        ║');
    console.error('║  1. Ensure Docker is installed and running                     ║');
    console.error('║  2. Run: docker info                                           ║');
    console.error('║  3. Restart ClawBridge                                           ║');
    console.error('╚════════════════════════════════════════════════════════════════╝\n');
    throw new Error('Container runtime is required but failed to start', {
      cause: err,
    });
  }
}

/**
 * Kill orphaned ClawBridge containers from THIS install's previous runs.
 *
 * Scoped by label `clawbridge-install=<slug>` so a crash-looping peer install
 * cannot reap our containers, and we cannot reap theirs. The label is
 * stamped onto every container at spawn time — see container-runner.ts.
 */
export function cleanupOrphans(): void {
  try {
    // Use -a to catch both running AND stopped/exited containers.
    // After a Docker daemon restart, --rm containers in Exited state are not
    // automatically cleaned up and block subsequent docker run --name reuse.
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ps -a --filter label=${CONTAINER_INSTALL_LABEL} --format '{{.Names}}	{{.State}}'`,
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf-8',
      },
    );
    const lines = output.trim().split('\n').filter(Boolean);
    const running: string[] = [];
    const stopped: string[] = [];
    for (const line of lines) {
      const [name, state] = line.split('\t');
      if (!name) continue;
      if (state === 'running') running.push(name);
      else stopped.push(name); // exited, created, paused, dead, etc.
    }
    // Stop running containers first, then force-remove all (running + stopped).
    for (const name of running) {
      try {
        stopContainer(name);
      } catch {
        /* already stopped */
      }
    }
    const all = [...running, ...stopped];
    for (const name of all) {
      try {
        execSync(`${CONTAINER_RUNTIME_BIN} rm -f ${name}`, { stdio: 'pipe' });
      } catch {
        /* already removed */
      }
    }
    if (all.length > 0) {
      log.info('Cleaned up orphaned containers', { running: running.length, stopped: stopped.length, names: all });
    }
  } catch (err) {
    log.warn('Failed to clean up orphaned containers', { err });
  }
}
