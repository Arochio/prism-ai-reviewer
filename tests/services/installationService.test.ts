import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the database connection module.
const mockReturning = vi.fn();
const mockWhere = vi.fn(() => ({ returning: mockReturning }));
const mockSet = vi.fn(() => ({ where: mockWhere }));
const mockLimit = vi.fn();
// insert().values() needs to return { returning } for both installationService
// (upsert uses insert().values().returning()) and createReviewEvent.
const mockValues = vi.fn(() => ({ returning: mockReturning }));

const mockDb = {
  select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: mockLimit })) })) })),
  insert: vi.fn(() => ({ values: mockValues })),
  update: vi.fn(() => ({ set: mockSet })),
};

vi.mock('../../src/db/connection', () => ({
  getDb: () => mockDb,
}));

vi.mock('../../src/db/schema', () => ({
  installations: { id: 'id', githubInstallId: 'github_install_id', accountLogin: 'account_login', status: 'status' },
  marketplaceEvents: {},
  reviewEvents: { id: 'id' },
}));

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ col, val }),
}));

import {
  upsertInstallation,
  getInstallationByGithubId,
  suspendInstallation,
  unsuspendInstallation,
  deleteInstallation,
  updateInstallationPlan,
  logMarketplaceEvent,
  createReviewEvent,
  completeReviewEvent,
} from '../../src/services/installationService';

beforeEach(() => {
  vi.clearAllMocks();
  // Restore default mock implementations after clearAllMocks.
  mockValues.mockImplementation(() => ({ returning: mockReturning }));
  mockWhere.mockImplementation(() => ({ returning: mockReturning }));
  mockSet.mockImplementation(() => ({ where: mockWhere }));
});

describe('upsertInstallation', () => {
  it('creates a new installation when none exists', async () => {
    // select returns empty
    const mockFrom = vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([]) })) }));
    mockDb.select.mockReturnValue({ from: mockFrom });

    const created = { id: 1, githubInstallId: 12345, accountLogin: 'test-org', status: 'active' };
    mockReturning.mockResolvedValue([created]);

    const result = await upsertInstallation({
      githubInstallId: 12345,
      accountLogin: 'test-org',
      accountType: 'Organization',
      accountId: 999,
    });

    expect(mockDb.insert).toHaveBeenCalled();
    expect(mockValues).toHaveBeenCalledWith(expect.objectContaining({
      githubInstallId: 12345,
      accountLogin: 'test-org',
      accountType: 'Organization',
      accountId: 999,
      planSlug: 'free',
      planName: 'Free',
    }));
    expect(result).toEqual(created);
  });

  it('updates an existing installation', async () => {
    const existing = { id: 1, githubInstallId: 12345, accountLogin: 'test-org', status: 'deleted' };
    const mockFrom = vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([existing]) })) }));
    mockDb.select.mockReturnValue({ from: mockFrom });

    const updated = { ...existing, status: 'active' };
    mockReturning.mockResolvedValue([updated]);

    const result = await upsertInstallation({
      githubInstallId: 12345,
      accountLogin: 'test-org',
      accountType: 'Organization',
      accountId: 999,
    });

    expect(mockDb.update).toHaveBeenCalled();
    expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({
      accountLogin: 'test-org',
      status: 'active',
      suspendedAt: null,
      deletedAt: null,
    }));
    expect(result).toEqual(updated);
  });
});

describe('getInstallationByGithubId', () => {
  it('returns null when not found', async () => {
    const mockFrom = vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([]) })) }));
    mockDb.select.mockReturnValue({ from: mockFrom });

    const result = await getInstallationByGithubId(99999);
    expect(result).toBeNull();
  });

  it('returns installation when found', async () => {
    const installation = { id: 1, githubInstallId: 12345, status: 'active' };
    const mockFrom = vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([installation]) })) }));
    mockDb.select.mockReturnValue({ from: mockFrom });

    const result = await getInstallationByGithubId(12345);
    expect(result).toEqual(installation);
  });
});

describe('suspendInstallation', () => {
  it('sets status to suspended', async () => {
    mockWhere.mockResolvedValue(undefined);

    await suspendInstallation(12345);

    expect(mockDb.update).toHaveBeenCalled();
    expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({
      status: 'suspended',
    }));
  });
});

describe('unsuspendInstallation', () => {
  it('sets status to active and clears suspendedAt', async () => {
    mockWhere.mockResolvedValue(undefined);

    await unsuspendInstallation(12345);

    expect(mockDb.update).toHaveBeenCalled();
    expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({
      status: 'active',
      suspendedAt: null,
    }));
  });
});

describe('deleteInstallation', () => {
  it('soft-deletes with status and timestamp', async () => {
    mockWhere.mockResolvedValue(undefined);

    await deleteInstallation(12345);

    expect(mockDb.update).toHaveBeenCalled();
    expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({
      status: 'deleted',
    }));
    expect(mockSet.mock.calls[0][0]).toHaveProperty('deletedAt');
  });
});

describe('updateInstallationPlan', () => {
  it('updates plan slug and name', async () => {
    mockWhere.mockResolvedValue(undefined);

    await updateInstallationPlan(12345, 'pro', 'Pro');

    expect(mockDb.update).toHaveBeenCalled();
    expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({
      planSlug: 'pro',
      planName: 'Pro',
    }));
  });
});

describe('logMarketplaceEvent', () => {
  it('inserts a marketplace event record', async () => {
    // logMarketplaceEvent doesn't use .returning(), so values just needs to resolve.
    mockValues.mockResolvedValueOnce(undefined);

    await logMarketplaceEvent('purchased', 999, { name: 'Pro' }, { action: 'purchased' });

    expect(mockDb.insert).toHaveBeenCalled();
    expect(mockValues).toHaveBeenCalledWith(expect.objectContaining({
      action: 'purchased',
      githubAccountId: 999,
    }));
  });
});

describe('createReviewEvent', () => {
  it('creates a review event and returns its id', async () => {
    mockReturning.mockResolvedValue([{ id: 42 }]);

    const id = await createReviewEvent(1, 'org/repo', 123, 'pr_review');

    expect(mockDb.insert).toHaveBeenCalled();
    expect(mockValues).toHaveBeenCalledWith(expect.objectContaining({
      installationId: 1,
      repoFullName: 'org/repo',
      prNumber: 123,
      eventType: 'pr_review',
      status: 'started',
    }));
    expect(id).toBe(42);
  });
});

describe('completeReviewEvent', () => {
  it('updates status and completedAt', async () => {
    mockWhere.mockResolvedValue(undefined);

    await completeReviewEvent(42, 'completed', { inlineCount: 3 });

    expect(mockDb.update).toHaveBeenCalled();
    expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({
      status: 'completed',
      metadata: { inlineCount: 3 },
    }));
    expect(mockSet.mock.calls[0][0]).toHaveProperty('completedAt');
  });
});
