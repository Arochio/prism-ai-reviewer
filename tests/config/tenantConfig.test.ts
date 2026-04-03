import { describe, it, expect, vi } from 'vitest';
import { resolveTenantConfig } from '../../src/config/tenantConfig';
import { openAIConfig } from '../../src/config/openai.config';
import type { Installation } from '../../src/db/schema';

// Minimal Installation stub — only the fields resolveTenantConfig reads.
const BASE: Pick<Installation, 'settings'> = { settings: {} };

const makeInstall = (settings: Record<string, unknown>): Installation =>
  ({ ...BASE, settings } as unknown as Installation);

describe('resolveTenantConfig', () => {
  it('returns global config when installation is null', () => {
    expect(resolveTenantConfig(null)).toBe(openAIConfig);
  });

  it('returns global config when settings is empty', () => {
    expect(resolveTenantConfig(makeInstall({}))).toBe(openAIConfig);
  });

  it('merges allowed numeric override (maxTokens)', () => {
    const result = resolveTenantConfig(makeInstall({ maxTokens: 2048 }));
    expect(result.maxTokens).toBe(2048);
    // All other keys remain at their global defaults.
    expect(result.model).toBe(openAIConfig.model);
  });

  it('merges allowed string override (model)', () => {
    const result = resolveTenantConfig(makeInstall({ model: 'gpt-4o' }));
    expect(result.model).toBe('gpt-4o');
  });

  it('merges multiple allowed overrides at once', () => {
    const result = resolveTenantConfig(makeInstall({
      maxTokens: 800,
      totalFilesLimit: 4,
      temperature: 0.5,
    }));
    expect(result.maxTokens).toBe(800);
    expect(result.totalFilesLimit).toBe(4);
    expect(result.temperature).toBe(0.5);
  });

  it('ignores values whose type differs from the default', () => {
    // maxTokens is a number in defaults — should be ignored when sent as string.
    const result = resolveTenantConfig(makeInstall({ maxTokens: '999' }));
    expect(result.maxTokens).toBe(openAIConfig.maxTokens);
  });

  it('ignores disallowed keys (e.g. bugPassModel, topP)', () => {
    const result = resolveTenantConfig(makeInstall({
      bugPassModel: 'gpt-3.5-turbo',
      topP: 0.9,
    }));
    expect(result.bugPassModel).toBe(openAIConfig.bugPassModel);
    expect(result.topP).toBe(openAIConfig.topP);
  });

  it('returns global config object reference when no valid overrides found', () => {
    // All keys are either disallowed or wrong type — should short-circuit to global.
    const result = resolveTenantConfig(makeInstall({ bugPassModel: 'x', topP: 0.5 }));
    expect(result).toBe(openAIConfig);
  });
});
