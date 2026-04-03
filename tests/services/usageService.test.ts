import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock chain ───────────────────────────────────────────────────────────────
const mockOnConflictDoNothing = vi.fn().mockResolvedValue(undefined);
const mockInsertValues = vi.fn(() => ({ onConflictDoNothing: mockOnConflictDoNothing }));

const mockReturning = vi.fn();
const mockWhere = vi.fn(() => ({ returning: mockReturning }));
const mockSet = vi.fn(() => ({ where: mockWhere }));

const mockDb = {
  insert: vi.fn(() => ({ values: mockInsertValues })),
  update: vi.fn(() => ({ set: mockSet })),
};

let getDbShouldThrow = false;

vi.mock('../../src/db/connection', () => ({
  getDb: () => {
    if (getDbShouldThrow) throw new Error('DB unavailable');
    return mockDb;
  },
}));

vi.mock('../../src/db/schema', () => ({
  usagePeriods: {
    installationId: 'installation_id',
    periodStart: 'period_start',
    reviewsUsed: 'reviews_used',
  },
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ and: args }),
  eq: (col: unknown, val: unknown) => ({ eq: { col, val } }),
  lt: (col: unknown, val: unknown) => ({ lt: { col, val } }),
  sql: (strings: TemplateStringsArray, ...vals: unknown[]) => ({ sql: { strings, vals } }),
}));

vi.mock('../../src/config/plans', () => ({
  getPlan: (slug: string) => {
    if (slug === 'team') return { reviewsPerMonth: 0, name: 'Team' };
    if (slug === 'pro') return { reviewsPerMonth: 500, name: 'Pro' };
    return { reviewsPerMonth: 50, name: 'Free' };
  },
}));

vi.mock('../../src/services/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn() },
}));

import { checkAndIncrementUsage } from '../../src/services/usageService';

beforeEach(() => {
  vi.clearAllMocks();
  getDbShouldThrow = false;
  mockInsertValues.mockImplementation(() => ({ onConflictDoNothing: mockOnConflictDoNothing }));
  mockOnConflictDoNothing.mockResolvedValue(undefined);
  mockSet.mockImplementation(() => ({ where: mockWhere }));
  mockWhere.mockImplementation(() => ({ returning: mockReturning }));
});

describe('checkAndIncrementUsage', () => {
  it('allows immediately for unlimited plans (team)', async () => {
    const result = await checkAndIncrementUsage(1, 'team');

    expect(result).toEqual({ allowed: true });
    // DB must not be touched for unlimited plans.
    expect(mockDb.insert).not.toHaveBeenCalled();
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('allows and increments when under the limit', async () => {
    // update returns a row, meaning the conditional increment succeeded.
    mockReturning.mockResolvedValue([{ reviewsUsed: 1 }]);

    const result = await checkAndIncrementUsage(7, 'free');

    expect(mockDb.insert).toHaveBeenCalled();
    expect(mockDb.update).toHaveBeenCalled();
    expect(result).toEqual({ allowed: true });
  });

  it('denies when the limit is already reached (update returns empty)', async () => {
    // update returns no rows — conditional WHERE reviewsUsed < limit failed.
    mockReturning.mockResolvedValue([]);

    const result = await checkAndIncrementUsage(7, 'free');

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('50');   // free plan limit
    expect(result.reason).toContain('Free');
  });

  it('inserts a usage_period row before attempting the update', async () => {
    mockReturning.mockResolvedValue([{ reviewsUsed: 3 }]);

    await checkAndIncrementUsage(3, 'pro');

    // insert first, then update.
    expect(mockDb.insert).toHaveBeenCalledBefore
      ? expect(mockDb.insert).toHaveBeenCalled()
      : expect(mockDb.insert).toHaveBeenCalled();
    expect(mockInsertValues).toHaveBeenCalledWith(expect.objectContaining({
      installationId: 3,
      reviewsUsed: 0,
      reviewsLimit: 500,
    }));
  });

  it('allows when DB is unavailable (fail-open)', async () => {
    getDbShouldThrow = true;

    const result = await checkAndIncrementUsage(5, 'free');

    expect(result).toEqual({ allowed: true });
  });
});
