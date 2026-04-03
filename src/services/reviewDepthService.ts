// Computes anonymous review coverage for a PR and formats a markdown section
// that is appended to (or replaces) the Prism summary comment after each review submission
//
// Anonymized design: no reviewer names are surfaced — only aggregate stats and
// uncovered file lists. The goal is to give the PR author actionable context
// without creating social pressure around individual reviewers

import {
  fetchPRReviews,
  fetchPRReviewComments,
  fetchPRFilenames,
  findPrismSummaryComment,
  updatePRComment,
} from './githubService';
import { logger } from './logger';

// Marker used to locate and replace the coverage section on subsequent review events
const COVERAGE_MARKER = '\n\n---\n## Review Coverage';

// File paths matching these patterns are flagged as high-risk in the uncovered list
const RISK_PATH_PATTERNS = [
  /\bauth\b/i,
  /\bsecurity\b/i,
  /\bmigration\b/i,
  /\b(db|database|schema)\b/i,
  /\bmiddleware\b/i,
  /\bpayment\b/i,
  /\bcrypto\b/i,
  /\bpassword\b/i,
  /\bpermission\b/i,
  /\bsecret\b/i,
];

const isRiskyPath = (path: string): boolean =>
  RISK_PATH_PATTERNS.some((r) => r.test(path));

// Builds the markdown coverage section from review and file data
const buildCoverageSection = (
  reviews: Awaited<ReturnType<typeof fetchPRReviews>>,
  reviewComments: Awaited<ReturnType<typeof fetchPRReviewComments>>,
  changedFilenames: string[],
  prCreatedAt: string,
): string => {
  // Index inline comments by review ID
  const commentsByReview = new Map<number, string[]>();
  for (const comment of reviewComments) {
    const id = comment.pull_request_review_id;
    if (!commentsByReview.has(id)) commentsByReview.set(id, []);
    commentsByReview.get(id)!.push(comment.path);
  }

  // Aggregate per-reviewer stats (bots excluded, PENDING skipped)
  const prCreatedMs = new Date(prCreatedAt).getTime();

  interface ReviewerStats {
    state: string;
    commentCount: number;
    filesCovered: Set<string>;
    fastestSubmitMinutes: number;
  }

  const byReviewer = new Map<string, ReviewerStats>();

  for (const review of reviews) {
    if (review.state === 'PENDING') continue;
    const login = review.user.login;
    if (login.endsWith('[bot]') || login.endsWith('-bot')) continue;

    const paths = commentsByReview.get(review.id) ?? [];
    const submitMs = new Date(review.submitted_at).getTime();
    const minutesSinceOpen = Math.max(0, Math.round((submitMs - prCreatedMs) / 60_000));

    if (!byReviewer.has(login)) {
      byReviewer.set(login, {
        state: review.state,
        commentCount: 0,
        filesCovered: new Set(),
        fastestSubmitMinutes: minutesSinceOpen,
      });
    }

    const stats = byReviewer.get(login)!;
    // Escalate state: CHANGES_REQUESTED > APPROVED > COMMENTED
    if (review.state === 'CHANGES_REQUESTED') stats.state = 'CHANGES_REQUESTED';
    else if (review.state === 'APPROVED' && stats.state !== 'CHANGES_REQUESTED') stats.state = 'APPROVED';
    stats.commentCount += paths.length;
    for (const p of paths) stats.filesCovered.add(p);
    stats.fastestSubmitMinutes = Math.min(stats.fastestSubmitMinutes, minutesSinceOpen);
  }

  // Aggregate across all reviewers
  const reviewedFiles = new Set<string>();
  for (const stats of byReviewer.values()) {
    for (const f of stats.filesCovered) reviewedFiles.add(f);
  }

  const approvals = [...byReviewer.values()].filter((s) => s.state === 'APPROVED');
  const approvalCount = approvals.length;

  // Quick approvals: approved with no inline comments and submitted < 10 min after PR opened
  const quickApprovalCount = approvals.filter(
    (s) => s.commentCount === 0 && s.fastestSubmitMinutes < 10,
  ).length;

  const uncoveredFiles = changedFilenames.filter((f) => !reviewedFiles.has(f));
  const riskyUncoveredCount = uncoveredFiles.filter(isRiskyPath).length;
  const totalFiles = changedFilenames.length;
  const coveredCount = totalFiles - uncoveredFiles.length;
  const coveragePct = totalFiles > 0 ? Math.round((coveredCount / totalFiles) * 100) : 100;

  // --- Format markdown ---
  const lines: string[] = ['---', '## Review Coverage', ''];

  const approvalLabel = approvalCount === 1 ? '1 approval' : `${approvalCount} approvals`;
  lines.push(`${approvalLabel} · ${coveredCount}/${totalFiles} files reviewed (${coveragePct}%)`);
  lines.push('');

  if (uncoveredFiles.length === 0) {
    lines.push('✅ All changed files received at least one reviewer comment.');
  } else {
    const riskNote = riskyUncoveredCount > 0 ? ` — ${riskyUncoveredCount} flagged high-risk 🔴` : '';
    lines.push(`⚠️ **${uncoveredFiles.length} file${uncoveredFiles.length > 1 ? 's' : ''} received no reviewer comments**${riskNote}`);
    lines.push('');
    for (const f of uncoveredFiles.slice(0, 10)) {
      lines.push(`- \`${f}\`${isRiskyPath(f) ? ' 🔴' : ''}`);
    }
    if (uncoveredFiles.length > 10) {
      lines.push(`- _…and ${uncoveredFiles.length - 10} more_`);
    }
  }

  if (quickApprovalCount > 0) {
    lines.push('');
    const plural = quickApprovalCount === 1
      ? `1 of ${approvalCount} approvals was`
      : `${quickApprovalCount} of ${approvalCount} approvals were`;
    lines.push(`_${plural} submitted within 10 min with no inline comments._`);
  }

  return lines.join('\n');
};

// Entry point called from the webhook handler on every pull_request_review submission
// Fetches review data, computes coverage, then patches the existing Prism summary comment
export const updateReviewCoverage = async (
  owner: string,
  repo: string,
  prNumber: number,
  prCreatedAt: string,
  installationId: number,
): Promise<void> => {
  // Fetch in parallel: reviews, inline comments, changed filenames, existing Prism comment
  const [reviews, reviewComments, changedFilenames, prismComment] = await Promise.all([
    fetchPRReviews(owner, repo, prNumber, installationId),
    fetchPRReviewComments(owner, repo, prNumber, installationId),
    fetchPRFilenames(owner, repo, prNumber, installationId),
    findPrismSummaryComment(owner, repo, prNumber, installationId),
  ]);

  // Nothing to update if Prism hasn't posted its summary yet
  if (!prismComment) {
    logger.info({ owner, repo, prNumber }, 'No Prism summary comment found — skipping review coverage update');
    return;
  }

  // Nothing meaningful to show if no human reviews exist yet
  const humanReviews = reviews.filter(
    (r) => r.state !== 'PENDING' && !r.user.login.endsWith('[bot]') && !r.user.login.endsWith('-bot'),
  );
  if (humanReviews.length === 0) return;

  const coverageSection = buildCoverageSection(reviews, reviewComments, changedFilenames, prCreatedAt);

  // Strip any existing coverage section, then append the fresh one
  const baseBody = prismComment.body.includes(COVERAGE_MARKER)
    ? prismComment.body.slice(0, prismComment.body.indexOf(COVERAGE_MARKER))
    : prismComment.body;

  const updatedBody = `${baseBody}${COVERAGE_MARKER.trimStart() === '' ? '\n\n' : '\n\n'}${coverageSection}`;

  await updatePRComment(owner, repo, prismComment.id, updatedBody, installationId);

  logger.info(
    { owner, repo, prNumber, reviewCount: humanReviews.length },
    'Review coverage section updated on Prism comment',
  );
};
