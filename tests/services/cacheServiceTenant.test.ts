import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock redis — must be set up before importing cacheService.
// The module creates a client via buildRedisClient which checks env vars,
// so we need REDIS_URL set to avoid the "not configured" error path.
const mockGet = vi.fn();
const mockSet = vi.fn();
const mockRedisClient = {
  isOpen: true,
  get: mockGet,
  set: mockSet,
  on: vi.fn(),
  connect: vi.fn().mockResolvedValue(undefined),
};

vi.mock('redis', () => ({
  createClient: () => mockRedisClient,
}));

// Set REDIS_URL so buildRedisClient doesn't throw.
process.env.REDIS_URL = 'redis://localhost:6379';

import { getCachedOpenAIResponse, setCachedOpenAIResponse } from '../../src/services/cacheService';

beforeEach(() => {
  vi.clearAllMocks();
  mockGet.mockResolvedValue(null);
  mockSet.mockResolvedValue(undefined);
  // Ensure the mock client reports as open.
  mockRedisClient.isOpen = true;
});

describe('tenant-scoped cache keys', () => {
  it('uses global prefix when no installationId', async () => {
    await getCachedOpenAIResponse('test-key');
    expect(mockGet).toHaveBeenCalledWith('prism:openai:test-key');

    await setCachedOpenAIResponse('test-key', 'value');
    expect(mockSet).toHaveBeenCalledWith('prism:openai:test-key', 'value', expect.anything());
  });

  it('uses installation-scoped prefix when installationId provided', async () => {
    await getCachedOpenAIResponse('test-key', 12345);
    expect(mockGet).toHaveBeenCalledWith('prism:12345:openai:test-key');

    await setCachedOpenAIResponse('test-key', 'value', 12345);
    expect(mockSet).toHaveBeenCalledWith('prism:12345:openai:test-key', 'value', expect.anything());
  });

  it('different installations get different cache keys', async () => {
    await getCachedOpenAIResponse('same-key', 111);
    await getCachedOpenAIResponse('same-key', 222);

    expect(mockGet).toHaveBeenCalledWith('prism:111:openai:same-key');
    expect(mockGet).toHaveBeenCalledWith('prism:222:openai:same-key');
  });
});
