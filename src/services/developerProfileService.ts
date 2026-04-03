// Silently builds and maintains per-developer profiles in Pinecone
// Profiles accumulate across PRs to surface contribution patterns and strengths
// without exposing any of this data to developers in review comments

import { Pinecone } from '@pinecone-database/pinecone';
import { createEmbedding } from './vectorService';
import { logger } from './logger';
import type { ProcessedFile } from '../pipeline/extractDiff';
import type { PassResult } from '../pipeline/rankFindings';
import type { CodeValueResult } from '../pipeline/assessCodeValue';

const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY! });

// Stored as Pinecone metadata — all primitive types (arrays serialized as JSON strings)
interface DeveloperProfileMetadata {
  type: 'developer-profile';
  author: string;
  repo: string;
  prsAnalyzed: number;
  totalCodeValue: number;
  avgCodeValue: number;
  lastPrNumber: number;
  lastUpdated: string;
  topLanguages: string;       // JSON: Record<string, number> — ext → file count
  topAreas: string;           // JSON: Record<string, number> — directory → file count
  totalFindings: number;
  criticalFindings: number;
  highFindings: number;
  mediumFindings: number;
  lowFindings: number;
  totalLinesAdded: number;
  totalFilesChanged: number;
  avgComplexityScore: number;
  avgQuantityScore: number;
}

// Counts findings by severity across all ranked pass results
const countFindingsBySeverity = (ranked: PassResult[]) => {
  let critical = 0, high = 0, medium = 0, low = 0;
  for (const pass of ranked) {
    for (const finding of pass.findings) {
      const match = finding.match(/^-\s*\[(\w+)\]/i);
      const sev = match?.[1]?.toLowerCase() ?? '';
      if (sev === 'critical') critical++;
      else if (sev === 'high') high++;
      else if (sev === 'medium') medium++;
      else if (sev === 'low') low++;
    }
  }
  return { critical, high, medium, low };
};

// Merges new file extension counts into an existing frequency map
const mergeLanguageMap = (files: ProcessedFile[], existing: Record<string, number>): Record<string, number> => {
  const map = { ...existing };
  for (const f of files) {
    const ext = f.filename.split('.').pop()?.toLowerCase() ?? 'unknown';
    map[ext] = (map[ext] ?? 0) + 1;
  }
  return map;
};

// Merges new directory counts into an existing frequency map
const mergeAreaMap = (files: ProcessedFile[], existing: Record<string, number>): Record<string, number> => {
  const map = { ...existing };
  for (const f of files) {
    const idx = f.filename.lastIndexOf('/');
    const dir = idx > 0 ? f.filename.slice(0, idx) : '(root)';
    map[dir] = (map[dir] ?? 0) + 1;
  }
  return map;
};

// Returns the top N entries from a frequency map sorted by count descending
const topN = (map: Record<string, number>, n: number): Record<string, number> =>
  Object.fromEntries(
    Object.entries(map)
      .sort(([, a], [, b]) => b - a)
      .slice(0, n)
  );

// Derives human-readable strength descriptors from accumulated profile stats
const deriveStrengths = (
  meta: DeveloperProfileMetadata,
  topLanguages: Record<string, number>,
  topAreas: Record<string, number>,
): string[] => {
  const strengths: string[] = [];
  const { prsAnalyzed, criticalFindings, highFindings, avgComplexityScore, avgCodeValue } = meta;

  const criticalRate = prsAnalyzed > 0 ? (criticalFindings + highFindings) / prsAnalyzed : 0;
  if (criticalRate < 0.5) strengths.push('reliable code quality');
  if (avgCodeValue > 60) strengths.push('high-value contributions');
  if (avgComplexityScore > 50) strengths.push('tackles complex problems');

  const topLangKeys = Object.keys(topLanguages);
  if (topLangKeys.length === 1) strengths.push(`${topLangKeys[0]} specialist`);

  const topAreaKeys = Object.keys(topAreas);
  if (topAreaKeys.length === 1) strengths.push(`focuses on ${topAreaKeys[0]}`);

  return strengths;
};

// Builds a natural-language profile summary for embedding
// This text drives similarity search — "who works on auth?" etc
const buildProfileText = (
  meta: DeveloperProfileMetadata,
  topLanguages: Record<string, number>,
  topAreas: Record<string, number>,
): string => {
  const languages = Object.keys(topLanguages).join(', ') || 'unknown';
  const areas = Object.keys(topAreas).join(', ') || 'general';
  const strengths = deriveStrengths(meta, topLanguages, topAreas);

  return [
    `Developer ${meta.author} in repository ${meta.repo}.`,
    `Languages: ${languages}.`,
    `Primary areas: ${areas}.`,
    `${meta.prsAnalyzed} PRs analyzed, average code value ${Math.round(meta.avgCodeValue)}/100.`,
    strengths.length > 0 ? `Strengths: ${strengths.join(', ')}.` : '',
    `Findings: ${meta.criticalFindings} critical, ${meta.highFindings} high, ${meta.mediumFindings} medium, ${meta.lowFindings} low.`,
  ].filter(Boolean).join(' ');
};

// Stable vector ID for a developer's profile — one record per author per repo
const profileId = (author: string, repoFullName: string): string => {
  const safe = `${repoFullName}:${author}`.replace(/[^a-zA-Z0-9:_-]/g, '-');
  return `devprofile:${safe}`;
};

// Upserts a developer's profile after each PR analysis
// Fetches any existing profile, merges the new PR's stats into it, then re-embeds and stores
// All failures are swallowed — profiling must never block review delivery
export const updateDeveloperProfile = async (
  author: string,
  repoFullName: string,
  prNumber: number,
  codeValue: CodeValueResult,
  files: ProcessedFile[],
  ranked: PassResult[],
): Promise<void> => {
  if (!process.env.PINECONE_API_KEY || !process.env.PINECONE_INDEX_NAME) return;

  try {
    const index = pinecone.index(process.env.PINECONE_INDEX_NAME!);
    const id = profileId(author, repoFullName);

    // Load existing profile (may not exist for new developers)
    let existing: Partial<DeveloperProfileMetadata> = {};
    try {
      const fetched = await index.fetch({ ids: [id] });
      const record = (fetched.records as Record<string, { metadata?: unknown }>)?.[id];
      if (record?.metadata && typeof record.metadata === 'object') {
        existing = record.metadata as Partial<DeveloperProfileMetadata>;
      }
    } catch {
      // First PR for this developer — start from zero
    }

    // Merge language and area frequency maps
    const prevLangs: Record<string, number> = existing.topLanguages
      ? (JSON.parse(existing.topLanguages) as Record<string, number>)
      : {};
    const prevAreas: Record<string, number> = existing.topAreas
      ? (JSON.parse(existing.topAreas) as Record<string, number>)
      : {};

    const mergedLangs = topN(mergeLanguageMap(files, prevLangs), 10);
    const mergedAreas = topN(mergeAreaMap(files, prevAreas), 10);

    // Accumulate finding counts
    const findings = countFindingsBySeverity(ranked);
    const newTotalFindings = findings.critical + findings.high + findings.medium + findings.low;

    // Accumulate PR-level stats
    const prevPrs = existing.prsAnalyzed ?? 0;
    const prsAnalyzed = prevPrs + 1;
    const totalCodeValue = (existing.totalCodeValue ?? 0) + codeValue.codeValue;
    const avgCodeValue = totalCodeValue / prsAnalyzed;

    // Running weighted averages for complexity/quantity
    const avgComplexityScore = prevPrs > 0
      ? ((existing.avgComplexityScore ?? 0) * prevPrs + codeValue.complexityScore) / prsAnalyzed
      : codeValue.complexityScore;
    const avgQuantityScore = prevPrs > 0
      ? ((existing.avgQuantityScore ?? 0) * prevPrs + codeValue.quantityScore) / prsAnalyzed
      : codeValue.quantityScore;

    const meta: DeveloperProfileMetadata = {
      type: 'developer-profile',
      author,
      repo: repoFullName,
      prsAnalyzed,
      totalCodeValue,
      avgCodeValue: Math.round(avgCodeValue * 10) / 10,
      lastPrNumber: prNumber,
      lastUpdated: new Date().toISOString(),
      topLanguages: JSON.stringify(mergedLangs),
      topAreas: JSON.stringify(mergedAreas),
      totalFindings: (existing.totalFindings ?? 0) + newTotalFindings,
      criticalFindings: (existing.criticalFindings ?? 0) + findings.critical,
      highFindings: (existing.highFindings ?? 0) + findings.high,
      mediumFindings: (existing.mediumFindings ?? 0) + findings.medium,
      lowFindings: (existing.lowFindings ?? 0) + findings.low,
      totalLinesAdded: (existing.totalLinesAdded ?? 0) + codeValue.linesAdded,
      totalFilesChanged: (existing.totalFilesChanged ?? 0) + codeValue.filesChanged,
      avgComplexityScore: Math.round(avgComplexityScore * 10) / 10,
      avgQuantityScore: Math.round(avgQuantityScore * 10) / 10,
    };

    // Re-embed the updated profile text so similarity search stays current
    const profileText = buildProfileText(meta, mergedLangs, mergedAreas);
    const vector = await createEmbedding(profileText);

    await index.upsert({
      records: [{
        id,
        values: vector,
        metadata: meta as unknown as Record<string, string | number | boolean>,
      }],
    });

    logger.info(
      { author, repo: repoFullName, prNumber, codeValue: codeValue.codeValue, prsAnalyzed },
      'Developer profile updated',
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    logger.warn({ author, repo: repoFullName, message }, 'Developer profile update failed — continuing');
  }
};
