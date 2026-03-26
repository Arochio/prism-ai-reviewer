import { describe, it, expect, vi } from 'vitest';

// Mock the logger to suppress output during tests
vi.mock('../../src/services/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { retryWithBackoff } from '../../src/utils/retry';

describe('retryWithBackoff', () => {
  it('returns result on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await retryWithBackoff(fn, 3, 1, 'test');
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on transient failure then succeeds', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValue('ok');
    const result = await retryWithBackoff(fn, 3, 1, 'test');
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws after max attempts', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('always fails'));
    await expect(retryWithBackoff(fn, 2, 1, 'test')).rejects.toThrow('always fails');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws immediately for non-retryable 400 error', async () => {
    const error = Object.assign(new Error('bad request'), {
      response: { status: 400 },
    });
    const fn = vi.fn().mockRejectedValue(error);
    await expect(retryWithBackoff(fn, 3, 1, 'test')).rejects.toThrow('bad request');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws immediately for non-retryable 401 error', async () => {
    const error = Object.assign(new Error('unauthorized'), {
      response: { status: 401 },
    });
    const fn = vi.fn().mockRejectedValue(error);
    await expect(retryWithBackoff(fn, 3, 1, 'test')).rejects.toThrow('unauthorized');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws immediately for non-retryable 404 error', async () => {
    const error = Object.assign(new Error('not found'), {
      response: { status: 404 },
    });
    const fn = vi.fn().mockRejectedValue(error);
    await expect(retryWithBackoff(fn, 3, 1, 'test')).rejects.toThrow('not found');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on 429 rate limit error', async () => {
    const error = Object.assign(new Error('rate limited'), {
      response: { status: 429 },
    });
    const fn = vi.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValue('ok');
    const result = await retryWithBackoff(fn, 3, 1, 'test');
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries on 500 server error', async () => {
    const error = Object.assign(new Error('server error'), {
      response: { status: 500 },
    });
    const fn = vi.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValue('ok');
    const result = await retryWithBackoff(fn, 3, 1, 'test');
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
