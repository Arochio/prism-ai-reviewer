import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock vectorService to avoid requiring OPENAI_API_KEY at import time.
vi.mock('../../src/services/vectorService', () => ({
  createEmbedding: vi.fn().mockResolvedValue(new Array(1536).fill(0)),
  storeEmbedding: vi.fn().mockResolvedValue(undefined),
  querySimilar: vi.fn().mockResolvedValue([]),
}));

import { buildChurnMap, buildRepoProfile, type BootstrapProfile } from '../../src/services/bootstrapService';
import type { MergedPRSummary } from '../../src/services/githubService';

const makePR = (overrides: Partial<MergedPRSummary> = {}): MergedPRSummary => ({
  number: 1,
  title: 'Test PR',
  filesChanged: 3,
  additions: 100,
  deletions: 50,
  mergedAt: '2026-03-20T12:00:00Z',
  author: 'alice',
  changedFiles: ['src/index.ts', 'src/utils.ts', 'README.md'],
  ...overrides,
});

describe('buildChurnMap', () => {
  it('counts file occurrences across PRs', () => {
    const prs = [
      makePR({ changedFiles: ['a.ts', 'b.ts'] }),
      makePR({ changedFiles: ['b.ts', 'c.ts'] }),
      makePR({ changedFiles: ['b.ts'] }),
    ];
    const churn = buildChurnMap(prs);
    expect(churn.get('a.ts')).toBe(1);
    expect(churn.get('b.ts')).toBe(3);
    expect(churn.get('c.ts')).toBe(1);
  });

  it('returns empty map for no PRs', () => {
    const churn = buildChurnMap([]);
    expect(churn.size).toBe(0);
  });

  it('handles PRs with no changed files', () => {
    const prs = [makePR({ changedFiles: [] })];
    const churn = buildChurnMap(prs);
    expect(churn.size).toBe(0);
  });
});

describe('buildRepoProfile', () => {
  it('computes average files per PR', () => {
    const prs = [
      makePR({ filesChanged: 4 }),
      makePR({ filesChanged: 6 }),
    ];
    const profile = buildRepoProfile(prs, 100);
    expect(profile.avgFilesPerPR).toBe(5);
    expect(profile.totalMergedPRs).toBe(2);
    expect(profile.repoSizeFiles).toBe(100);
  });

  it('identifies top contributors', () => {
    const prs = [
      makePR({ author: 'alice' }),
      makePR({ author: 'alice' }),
      makePR({ author: 'bob' }),
      makePR({ author: 'alice' }),
      makePR({ author: 'charlie' }),
      makePR({ author: 'charlie' }),
    ];
    const profile = buildRepoProfile(prs, 50);
    expect(profile.topContributors[0]).toBe('alice');
    expect(profile.topContributors[1]).toBe('charlie');
    expect(profile.topContributors[2]).toBe('bob');
  });

  it('identifies hot files from changed file data', () => {
    const prs = [
      makePR({ changedFiles: ['hot.ts', 'cold.ts'] }),
      makePR({ changedFiles: ['hot.ts'] }),
      makePR({ changedFiles: ['hot.ts'] }),
    ];
    const profile = buildRepoProfile(prs, 20);
    expect(profile.hotFiles[0]).toBe('hot.ts');
  });

  it('handles empty PR list gracefully', () => {
    const profile = buildRepoProfile([], 0);
    expect(profile.totalMergedPRs).toBe(0);
    expect(profile.avgFilesPerPR).toBe(0);
    expect(profile.topContributors).toEqual([]);
    expect(profile.hotFiles).toEqual([]);
  });

  it('limits top contributors to 5', () => {
    const authors = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const prs = authors.map((author) => makePR({ author }));
    const profile = buildRepoProfile(prs, 10);
    expect(profile.topContributors.length).toBeLessThanOrEqual(5);
  });

  it('limits hot files to 10', () => {
    const files = Array.from({ length: 15 }, (_, i) => `file${i}.ts`);
    const prs = files.map((f) => makePR({ changedFiles: [f] }));
    const profile = buildRepoProfile(prs, 100);
    expect(profile.hotFiles.length).toBeLessThanOrEqual(10);
  });
});
