import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock log
vi.mock('./log.js', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

// Mock child_process — store the mock fn so tests can configure it
const mockExecSync = vi.fn();
const mockExecFileSync = vi.fn();
vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

import {
  CONTAINER_RUNTIME_BIN,
  readonlyMountArgs,
  stopContainer,
  ensureContainerRuntimeRunning,
  cleanupOrphans,
} from './container-runtime.js';
import { CONTAINER_INSTALL_LABEL } from './config.js';
import { log } from './log.js';

beforeEach(() => {
  vi.clearAllMocks();
});

// --- Pure functions ---

describe('readonlyMountArgs', () => {
  it('returns -v flag with :ro suffix', () => {
    const args = readonlyMountArgs('/host/path', '/container/path');
    expect(args).toEqual(['-v', '/host/path:/container/path:ro']);
  });
});

describe('stopContainer', () => {
  it('calls docker stop for valid container names', () => {
    stopContainer('clawbridge-test-123');
    expect(mockExecSync).toHaveBeenCalledWith(`${CONTAINER_RUNTIME_BIN} stop -t 1 clawbridge-test-123`, {
      stdio: 'pipe',
    });
  });

  it('rejects names with shell metacharacters', () => {
    expect(() => stopContainer('foo; rm -rf /')).toThrow('Invalid container name');
    expect(() => stopContainer('foo$(whoami)')).toThrow('Invalid container name');
    expect(() => stopContainer('foo`id`')).toThrow('Invalid container name');
    expect(mockExecSync).not.toHaveBeenCalled();
  });
});

// --- ensureContainerRuntimeRunning ---

describe('ensureContainerRuntimeRunning', () => {
  it('does nothing when runtime is already running', () => {
    mockExecSync.mockReturnValueOnce('');

    ensureContainerRuntimeRunning();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(mockExecSync).toHaveBeenCalledWith(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    expect(log.debug).toHaveBeenCalledWith('Container runtime already running');
  });

  it('throws when docker info fails', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('Cannot connect to the Docker daemon');
    });

    expect(() => ensureContainerRuntimeRunning()).toThrow('Container runtime is required but failed to start');
    expect(log.error).toHaveBeenCalled();
  });
});

// --- cleanupOrphans ---

describe('cleanupOrphans', () => {
  it('filters ps by the install label so peers are not reaped', () => {
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans();

    expect(mockExecSync).toHaveBeenCalledWith(
      `${CONTAINER_RUNTIME_BIN} ps -a --filter label=${CONTAINER_INSTALL_LABEL} --format '{{.Names}}\t{{.State}}'`,
      expect.any(Object),
    );
  });

  it('stops orphaned clawbridge containers', () => {
    // docker ps returns container name + state, one per line
    mockExecSync.mockReturnValueOnce('clawbridge-group1-111\trunning\nclawbridge-group2-222\texited\n');
    // stop/rm calls succeed
    mockExecSync.mockReturnValue('');
    mockExecFileSync.mockReturnValue('');

    cleanupOrphans();

    // ps + 1 stop call for the running container
    expect(mockExecSync).toHaveBeenCalledTimes(2);
    expect(mockExecSync).toHaveBeenNthCalledWith(2, `${CONTAINER_RUNTIME_BIN} stop -t 1 clawbridge-group1-111`, {
      stdio: 'pipe',
    });
    expect(mockExecFileSync).toHaveBeenCalledTimes(2);
    expect(mockExecFileSync).toHaveBeenNthCalledWith(1, CONTAINER_RUNTIME_BIN, ['rm', '-f', 'clawbridge-group1-111'], {
      stdio: 'pipe',
    });
    expect(mockExecFileSync).toHaveBeenNthCalledWith(2, CONTAINER_RUNTIME_BIN, ['rm', '-f', 'clawbridge-group2-222'], {
      stdio: 'pipe',
    });
    expect(log.info).toHaveBeenCalledWith('Cleaned up orphaned containers', {
      running: 1,
      stopped: 1,
      names: ['clawbridge-group1-111', 'clawbridge-group2-222'],
    });
  });

  it('does nothing when no orphans exist', () => {
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(log.info).not.toHaveBeenCalled();
  });

  it('warns and continues when ps fails', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('docker not available');
    });

    cleanupOrphans(); // should not throw

    expect(log.warn).toHaveBeenCalledWith(
      'Failed to clean up orphaned containers',
      expect.objectContaining({ err: expect.any(Error) }),
    );
  });

  it('continues stopping remaining containers when one stop fails', () => {
    mockExecSync.mockReturnValueOnce('clawbridge-a-1\trunning\nclawbridge-b-2\trunning\n');
    // First stop fails
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('already stopped');
    });
    // Second stop succeeds
    mockExecSync.mockReturnValueOnce('');
    mockExecFileSync.mockReturnValue('');

    cleanupOrphans(); // should not throw

    expect(mockExecSync).toHaveBeenCalledTimes(3);
    expect(mockExecFileSync).toHaveBeenCalledTimes(2);
    expect(log.info).toHaveBeenCalledWith('Cleaned up orphaned containers', {
      running: 2,
      stopped: 0,
      names: ['clawbridge-a-1', 'clawbridge-b-2'],
    });
  });
});
