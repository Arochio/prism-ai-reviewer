// Retroactive repo scanning — seeds Prism's knowledge base on first PR for a new repo
// Runs in the background so the first review is not delayed
// Scans metadata from recent merged PRs and ingests key repo files into Pinecone

import { getCachedOpenAIResponse, setCachedOpenAIResponse } from './cacheService';
import { fetchMergedPRs, fetchRepoTree, fetchRepoFileContents, type MergedPRSummary, type GitHubTreeEntry } from './githubService';
import { createEmbedding, storeEmbedding } from './vectorService';
import { openAIConfig } from '../config/openai.config';
import { logger } from './logger';

// Redis key prefix for bootstrap status flags
const BOOTSTRAP_KEY_PREFIX = 'prism:bootstrap:';

// Maximum number of key files to ingest into Pinecone during bootstrap
const MAX_FILES_TO_INGEST = 50;

// Maximum content stored per Pinecone record (Pinecone 40KB metadata limit)
const MAX_CONTENT_CHARS = 2000;

// Embedding concurrency to stay within OpenAI rate limits
const CONCURRENCY = 5;

// File extensions considered high-value for RAG context
const KEY_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.rb',
  '.cs', '.c', '.cpp', '.h', '.hpp', '.swift', '.kt',
  '.md', '.yml', '.yaml', '.json', '.toml',
]);

// Files that are especially useful for understanding a repo
const PRIORITY_FILENAMES = new Set([
  'readme.md', 'readme', 'contributing.md', 'architecture.md',
  'package.json', 'tsconfig.json', 'pyproject.toml', 'cargo.toml',
  'go.mod', 'gemfile', 'pom.xml', 'build.gradle',
  '.eslintrc.js', '.eslintrc.json', 'eslint.config.mjs', 'eslint.config.mts',
  '.prism-rules',
]);

// Paths that should never be indexed
const SKIP_PATHS = ['node_modules', 'dist', '.git', '.env', 'vendor', '__pycache__', '.next', 'build'];

const shouldSkipPath = (filePath: string): boolean =>
  SKIP_PATHS.some(
    (skip) => filePath === skip || filePath.startsWith(`${skip}/`) || filePath.includes(`/${skip}/`),
  );

// Checks if a repo has already been bootstrapped
export const isBootstrapped = async (owner: string, repo: string, installationId?: number): Promise<boolean> => {
  const key = `${BOOTSTRAP_KEY_PREFIX}${owner}/${repo}`;
  const cached = await getCachedOpenAIResponse(key, installationId);
  return cached !== null;
};

// Marks a repo as bootstrapped. TTL is 30 days — after that, a re-bootstrap can occur
const markBootstrapped = async (owner: string, repo: string, installationId?: number): Promise<void> => {
  const key = `${BOOTSTRAP_KEY_PREFIX}${owner}/${repo}`;
  await setCachedOpenAIResponse(key, JSON.stringify({ bootstrappedAt: new Date().toISOString() }), installationId);
};

// Scores a file tree entry for ingestion priority. Higher = more important
const fileIngestionPriority = (entry: GitHubTreeEntry, hotFiles: Map<string, number>): number => {
  const name = entry.path.split('/').pop()?.toLowerCase() ?? '';
  let score = 0;

  // Priority filenames get highest score
  if (PRIORITY_FILENAMES.has(name)) score += 100;

  // Key extension check
  const ext = name.includes('.') ? '.' + name.split('.').pop() : '';
  if (KEY_EXTENSIONS.has(ext)) score += 10;
  else return 0; // skip non-key files entirely

  // Files frequently changed in merged PRs are more valuable
  const churn = hotFiles.get(entry.path) ?? 0;
  score += Math.min(churn * 5, 50);

  // Prefer smaller files (more likely to be interfaces/configs)
  if (entry.size && entry.size < 5000) score += 10;
  if (entry.size && entry.size > 50000) score -= 20;

  // Top-level files are more valuable than deeply nested ones
  const depth = entry.path.split('/').length;
  if (depth <= 2) score += 15;
  if (depth <= 3) score += 5;

  return score;
};

// Builds a file churn map from merged PR data
export const buildChurnMap = (mergedPRs: MergedPRSummary[]): Map<string, number> => {
  const churn = new Map<string, number>();
  for (const pr of mergedPRs) {
    for (const file of pr.changedFiles) {
      churn.set(file, (churn.get(file) ?? 0) + 1);
    }
  }
  return churn;
};

// Builds a summary of the repo's recent PR history for logging and diagnostics
export interface BootstrapProfile {
  totalMergedPRs: number;
  avgFilesPerPR: number;
  topContributors: string[];
  hotFiles: string[];
  repoSizeFiles: number;
}

export const buildRepoProfile = (mergedPRs: MergedPRSummary[], treeSize: number): BootstrapProfile => {
  const avgFiles = mergedPRs.length > 0
    ? Math.round(mergedPRs.reduce((sum, pr) => sum + pr.filesChanged, 0) / mergedPRs.length)
    : 0;

  // Count contributions per author
  const authorCounts = new Map<string, number>();
  for (const pr of mergedPRs) {
    authorCounts.set(pr.author, (authorCounts.get(pr.author) ?? 0) + 1);
  }
  const topContributors = [...authorCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([author]) => author);

  const churn = buildChurnMap(mergedPRs);
  const hotFiles = [...churn.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([file]) => file);

  return {
    totalMergedPRs: mergedPRs.length,
    avgFilesPerPR: avgFiles,
    topContributors,
    hotFiles,
    repoSizeFiles: treeSize,
  };
};

// Processes a batch of items with bounded concurrency
const processBatch = async <T>(
  items: T[],
  handler: (item: T) => Promise<void>,
  concurrency: number,
): Promise<void> => {
  let index = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (index < items.length) {
      const current = index++;
      await handler(items[current]);
    }
  });
  await Promise.all(workers);
};

// Runs the full retroactive bootstrap for a repo:
//
// 1. Checks if already bootstrapped (Redis flag)
// 2. Fetches ~100 recently merged PRs and extracts metadata
// 3. Fetches the repo file tree and selects high-value files
// 4. Ingests selected files into Pinecone as RAG context
// 5. Marks the repo as bootstrapped
//
// All errors are caught and logged — bootstrap never blocks a review
export const bootstrapRepo = async (
  owner: string,
  repo: string,
  headSha: string,
  installationId: number,
): Promise<void> => {
  const repoKey = `${owner}/${repo}`;

  // Already bootstrapped?
  if (await isBootstrapped(owner, repo, installationId)) {
    logger.debug({ repo: repoKey }, 'Repo already bootstrapped — skipping');
    return;
  }

  logger.info({ repo: repoKey }, 'Starting retroactive repo bootstrap');

  // Step 1: Fetch merged PR history.
  let mergedPRs: MergedPRSummary[];
  try {
    mergedPRs = await fetchMergedPRs(owner, repo, installationId, 100);
  } catch (err: unknown) {
    logger.error({ repo: repoKey, message: err instanceof Error ? err.message : 'Unknown error' },
      'Failed to fetch merged PRs during bootstrap');
    return;
  }

  logger.info({ repo: repoKey, mergedPRCount: mergedPRs.length }, 'Fetched merged PR history');

  // Step 2: Fetch repo file tree.
  let tree: GitHubTreeEntry[];
  try {
    tree = await fetchRepoTree(owner, repo, headSha, installationId);
  } catch (err: unknown) {
    logger.error({ repo: repoKey, message: err instanceof Error ? err.message : 'Unknown error' },
      'Failed to fetch repo tree during bootstrap');
    return;
  }

  // Step 3: Score and select files for ingestion.
  const churnMap = buildChurnMap(mergedPRs);
  const blobEntries = tree.filter(
    (e) => e.type === 'blob' && !shouldSkipPath(e.path),
  );
  const scored = blobEntries
    .map((entry) => ({ entry, score: fileIngestionPriority(entry, churnMap) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_FILES_TO_INGEST);

  const profile = buildRepoProfile(mergedPRs, blobEntries.length);
  logger.info({
    repo: repoKey,
    totalFiles: blobEntries.length,
    selectedFiles: scored.length,
    ...profile,
  }, 'Repo profile computed');

  // Step 4: Ingest selected files into Pinecone.
  if (openAIConfig.enableEmbeddings && scored.length > 0) {
    const filePaths = scored.map((s) => s.entry.path);
    let fileContents: { path: string; content: string | null }[];
    try {
      fileContents = await fetchRepoFileContents(owner, repo, headSha, filePaths, installationId);
    } catch (err: unknown) {
      logger.error({ repo: repoKey, message: err instanceof Error ? err.message : 'Unknown error' },
        'Failed to fetch file contents during bootstrap');
      // Still mark as bootstrapped so we don't retry endlessly
      await markBootstrapped(owner, repo, installationId);
      return;
    }

    let indexed = 0;
    let skipped = 0;
    let failed = 0;

    await processBatch(
      fileContents,
      async ({ path: filePath, content }) => {
        if (!content || content.trim().length === 0) {
          skipped++;
          return;
        }

        const truncated = content.slice(0, MAX_CONTENT_CHARS);
        try {
          const embedding = await createEmbedding(truncated);
          await storeEmbedding(`repo:${owner}/${repo}:${filePath}`, embedding, {
            filename: filePath,
            content: truncated,
            source: 'bootstrap',
            repo: `${owner}/${repo}`,
          }, installationId);
          indexed++;
        } catch (err: unknown) {
          failed++;
          logger.error({ filePath, message: err instanceof Error ? err.message : 'Unknown error' },
            'Failed to index file during bootstrap');
        }
      },
      CONCURRENCY,
    );

    logger.info({ repo: repoKey, indexed, skipped, failed }, 'Bootstrap file ingestion complete');
  }

  // Step 5: Mark repo as bootstrapped
  await markBootstrapped(owner, repo, installationId);
  logger.info({ repo: repoKey }, 'Repo bootstrap complete');
};
