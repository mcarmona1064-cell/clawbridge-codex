import { describe, it, expect } from 'bun:test';

import './index.js'; // trigger provider self-registration
import { createProvider, type ProviderName } from './factory.js';
import { CodexProvider } from './codex.js';
import { MockProvider } from './mock.js';

describe('createProvider', () => {
  it('returns CodexProvider for codex', () => {
    expect(createProvider('codex')).toBeInstanceOf(CodexProvider);
  });

  it('returns MockProvider for mock', () => {
    expect(createProvider('mock')).toBeInstanceOf(MockProvider);
  });

  it('throws for unknown name', () => {
    expect(() => createProvider('bogus' as ProviderName)).toThrow(/Unknown provider/);
  });
});
