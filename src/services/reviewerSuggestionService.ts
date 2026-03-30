// Suggests reviewers for a PR by matching it against developer profiles stored in Pinecone.
// Only fires when 2+ other developers have contributed to the repo (enough data to choose from).
// Reviewer selection intentionally blends relevance with a growth boost so the same
// senior developer is not suggested on every PR.

import { Pinecone } from '@pinecone-database/pinecone';
import { createEmbedding } from './vectorService';
import { logger } from './logger';
import type { ProcessedFile } from '../pipeline/extractDiff';

const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY! });

interface ProfileCandidate {
  author: string;
  prsAnalyzed: number;
  topLanguages: Record<string, number>;
  topAreas: Record<string, number>;
  similarity: number; // raw Pinecone cosine score
}

// Builds a plain-text description of the PR's scope for embedding.
// Pinecone uses this to find developer profiles with matching language/area experience.
const describePR = (files: ProcessedFile[]): string => {
  const exts = [...new Set(files.map((f) => f.filename.split('.').pop()?.toLowerCase() ?? 'unknown'))];
  const dirs = [...new Set(
    files.map((f) => {
      const idx = f.filename.lastIndexOf('/');
      return idx > 0 ? f.filename.slice(0, idx) : '(root)';
    })
  )];
  return `Pull request touching files in: ${dirs.join(', ')}. Languages: ${exts.join(', ')}.`;
};

// Blends Pinecone similarity (relevance) with a growth boost (inverse of experience).
// Less-experienced developers get a boost so review load spreads and skills grow.
export const scoreCandidate = (similarity: number, prsAnalyzed: number, maxPrs: number): number => {
  const growthBoost = maxPrs > 0 ? 1 - prsAnalyzed / maxPrs : 0;
  return similarity * 0.7 + growthBoost * 0.3;
};

// Formats a one-line reason for a reviewer suggestion.
const formatReason = (candidate: ProfileCandidate): string => {
  const parts: string[] = [];
  const topArea = Object.keys(candidate.topAreas)[0];
  const topLang = Object.keys(candidate.topLanguages)[0];
  if (topArea) parts.push(`works in \`${topArea}\``);
  if (topLang && topLang !== 'unknown') parts.push(`${topLang} experience`);
  if (candidate.prsAnalyzed <= 3) parts.push('growth opportunity');
  return parts.length > 0 ? parts.join(', ') : `${candidate.prsAnalyzed} PRs analyzed`;
};

// Returns a Markdown reviewer-suggestion block to append to the PR summary,
// or an empty string if there is not enough profile data to make a suggestion.
export const suggestReviewers = async (
  repoFullName: string,
  prAuthor: string,
  files: ProcessedFile[],
): Promise<string> => {
  if (!process.env.PINECONE_API_KEY || !process.env.PINECONE_INDEX_NAME) return '';

  try {
    const index = pinecone.index(process.env.PINECONE_INDEX_NAME);

    // Embed a description of the PR so the query returns semantically similar dev profiles.
    const vector = await createEmbedding(describePR(files));

    const response = await index.query({
      vector,
      topK: 20,
      includeMetadata: true,
      filter: { type: { $eq: 'developer-profile' }, repo: { $eq: repoFullName } },
    });

    // Parse metadata into candidate objects, excluding the PR author.
    const candidates: ProfileCandidate[] = [];
    for (const match of response.matches ?? []) {
      const meta = match.metadata as Record<string, unknown> | undefined;
      if (!meta) continue;
      const author = String(meta.author ?? '');
      if (!author || author === prAuthor) continue;
      candidates.push({
        author,
        prsAnalyzed: Number(meta.prsAnalyzed ?? 0),
        topLanguages: (() => { try { return JSON.parse(String(meta.topLanguages ?? '{}')); } catch { return {}; } })(),
        topAreas: (() => { try { return JSON.parse(String(meta.topAreas ?? '{}')); } catch { return {}; } })(),
        similarity: match.score ?? 0,
      });
    }

    // Require at least 2 non-author developers before making a suggestion.
    if (candidates.length < 2) return '';

    const maxPrs = Math.max(...candidates.map((c) => c.prsAnalyzed));

    const top = candidates
      .map((c) => ({ ...c, finalScore: scoreCandidate(c.similarity, c.prsAnalyzed, maxPrs) }))
      .sort((a, b) => b.finalScore - a.finalScore)
      .slice(0, 2);

    const bullets = top.map((c) => `- **${c.author}** — ${formatReason(c)}`);

    return `\n\n---\n\n### 👥 Suggested Reviewers\n\n${bullets.join('\n')}`;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    logger.warn({ repo: repoFullName, message }, 'Reviewer suggestion failed — continuing without suggestion');
    return '';
  }
};
