import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/services/githubService', () => ({
  fetchPRReviews: vi.fn(),
  fetchPRReviewComments: vi.fn(),
  fetchPRFilenames: vi.fn(),
  findPrismSummaryComment: vi.fn(),
  updatePRComment: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  fetchPRReviews,
  fetchPRReviewComments,
  fetchPRFilenames,
  findPrismSummaryComment,
  updatePRComment,
  type PRReview,
  type PRReviewComment,
} from '../../src/services/githubService';
import { updateReviewCoverage } from '../../src/services/reviewDepthService';

const mReviews = vi.mocked(fetchPRReviews);
const mComments = vi.mocked(fetchPRReviewComments);
const mFilenames = vi.mocked(fetchPRFilenames);
const mFindComment = vi.mocked(findPrismSummaryComment);
const mUpdateComment = vi.mocked(updatePRComment);

const OWNER = 'testOwner';
const REPO = 'testRepo';
const PR_NUMBER = 42;
const PR_CREATED_AT = '2026-01-01T00:00:00Z';
const INSTALL_ID = 123;

const call = () =>
  updateReviewCoverage(OWNER, REPO, PR_NUMBER, PR_CREATED_AT, INSTALL_ID);

const makeReview = (overrides: Partial<PRReview> = {}): PRReview => ({
  id: 1,
  user: { login: 'reviewer1' },
  state: 'APPROVED',
  submitted_at: '2026-01-01T01:00:00Z', // 60 min after PR opened
  ...overrides,
});

const makeComment = (overrides: Partial<PRReviewComment> = {}): PRReviewComment => ({
  id: 10,
  pull_request_review_id: 1,
  user: { login: 'reviewer1' },
  path: 'src/index.ts',
  body: 'looks good',
  ...overrides,
});

const PRISM_COMMENT = { id: 99, body: '### AI Review\n\nSome findings.' };

describe('updateReviewCoverage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mReviews.mockResolvedValue([makeReview()]);
    mComments.mockResolvedValue([]);
    mFilenames.mockResolvedValue(['src/index.ts', 'src/utils.ts']);
    mFindComment.mockResolvedValue(PRISM_COMMENT);
  });

  it('does nothing when no Prism summary comment exists', async () => {
    mFindComment.mockResolvedValue(null);
    await call();
    expect(mUpdateComment).not.toHaveBeenCalled();
  });

  it('does nothing when no human reviews exist', async () => {
    mReviews.mockResolvedValue([]);
    await call();
    expect(mUpdateComment).not.toHaveBeenCalled();
  });

  it('does nothing when only bot reviews exist', async () => {
    mReviews.mockResolvedValue([
      makeReview({ user: { login: 'prism-ai[bot]' } }),
      makeReview({ user: { login: 'dependabot-bot' } }),
    ]);
    await call();
    expect(mUpdateComment).not.toHaveBeenCalled();
  });

  it('skips PENDING reviews', async () => {
    mReviews.mockResolvedValue([makeReview({ state: 'PENDING' })]);
    await call();
    expect(mUpdateComment).not.toHaveBeenCalled();
  });

  it('appends a Review Coverage section to the existing Prism comment', async () => {
    await call();
    expect(mUpdateComment).toHaveBeenCalledOnce();
    const body = mUpdateComment.mock.calls[0][3] as string;
    expect(body).toContain('### AI Review');
    expect(body).toContain('## Review Coverage');
  });

  it('shows ✅ when all changed files are covered by inline comments', async () => {
    mComments.mockResolvedValue([
      makeComment({ path: 'src/index.ts' }),
      makeComment({ path: 'src/utils.ts' }),
    ]);
    await call();
    const body = mUpdateComment.mock.calls[0][3] as string;
    expect(body).toContain('✅');
    expect(body).not.toContain('⚠️');
  });

  it('shows ⚠️ and lists uncovered files when coverage is partial', async () => {
    // reviewer commented on index.ts but not utils.ts
    mComments.mockResolvedValue([makeComment({ path: 'src/index.ts' })]);
    await call();
    const body = mUpdateComment.mock.calls[0][3] as string;
    expect(body).toContain('⚠️');
    expect(body).toContain('src/utils.ts');
  });

  it('marks uncovered files matching risky path patterns with 🔴', async () => {
    mFilenames.mockResolvedValue(['src/auth/login.ts', 'src/utils.ts']);
    mComments.mockResolvedValue([]); // nothing covered
    await call();
    const body = mUpdateComment.mock.calls[0][3] as string;
    expect(body).toContain('🔴');
    expect(body).toContain('src/auth/login.ts');
  });

  it('does not mark non-risky files with 🔴', async () => {
    mFilenames.mockResolvedValue(['src/helpers.ts']);
    mComments.mockResolvedValue([]);
    await call();
    const body = mUpdateComment.mock.calls[0][3] as string;
    expect(body).not.toContain('🔴');
  });

  it('notes quick approvals submitted within 10 min with no inline comments', async () => {
    // 5 minutes after PR opened
    mReviews.mockResolvedValue([makeReview({ submitted_at: '2026-01-01T00:05:00Z' })]);
    mComments.mockResolvedValue([]);
    await call();
    const body = mUpdateComment.mock.calls[0][3] as string;
    expect(body).toContain('10 min');
  });

  it('does not note quick approval when inline comments were left', async () => {
    mReviews.mockResolvedValue([makeReview({ submitted_at: '2026-01-01T00:05:00Z' })]);
    mComments.mockResolvedValue([makeComment()]);
    await call();
    const body = mUpdateComment.mock.calls[0][3] as string;
    expect(body).not.toContain('10 min');
  });

  it('does not note quick approval when review took more than 10 min', async () => {
    mReviews.mockResolvedValue([makeReview({ submitted_at: '2026-01-01T00:30:00Z' })]);
    mComments.mockResolvedValue([]);
    await call();
    const body = mUpdateComment.mock.calls[0][3] as string;
    expect(body).not.toContain('10 min');
  });

  it('replaces an existing coverage section instead of appending a second one', async () => {
    mFindComment.mockResolvedValue({
      id: 99,
      body: '### AI Review\n\nFindings.\n\n---\n## Review Coverage\n\nOld data here.',
    });
    await call();
    const body = mUpdateComment.mock.calls[0][3] as string;
    const matches = body.match(/## Review Coverage/g) ?? [];
    expect(matches.length).toBe(1);
    expect(body).not.toContain('Old data here.');
  });

  it('includes the correct file coverage ratio', async () => {
    mFilenames.mockResolvedValue(['a.ts', 'b.ts', 'c.ts', 'd.ts']);
    mComments.mockResolvedValue([
      makeComment({ path: 'a.ts' }),
      makeComment({ path: 'b.ts' }),
    ]);
    await call();
    const body = mUpdateComment.mock.calls[0][3] as string;
    expect(body).toContain('2/4');
  });
});
