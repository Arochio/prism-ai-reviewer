import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Pinecone mock ─────────────────────────────────────────────────────────────
const mockQuery = vi.hoisted(() => vi.fn());

vi.mock('@pinecone-database/pinecone', () => {
  class MockPinecone {
    index(_name: string) {
      return { query: mockQuery };
    }
    constructor(_opts?: unknown) {}
  }
  return { Pinecone: MockPinecone };
});

vi.mock('../../src/services/vectorService', () => ({
  createEmbedding: vi.fn().mockResolvedValue(new Array(1536).fill(0)),
}));

vi.mock('../../src/services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { suggestReviewers, scoreCandidate } from '../../src/services/reviewerSuggestionService';
import type { ProcessedFile } from '../../src/pipeline/extractDiff';

const makeFile = (filename: string): ProcessedFile => ({
  filename,
  status: 'modified',
  content: 'const x = 1;',
  patch: '+const x = 1;',
  similarText: '',
  embedding: null,
});

const makeProfile = (author: string, prsAnalyzed: number, overrides: Record<string, unknown> = {}) => ({
  metadata: {
    type: 'developer-profile',
    author,
    repo: 'owner/repo',
    prsAnalyzed,
    topLanguages: JSON.stringify({ ts: prsAnalyzed }),
    topAreas: JSON.stringify({ 'src/services': prsAnalyzed }),
    ...overrides,
  },
  score: 0.8,
});

const FILES = [makeFile('src/services/foo.ts'), makeFile('src/pipeline/bar.ts')];
const REPO = 'owner/repo';
const AUTHOR = 'alice';

describe('scoreCandidate', () => {
  it('returns pure similarity when all candidates have equal experience', () => {
    expect(scoreCandidate(0.8, 5, 5)).toBeCloseTo(0.8 * 0.7, 5);
  });

  it('gives a growth boost to a developer with fewer PRs', () => {
    const senior = scoreCandidate(0.8, 10, 10);   // no growth boost
    const junior = scoreCandidate(0.8, 1, 10);    // growth boost
    expect(junior).toBeGreaterThan(senior);
  });

  it('weights relevance 70% and growth 30% correctly', () => {
    // similarity=0.6, prsAnalyzed=0, maxPrs=10 → growthBoost=1
    const score = scoreCandidate(0.6, 0, 10);
    expect(score).toBeCloseTo(0.6 * 0.7 + 1.0 * 0.3, 5);
  });

  it('returns zero when similarity is zero and no growth boost', () => {
    expect(scoreCandidate(0, 5, 5)).toBe(0);
  });

  it('handles maxPrs=0 without dividing by zero', () => {
    expect(() => scoreCandidate(0.5, 0, 0)).not.toThrow();
  });
});

describe('suggestReviewers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PINECONE_API_KEY = 'test-key';
    process.env.PINECONE_INDEX_NAME = 'test-index';
  });

  it('returns empty string when PINECONE_API_KEY is missing', async () => {
    delete process.env.PINECONE_API_KEY;
    const result = await suggestReviewers(REPO, AUTHOR, FILES);
    expect(result).toBe('');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns empty string when PINECONE_INDEX_NAME is missing', async () => {
    delete process.env.PINECONE_INDEX_NAME;
    const result = await suggestReviewers(REPO, AUTHOR, FILES);
    expect(result).toBe('');
  });

  it('returns empty string when fewer than 2 non-author candidates exist', async () => {
    mockQuery.mockResolvedValue({ matches: [makeProfile('bob', 5)] });
    const result = await suggestReviewers(REPO, AUTHOR, FILES);
    expect(result).toBe('');
  });

  it('excludes the PR author from suggestions', async () => {
    mockQuery.mockResolvedValue({
      matches: [
        makeProfile(AUTHOR, 8), // should be excluded
        makeProfile('bob', 5),
        makeProfile('carol', 3),
      ],
    });
    const result = await suggestReviewers(REPO, AUTHOR, FILES);
    expect(result).not.toContain(AUTHOR);
    expect(result).toContain('bob');
    expect(result).toContain('carol');
  });

  it('returns a suggestion block with 2 candidates when 2+ profiles exist', async () => {
    mockQuery.mockResolvedValue({
      matches: [makeProfile('bob', 5), makeProfile('carol', 3)],
    });
    const result = await suggestReviewers(REPO, AUTHOR, FILES);
    expect(result).toContain('### 👥 Suggested Reviewers');
    expect(result).toContain('**bob**');
    expect(result).toContain('**carol**');
  });

  it('suggests at most 2 reviewers even when many profiles exist', async () => {
    mockQuery.mockResolvedValue({
      matches: [
        makeProfile('bob', 5),
        makeProfile('carol', 3),
        makeProfile('dave', 7),
        makeProfile('eve', 2),
      ],
    });
    const result = await suggestReviewers(REPO, AUTHOR, FILES);
    const bulletCount = (result.match(/^- \*\*/gm) ?? []).length;
    expect(bulletCount).toBeLessThanOrEqual(2);
  });

  it('favours a growth candidate with similar relevance over a more experienced one', async () => {
    // junior has prsAnalyzed=1 (gets growth boost), senior has prsAnalyzed=10 (no boost)
    // Both have the same Pinecone similarity score
    mockQuery.mockResolvedValue({
      matches: [
        { ...makeProfile('senior', 10), score: 0.7 },
        { ...makeProfile('junior', 1), score: 0.7 },
      ],
    });
    const result = await suggestReviewers(REPO, AUTHOR, FILES);
    const juniorIdx = result.indexOf('junior');
    const seniorIdx = result.indexOf('senior');
    expect(juniorIdx).toBeGreaterThan(-1);
    expect(seniorIdx).toBeGreaterThan(-1);
    // junior should appear before senior (higher score)
    expect(juniorIdx).toBeLessThan(seniorIdx);
  });

  it('prefers higher-relevance candidate over growth when relevance gap is large', async () => {
    mockQuery.mockResolvedValue({
      matches: [
        { ...makeProfile('expert', 10), score: 0.95 },   // very relevant, experienced
        { ...makeProfile('newbie', 0), score: 0.1 },     // low relevance, growth boost
      ],
    });
    const result = await suggestReviewers(REPO, AUTHOR, FILES);
    const expertIdx = result.indexOf('expert');
    const newbieIdx = result.indexOf('newbie');
    expect(expertIdx).toBeLessThan(newbieIdx);
  });

  it('includes a separator and section header in the output', async () => {
    mockQuery.mockResolvedValue({
      matches: [makeProfile('bob', 5), makeProfile('carol', 3)],
    });
    const result = await suggestReviewers(REPO, AUTHOR, FILES);
    expect(result).toContain('---');
    expect(result).toContain('### 👥 Suggested Reviewers');
  });

  it('returns empty string and does not throw when Pinecone query fails', async () => {
    mockQuery.mockRejectedValue(new Error('Pinecone down'));
    const result = await suggestReviewers(REPO, AUTHOR, FILES);
    expect(result).toBe('');
  });
});
