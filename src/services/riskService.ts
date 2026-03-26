// Computes a PR risk score from git history signals and changed file characteristics.
// The score drives dynamic review intensity — not dashboards or manager reports.
import { fetchFileCommitStats, type FileCommitStats } from './githubService';
import { logger } from './logger';

export type RiskLevel = 'low' | 'moderate' | 'elevated' | 'high';

export interface FileRisk {
  path: string;
  churnScore: number;       // 0-100 based on recent commit frequency
  multiAuthor: boolean;      // touched by 3+ authors recently
  hotspot: boolean;          // top-quartile churn in this PR
  commitCount: number;
}

export interface PRRiskAssessment {
  level: RiskLevel;
  score: number;             // 0-100 composite
  fileRisks: FileRisk[];
  signals: string[];         // human-readable signal descriptions for prompt injection
  recommendations: string[]; // suggestions surfaced in the review footer
}

// Thresholds (commits in 90 days)
const CHURN_HIGH = 15;       // file changed 15+ times in 90 days = high churn
const CHURN_MODERATE = 8;
const MULTI_AUTHOR_THRESHOLD = 3;

// PR-level weights
const WEIGHT_CHURN = 0.35;
const WEIGHT_SIZE = 0.25;
const WEIGHT_SPREAD = 0.20;
const WEIGHT_TIMING = 0.20;

// Converts a file's commit count into a 0-100 churn score.
const churnScore = (commitCount: number): number =>
  Math.min(100, Math.round((commitCount / CHURN_HIGH) * 100));

// Scores PR size: more files and larger diffs = higher risk.
const sizeScore = (fileCount: number): number => {
  if (fileCount <= 2) return 10;
  if (fileCount <= 5) return 30;
  if (fileCount <= 10) return 60;
  if (fileCount <= 20) return 80;
  return 100;
};

// Scores directory spread: files touching many different directories = harder to review.
const spreadScore = (filePaths: string[]): number => {
  const dirs = new Set(
    filePaths.map((p) => {
      const idx = p.lastIndexOf('/');
      return idx > 0 ? p.slice(0, idx) : '(root)';
    })
  );
  if (dirs.size <= 1) return 10;
  if (dirs.size <= 3) return 30;
  if (dirs.size <= 5) return 60;
  return 90;
};

// Scores timing risk: late-week or late-day PRs correlate with higher regression rates.
const timingScore = (): number => {
  const now = new Date();
  const day = now.getUTCDay();   // 0=Sun, 5=Fri, 6=Sat
  const hour = now.getUTCHours();

  let score = 0;
  // Friday or weekend
  if (day === 5) score += 40;
  if (day === 0 || day === 6) score += 30;
  // Late day (after 16:00 UTC)
  if (hour >= 16) score += 30;
  if (hour >= 20) score += 20;

  return Math.min(100, score);
};

const levelFromScore = (score: number): RiskLevel => {
  if (score >= 70) return 'high';
  if (score >= 50) return 'elevated';
  if (score >= 30) return 'moderate';
  return 'low';
};

// Builds human-readable signals injected into analysis prompts.
const buildSignals = (
  fileRisks: FileRisk[],
  fileCount: number,
  dirSpread: number,
  timing: number
): string[] => {
  const signals: string[] = [];

  const hotspots = fileRisks.filter((f) => f.hotspot);
  if (hotspots.length > 0) {
    signals.push(
      `High-churn files (changed ${CHURN_MODERATE}+ times in 90 days): ${hotspots.map((f) => f.path).join(', ')}. ` +
      'These files have historically been error-prone — review changes here with extra care.'
    );
  }

  const multiAuthor = fileRisks.filter((f) => f.multiAuthor);
  if (multiAuthor.length > 0) {
    signals.push(
      `Files with many recent contributors: ${multiAuthor.map((f) => f.path).join(', ')}. ` +
      'Multiple authors working on the same file increases the risk of conflicting assumptions.'
    );
  }

  if (fileCount > 10) {
    signals.push(
      `This PR touches ${fileCount} files — large PRs are harder to review thoroughly. ` +
      'Pay special attention to cross-file interactions.'
    );
  }

  if (dirSpread >= 60) {
    signals.push(
      'Changes span many directories. Verify that changes in different areas are consistent with each other.'
    );
  }

  if (timing >= 50) {
    signals.push(
      'This PR was submitted late in the week/day. Statistically, late-week changes carry higher regression risk — be thorough.'
    );
  }

  return signals;
};

// Builds actionable recommendations for the review footer (visible to the PR author).
const buildRecommendations = (
  fileRisks: FileRisk[],
  fileCount: number,
  level: RiskLevel
): string[] => {
  const recs: string[] = [];

  if (fileCount > 10) {
    recs.push(
      '📦 **Consider splitting** — This PR modifies many files. Smaller, focused PRs are easier to review and safer to merge.'
    );
  }

  const hotspots = fileRisks.filter((f) => f.hotspot);
  if (hotspots.length > 0) {
    const names = hotspots.map((f) => `\`${f.path}\``).join(', ');
    recs.push(
      `🔥 **High-churn area** — ${names} ${hotspots.length === 1 ? 'has' : 'have'} been modified frequently. Extra test coverage for changes here would reduce regression risk.`
    );
  }

  if (level === 'high' || level === 'elevated') {
    recs.push(
      '👥 **Second reviewer recommended** — The risk profile of this PR suggests an additional human review would be valuable.'
    );
  }

  return recs;
};

/*
 * Computes a risk assessment for a PR based on git history and PR characteristics.
 * Returns signals that are injected into analysis prompts (making the AI more thorough
 * in risky areas) and recommendations shown in the review footer.
 */
export const assessPRRisk = async (
  owner: string,
  repo: string,
  filePaths: string[],
  installationId: number
): Promise<PRRiskAssessment> => {
  let commitStats: FileCommitStats[];
  try {
    commitStats = await fetchFileCommitStats(owner, repo, filePaths, installationId);
  } catch (err: unknown) {
    logger.warn({ message: err instanceof Error ? err.message : 'Unknown error' },
      'Failed to fetch commit stats for risk scoring — defaulting to low risk');
    return {
      level: 'low',
      score: 0,
      fileRisks: [],
      signals: [],
      recommendations: [],
    };
  }

  // Build per-file risk profiles.
  const fileRisks: FileRisk[] = commitStats.map((stat) => ({
    path: stat.path,
    churnScore: churnScore(stat.commitCount),
    multiAuthor: stat.authors.length >= MULTI_AUTHOR_THRESHOLD,
    hotspot: stat.commitCount >= CHURN_MODERATE,
    commitCount: stat.commitCount,
  }));

  // Composite score from four weighted dimensions.
  const avgChurn = fileRisks.length > 0
    ? fileRisks.reduce((sum, f) => sum + f.churnScore, 0) / fileRisks.length
    : 0;
  const size = sizeScore(filePaths.length);
  const spread = spreadScore(filePaths);
  const timing = timingScore();

  const score = Math.round(
    avgChurn * WEIGHT_CHURN +
    size * WEIGHT_SIZE +
    spread * WEIGHT_SPREAD +
    timing * WEIGHT_TIMING
  );

  const level = levelFromScore(score);
  const signals = buildSignals(fileRisks, filePaths.length, spread, timing);
  const recommendations = buildRecommendations(fileRisks, filePaths.length, level);

  logger.info({
    owner, repo, level, score,
    fileCount: filePaths.length,
    hotspots: fileRisks.filter((f) => f.hotspot).length,
  }, 'PR risk assessment computed');

  return { level, score, fileRisks, signals, recommendations };
};
