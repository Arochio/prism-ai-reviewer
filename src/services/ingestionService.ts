import * as path from 'path';
import { fetchRepoFileContents } from './githubService';
import { createEmbedding, storeEmbedding } from './vectorService';
import { logger } from './logger';

// Maximum content stored in Pinecone metadata per record (Pinecone 40KB limit).
const MAX_CONTENT_CHARS = 2000;

// Concurrency limit to avoid hitting OpenAI embedding rate limits.
const CONCURRENCY = 5;

// Binary / non-textual extensions to skip.
const SKIP_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp',
  '.woff', '.woff2', '.ttf', '.eot',
  '.zip', '.tar', '.gz', '.tgz',
  '.pdf', '.mp3', '.mp4', '.mov',
  '.lock', '.pem',
]);

// Paths that should never be indexed.
const SKIP_PATHS = ['node_modules', 'dist', '.git', '.env'];

const shouldSkip = (filePath: string): boolean => {
  const ext = path.extname(filePath).toLowerCase();
  if (SKIP_EXTENSIONS.has(ext)) return true;
  return SKIP_PATHS.some(
    (skip) =>
      filePath === skip ||
      filePath.startsWith(`${skip}/`) ||
      filePath.includes(`/${skip}/`)
  );
};

// Processes a batch of items with bounded concurrency.
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

export interface PushFileChange {
  added: string[];
  removed: string[];
  modified: string[];
}

// Ingests changed files from a push event into Pinecone.
// Fetches file contents via the GitHub API using installation tokens,
// so no secrets are needed in the target repo.
export const ingestPushChanges = async (
  owner: string,
  repo: string,
  ref: string,
  changes: PushFileChange,
  installationId: number,
): Promise<{ indexed: number; removed: number; skipped: number; failed: number }> => {
  const stats = { indexed: 0, removed: 0, skipped: 0, failed: 0 };

  // Deduplicate: a file may appear in multiple commits within one push.
  const toUpsert = [...new Set([...changes.added, ...changes.modified])].filter(
    (f) => !shouldSkip(f),
  );
  const toRemove = [...new Set(changes.removed)].filter((f) => !shouldSkip(f));

  logger.info(
    { owner, repo, upsertCount: toUpsert.length, removeCount: toRemove.length },
    'Ingesting push changes',
  );

  // Remove deleted files from Pinecone.
  if (toRemove.length > 0) {
    const { Pinecone } = await import('@pinecone-database/pinecone');
    try {
      const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY! });
      const index = pinecone.index(process.env.PINECONE_INDEX_NAME!);
      const ids = toRemove.map((f) => `repo:${owner}/${repo}:${f}`);
      await index.deleteMany(ids);
      stats.removed = toRemove.length;
      logger.info({ count: toRemove.length }, 'Removed deleted files from Pinecone');
    } catch (err: unknown) {
      logger.error(
        { message: err instanceof Error ? err.message : 'Unknown error' },
        'Failed to remove deleted files from Pinecone',
      );
    }
  }

  if (toUpsert.length === 0) return stats;

  // Fetch file contents from GitHub in one batch.
  const fileContents = await fetchRepoFileContents(
    owner,
    repo,
    ref,
    toUpsert,
    installationId,
  );

  // Build embedding + upsert for each file.
  await processBatch(
    fileContents,
    async ({ path: filePath, content }) => {
      if (!content || content.trim().length === 0) {
        stats.skipped++;
        return;
      }

      const truncated = content.slice(0, MAX_CONTENT_CHARS);
      try {
        const embedding = await createEmbedding(truncated);
        await storeEmbedding(`repo:${owner}/${repo}:${filePath}`, embedding, {
          filename: filePath,
          content: truncated,
          source: 'push-ingestion',
          repo: `${owner}/${repo}`,
        }, installationId);
        stats.indexed++;
        logger.info({ filePath }, 'Indexed file');
      } catch (err: unknown) {
        stats.failed++;
        logger.error(
          { filePath, message: err instanceof Error ? err.message : 'Unknown error' },
          'Failed to index file',
        );
      }
    },
    CONCURRENCY,
  );

  logger.info(stats, 'Push ingestion complete');
  return stats;
};
