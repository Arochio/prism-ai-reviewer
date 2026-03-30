import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── OpenAI SDK mock ──────────────────────────────────────────────────────────
// vi.hoisted ensures mockCreate is initialised before vi.mock's hoisted factory runs.
const mockCreate = vi.hoisted(() => vi.fn());

vi.mock('openai', () => {
  class APIError extends Error {
    status?: number;
    constructor(message: string, status?: number) {
      super(message);
      this.status = status;
    }
  }
  class MockOpenAI {
    // openaiService accesses OpenAI.APIError as a static — mirror that here.
    static APIError = APIError;
    chat = { completions: { create: mockCreate } };
    constructor(_opts?: unknown) {}
  }
  return { default: MockOpenAI, APIError };
});

// ── Config mock — controls per-pass model values ─────────────────────────────
vi.mock('../../src/config/openai.config', () => ({
  openAIConfig: {
    model: 'gpt-4o-mini',
    bugPassModel: 'gpt-4o',
    designPassModel: 'gpt-4o-mini',
    performancePassModel: 'gpt-4o-mini',
    validationPassModel: 'gpt-4o-mini',
    maxTokens: 100,
    temperature: 0.2,
    topP: 1,
    n: 1,
    frequencyPenalty: 0,
    presencePenalty: 0,
  },
}));

// ── Stub heavy dependencies so module loads cleanly ──────────────────────────
vi.mock('../../src/services/vectorService', () => ({
  createEmbedding: vi.fn(),
  storeEmbedding: vi.fn(),
  querySimilar: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../src/services/cacheService', () => ({
  getCachedOpenAIResponse: vi.fn().mockResolvedValue(null),
  setCachedOpenAIResponse: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/services/developerProfileService', () => ({
  updateDeveloperProfile: vi.fn().mockResolvedValue(undefined),
}));

import { callOpenAI } from '../../src/services/openaiService';
import OpenAI, { APIError } from 'openai';

const ok = (content: string) => ({ choices: [{ message: { content } }] });

describe('callOpenAI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreate.mockResolvedValue(ok('test response'));
  });

  it('uses openAIConfig.model when no override is provided', async () => {
    await callOpenAI('system', 'user');
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-4o-mini' }),
    );
  });

  it('uses the provided model override instead of the default', async () => {
    await callOpenAI('system', 'user', 'gpt-4o');
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-4o' }),
    );
  });

  it('different override values are forwarded correctly', async () => {
    await callOpenAI('system', 'user', 'gpt-4.1-mini');
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-4.1-mini' }),
    );
  });

  it('returns the content string from the API response', async () => {
    mockCreate.mockResolvedValue(ok('analysis result'));
    const result = await callOpenAI('system', 'user');
    expect(result).toBe('analysis result');
  });

  it('throws when the API returns null content', async () => {
    mockCreate.mockResolvedValue({ choices: [{ message: { content: null } }] });
    await expect(callOpenAI('system', 'user')).rejects.toThrow('OpenAI returned no content');
  });

  it('throws when choices array is empty', async () => {
    mockCreate.mockResolvedValue({ choices: [] });
    await expect(callOpenAI('system', 'user')).rejects.toThrow('OpenAI returned no content');
  });

  it('wraps generic API errors with a stable message', async () => {
    mockCreate.mockRejectedValue(new Error('network failure'));
    await expect(callOpenAI('system', 'user')).rejects.toThrow('OpenAI API request failed');
  });

  it('includes HTTP status in the error message for APIError', async () => {
    const apiErr = new (APIError as any)('rate limited', 429);
    mockCreate.mockRejectedValue(apiErr);
    await expect(callOpenAI('system', 'user')).rejects.toThrow('status 429');
  });

  it('passes system and user content to the API', async () => {
    await callOpenAI('be terse', 'review this code');
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          { role: 'system', content: 'be terse' },
          { role: 'user', content: 'review this code' },
        ],
      }),
    );
  });
});
