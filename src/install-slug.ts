/**
 * Per-checkout install identifiers. Lets two ClawBridge installs coexist on
 * one host without clobbering each other's service registration or the
 * shared `clawbridge-codex:latest` docker image tag.
 *
 * Slug is sha1(projectRoot)[:8] — deterministic per checkout path, stable
 * across re-runs, unique enough across installs.
 */
import { createHash } from 'crypto';

export function getInstallSlug(projectRoot: string = process.cwd()): string {
  return createHash('sha1').update(projectRoot).digest('hex').slice(0, 8);
}

/** launchd Label + plist basename. e.g. `com.clawbridge-v2-ab12cd34`. */
export function getLaunchdLabel(projectRoot?: string): string {
  return `com.clawbridge-v2-${getInstallSlug(projectRoot)}`;
}

/** systemd unit name (no .service suffix). e.g. `clawbridge-v2-ab12cd34`. */
export function getSystemdUnit(projectRoot?: string): string {
  return `clawbridge-v2-${getInstallSlug(projectRoot)}`;
}

/** Docker image base (no tag). e.g. `clawbridge-codex-v2-ab12cd34`. */
export function getContainerImageBase(projectRoot?: string): string {
  return `clawbridge-codex-v2-${getInstallSlug(projectRoot)}`;
}

/** Default full container image reference with `:latest` tag. */
export function getDefaultContainerImage(projectRoot?: string): string {
  return `${getContainerImageBase(projectRoot)}:latest`;
}
