// LOCAL-ONLY cold-start script — indexes every tracked file in the repo into Pinecone.
// For ongoing ingestion, the server handles `push` webhook events automatically
// Usage: npx ts-node src/scripts/ingestRepo.ts [--dry-run]

import 'dotenv/config';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { createEmbedding, storeEmbedding } from '../services/vectorService';
import { logger } from '../services/logger';

// Maximum content stored in Pinecone metadata per record (Pinecone 40KB limit)
const MAX_CONTENT_CHARS = 2000;

// Concurrency limit to avoid hitting OpenAI rate limits
const CONCURRENCY = 5;

// Binary / non-textual extensions to skip
const SKIP_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp',
  '.woff', '.woff2', '.ttf', '.eot',
  '.zip', '.tar', '.gz', '.tgz',
  '.pdf', '.mp3', '.mp4', '.mov',
  '.lock', '.pem',
]);

// Paths that should never be indexed
const SKIP_PATHS = ['node_modules', 'dist', '.git', '.env'];

const isDryRun = process.argv.includes('--dry-run');

const shouldSkip = (filePath: string): boolean => {
  const ext = path.extname(filePath).toLowerCase();
  if (SKIP_EXTENSIONS.has(ext)) return true;
  return SKIP_PATHS.some((skip) => filePath.startsWith(skip) || filePath.includes(`/${skip}/`) || filePath.includes(`\\${skip}\\`));
};

// Reads file content safely, returning null for binary or unreadable files
const readFileSafe = (filePath: string): string | null => {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    // Simple binary detection: if the first 8KB has null bytes, skip it
    if (content.slice(0, 8192).includes('\0')) return null;
    return content;
  } catch {
    return null;
  }
};

// Processes a batch of files with bounded concurrency
const processBatch = async (
  files: string[],
  handler: (file: string) => Promise<void>,
  concurrency: number
): Promise<void> => {
  let index = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (index < files.length) {
      const current = index++;
      await handler(files[current]);
    }
  });
  await Promise.all(workers);
};

const main = async () => {
  logger.info('--- Prism AI Repo Ingestion ---');

  if (!process.env.OPENAI_API_KEY || !process.env.PINECONE_API_KEY || !process.env.PINECONE_INDEX_NAME) {
    logger.error('Missing required env vars: OPENAI_API_KEY, PINECONE_API_KEY, PINECONE_INDEX_NAME');
    process.exit(1);
  }

  // Use git ls-files to respect .gitignore
  const tracked = execSync('git ls-files', { encoding: 'utf-8' })
    .split('\n')
    .map((f) => f.trim())
    .filter((f) => f.length > 0)
    .filter((f) => !shouldSkip(f));

  logger.info({ fileCount: tracked.length }, 'Found indexable files');

  if (isDryRun) {
    tracked.forEach((f) => logger.info(`  [dry-run] ${f}`));
    logger.info(`Dry run complete — ${tracked.length} files would be indexed.`);
    return;
  }

  let indexed = 0;
  let skipped = 0;
  let failed = 0;

  await processBatch(tracked, async (filePath) => {
    const content = readFileSafe(filePath);
    if (!content || content.trim().length === 0) {
      skipped++;
      return;
    }

    const truncated = content.slice(0, MAX_CONTENT_CHARS);

    try {
      const embedding = await createEmbedding(truncated);
      await storeEmbedding(`repo-${filePath}`, embedding, {
        filename: filePath,
        content: truncated,
        source: 'ingestion',
      });
      indexed++;
      logger.info(`  [${indexed}] ${filePath}`);
    } catch (err: unknown) {
      failed++;
      const msg = err instanceof Error ? err.message : 'Unknown error';
      logger.error(`  [FAIL] ${filePath}: ${msg}`);
    }
  }, CONCURRENCY);

  logger.info(`\nDone: ${indexed} indexed, ${skipped} skipped, ${failed} failed`);
};

main().catch((err) => {
  logger.error({ err }, 'Ingestion failed');
  process.exit(1);
});
