import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';

// Mock all services used by webhookController.
vi.mock('../../src/services/githubService', () => ({
  fetchPRDetails: vi.fn().mockResolvedValue({ prData: { head: { sha: 'abc' } }, files: [] }),
  fetchCommentBody: vi.fn().mockResolvedValue(''),
  postPullRequestComment: vi.fn().mockResolvedValue(undefined),
  postPullRequestInlineComments: vi.fn().mockResolvedValue(undefined),
  createPRComment: vi.fn().mockResolvedValue(1),
  updatePRComment: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/services/openaiService', () => ({
  analyzeFiles: vi.fn().mockResolvedValue({
    summary: 'test',
    suggestions: [],
    inlineFindings: [],
    nonInlineResults: [],
    recommendations: [],
  }),
}));

vi.mock('../../src/pipeline/generateSummary', () => ({
  generateSummary: vi.fn().mockReturnValue('summary'),
}));

vi.mock('../../src/pipeline/splitFindings', () => ({
  formatInlineCommentBody: vi.fn(),
  splitFindings: vi.fn(),
}));

vi.mock('../../src/services/feedbackService', () => ({
  parseFeedbackCommand: vi.fn(),
  storeFeedback: vi.fn(),
}));

vi.mock('../../src/services/ingestionService', () => ({
  ingestPushChanges: vi.fn(),
}));

vi.mock('../../src/services/bootstrapService', () => ({
  bootstrapRepo: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/services/reviewDepthService', () => ({
  updateReviewCoverage: vi.fn(),
}));

const mockUpsertInstallation = vi.fn();
const mockGetInstallationByGithubId = vi.fn();
const mockSuspendInstallation = vi.fn();
const mockUnsuspendInstallation = vi.fn();
const mockDeleteInstallation = vi.fn();
const mockUpdateInstallationPlan = vi.fn();
const mockLogMarketplaceEvent = vi.fn().mockResolvedValue(undefined);
const mockCreateReviewEvent = vi.fn().mockResolvedValue(null);
const mockCompleteReviewEvent = vi.fn().mockResolvedValue(undefined);

vi.mock('../../src/services/installationService', () => ({
  upsertInstallation: (...args: unknown[]) => mockUpsertInstallation(...args),
  getInstallationByGithubId: (...args: unknown[]) => mockGetInstallationByGithubId(...args),
  suspendInstallation: (...args: unknown[]) => mockSuspendInstallation(...args),
  unsuspendInstallation: (...args: unknown[]) => mockUnsuspendInstallation(...args),
  deleteInstallation: (...args: unknown[]) => mockDeleteInstallation(...args),
  updateInstallationPlan: (...args: unknown[]) => mockUpdateInstallationPlan(...args),
  logMarketplaceEvent: (...args: unknown[]) => mockLogMarketplaceEvent(...args),
  createReviewEvent: (...args: unknown[]) => mockCreateReviewEvent(...args),
  completeReviewEvent: (...args: unknown[]) => mockCompleteReviewEvent(...args),
}));

vi.mock('../../src/services/vectorService', () => ({
  createEmbedding: vi.fn(),
  storeEmbedding: vi.fn(),
  querySimilar: vi.fn(),
}));

import { handleWebhook } from '../../src/controllers/webhookController';

const WEBHOOK_SECRET = 'test-secret';

beforeEach(() => {
  vi.clearAllMocks();
  process.env.GITHUB_WEBHOOK_SECRET = WEBHOOK_SECRET;
});

const sign = (body: unknown): string => {
  const hmac = crypto.createHmac('sha256', WEBHOOK_SECRET);
  return 'sha256=' + hmac.update(JSON.stringify(body)).digest('hex');
};

const makeReq = (event: string, body: unknown) => ({
  headers: {
    'x-github-event': event,
    'x-hub-signature-256': sign(body),
  },
  body,
});

const makeRes = () => {
  const res = {
    status: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
    sendStatus: vi.fn().mockReturnThis(),
  };
  return res;
};

describe('installation event', () => {
  const basePayload = {
    action: 'created',
    installation: {
      id: 12345,
      account: { login: 'test-org', id: 999, type: 'Organization' },
      app_id: 1,
    },
  };

  it('calls upsertInstallation on created', async () => {
    mockUpsertInstallation.mockResolvedValue({ id: 1 });
    const req = makeReq('installation', basePayload);
    const res = makeRes();

    await handleWebhook(req as any, res as any);

    expect(mockUpsertInstallation).toHaveBeenCalledWith({
      githubInstallId: 12345,
      accountLogin: 'test-org',
      accountType: 'Organization',
      accountId: 999,
    });
    expect(res.sendStatus).toHaveBeenCalledWith(200);
  });

  it('calls deleteInstallation on deleted', async () => {
    mockDeleteInstallation.mockResolvedValue(undefined);
    const req = makeReq('installation', { ...basePayload, action: 'deleted' });
    const res = makeRes();

    await handleWebhook(req as any, res as any);

    expect(mockDeleteInstallation).toHaveBeenCalledWith(12345);
  });

  it('calls suspendInstallation on suspend', async () => {
    mockSuspendInstallation.mockResolvedValue(undefined);
    const req = makeReq('installation', { ...basePayload, action: 'suspend' });
    const res = makeRes();

    await handleWebhook(req as any, res as any);

    expect(mockSuspendInstallation).toHaveBeenCalledWith(12345);
  });

  it('calls unsuspendInstallation on unsuspend', async () => {
    mockUnsuspendInstallation.mockResolvedValue(undefined);
    const req = makeReq('installation', { ...basePayload, action: 'unsuspend' });
    const res = makeRes();

    await handleWebhook(req as any, res as any);

    expect(mockUnsuspendInstallation).toHaveBeenCalledWith(12345);
  });

  it('rejects invalid payload with 422', async () => {
    const req = makeReq('installation', { action: 'created' });
    const res = makeRes();

    await handleWebhook(req as any, res as any);

    expect(res.status).toHaveBeenCalledWith(422);
  });
});

describe('marketplace_purchase event', () => {
  const basePayload = {
    action: 'purchased',
    marketplace_purchase: {
      account: { id: 999, login: 'test-org', type: 'Organization' },
      plan: { id: 1, name: 'Pro', slug: 'pro' },
    },
    installation: { id: 12345 },
  };

  it('upserts installation on purchased', async () => {
    mockUpsertInstallation.mockResolvedValue({ id: 1 });
    const req = makeReq('marketplace_purchase', basePayload);
    const res = makeRes();

    await handleWebhook(req as any, res as any);

    expect(mockLogMarketplaceEvent).toHaveBeenCalledWith(
      'purchased', 999, expect.objectContaining({ name: 'Pro' }), expect.anything()
    );
    expect(mockUpsertInstallation).toHaveBeenCalledWith(expect.objectContaining({
      githubInstallId: 12345,
      planSlug: 'pro',
      planName: 'Pro',
    }));
  });

  it('updates plan on changed', async () => {
    mockUpdateInstallationPlan.mockResolvedValue(undefined);
    const req = makeReq('marketplace_purchase', { ...basePayload, action: 'changed' });
    const res = makeRes();

    await handleWebhook(req as any, res as any);

    expect(mockUpdateInstallationPlan).toHaveBeenCalledWith(12345, 'pro', 'Pro');
  });

  it('downgrades to free on cancelled', async () => {
    mockUpdateInstallationPlan.mockResolvedValue(undefined);
    const req = makeReq('marketplace_purchase', { ...basePayload, action: 'cancelled' });
    const res = makeRes();

    await handleWebhook(req as any, res as any);

    expect(mockUpdateInstallationPlan).toHaveBeenCalledWith(12345, 'free', 'Free');
  });

  it('rejects invalid payload with 422', async () => {
    const req = makeReq('marketplace_purchase', { action: 'purchased' });
    const res = makeRes();

    await handleWebhook(req as any, res as any);

    expect(res.status).toHaveBeenCalledWith(422);
  });
});

describe('installation gate on pull_request', () => {
  const prPayload = {
    action: 'opened',
    pull_request: { number: 1, title: 'Test PR', user: { login: 'alice' } },
    repository: { name: 'repo', full_name: 'org/repo', owner: { login: 'org' } },
    installation: { id: 12345 },
  };

  it('blocks suspended installations', async () => {
    mockGetInstallationByGithubId.mockResolvedValue({ id: 1, status: 'suspended' });
    const req = makeReq('pull_request', prPayload);
    const res = makeRes();

    await handleWebhook(req as any, res as any);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith('Installation not active');
  });

  it('blocks deleted installations', async () => {
    mockGetInstallationByGithubId.mockResolvedValue({ id: 1, status: 'deleted' });
    const req = makeReq('pull_request', prPayload);
    const res = makeRes();

    await handleWebhook(req as any, res as any);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith('Installation not active');
  });

  it('allows active installations through', async () => {
    mockGetInstallationByGithubId.mockResolvedValue({ id: 1, status: 'active' });
    mockCreateReviewEvent.mockResolvedValue(42);
    const req = makeReq('pull_request', prPayload);
    const res = makeRes();

    await handleWebhook(req as any, res as any);

    // Should proceed (sendStatus 200 from the handler, not the gate block)
    expect(res.sendStatus).toHaveBeenCalledWith(200);
    expect(res.send).not.toHaveBeenCalledWith('Installation not active');
  });

  it('allows unknown installations through (graceful degradation)', async () => {
    // Installation not in DB yet — should still proceed
    mockGetInstallationByGithubId.mockResolvedValue(null);
    mockCreateReviewEvent.mockResolvedValue(null);
    const req = makeReq('pull_request', prPayload);
    const res = makeRes();

    await handleWebhook(req as any, res as any);

    expect(res.sendStatus).toHaveBeenCalledWith(200);
    expect(res.send).not.toHaveBeenCalledWith('Installation not active');
  });
});
