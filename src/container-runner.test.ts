import { describe, expect, it } from 'vitest';

import { resolveProviderName } from './container-runner.js';

describe('resolveProviderName', () => {
  it('defaults to codex when nothing is set', () => {
    expect(resolveProviderName(null, null, undefined)).toBe('codex');
  });

  it('lowercases the resolved name', () => {
    expect(resolveProviderName(null, null, 'Codex')).toBe('codex');
  });

  it('treats empty string as unset (falls through to default)', () => {
    expect(resolveProviderName('', null, undefined)).toBe('codex');
  });
});
