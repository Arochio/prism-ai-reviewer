import { Request, Response } from "express";
import crypto from "crypto";
import { fetchPRDetails, fetchCommentBody, GitHubChangedFile, postPullRequestComment, postPullRequestInlineComments, createPRComment, updatePRComment } from "../services/githubService";
import { analyzeFiles } from "../services/openaiService";
import { generateSummary } from "../pipeline/generateSummary";
import { formatInlineCommentBody } from "../pipeline/splitFindings";
import type { RepoInfo } from "../pipeline/fetchRepoContext";
import { parseFeedbackCommand, storeFeedback } from "../services/feedbackService";
import { ingestPushChanges, type PushFileChange } from "../services/ingestionService";
import { bootstrapRepo } from "../services/bootstrapService";
import { updateReviewCoverage } from "../services/reviewDepthService";
import {
    upsertInstallation,
    getInstallationByGithubId,
    suspendInstallation,
    unsuspendInstallation,
    deleteInstallation,
    updateInstallationPlan,
    logMarketplaceEvent,
    createReviewEvent,
    completeReviewEvent,
} from "../services/installationService";
import { logger } from "../services/logger";

interface WebhookPullRequest {
    number: number;
    title: string;
    user: {
        login: string;
    };
}

interface WebhookRepository {
    name: string;
    full_name: string;
    owner: {
        login: string;
    };
}

interface WebhookPayload {
    action: string;
    pull_request: WebhookPullRequest;
    repository: WebhookRepository;
    installation?: {
        id?: number;
    };
}

interface IssueCommentPayload {
    action: string;
    comment: {
        id: number;
        body: string;
        user: { login: string };
        /** GitHub populates this when replying to another comment. */
        in_reply_to_id?: number;
    };
    issue: {
        number: number;
        pull_request?: { url: string };
    };
    repository: WebhookRepository;
    installation?: { id?: number };
}

interface PullRequestReviewCommentPayload {
    action: string;
    comment: {
        id: number;
        body: string;
        user: { login: string };
        in_reply_to_id?: number;
    };
    pull_request: {
        number: number;
    };
    repository: WebhookRepository;
    installation?: { id?: number };
}

interface PullRequestReviewPayload {
    action: string;
    review: {
        id: number;
        state: string;
        submitted_at: string;
        user: { login: string };
    };
    pull_request: {
        number: number;
        created_at: string;
    };
    repository: WebhookRepository;
    installation?: { id?: number };
}

interface PushCommit {
    added: string[];
    removed: string[];
    modified: string[];
}

interface PushPayload {
    ref: string;
    after: string;
    commits: PushCommit[];
    repository: WebhookRepository;
    installation?: { id?: number };
}

interface InstallationPayload {
    action: string;
    installation: {
        id: number;
        account: {
            login: string;
            id: number;
            type: string;
        };
        app_id: number;
    };
    repositories?: Array<{ full_name: string }>;
}

interface MarketplacePurchasePayload {
    action: string;
    marketplace_purchase: {
        account: {
            id: number;
            login: string;
            type: string;
        };
        plan: {
            id: number;
            name: string;
            slug?: string;
        };
    };
    installation?: { id?: number };
}

const getErrorMessage = (error: unknown): string => {
    if (error instanceof Error) return error.message;
    return "Unknown error";
};

const getErrorStack = (error: unknown): string | undefined => {
    if (error instanceof Error) return error.stack;
    return undefined;
};

const isValidPRPayload = (body: unknown): body is WebhookPayload => {
    if (typeof body !== 'object' || body === null) return false;
    const b = body as Record<string, unknown>;
    if (typeof b.action !== 'string') return false;

    const pr = b.pull_request as Record<string, unknown> | undefined;
    if (!pr || typeof pr.number !== 'number' || typeof pr.title !== 'string') return false;
    if (!pr.user || typeof (pr.user as Record<string, unknown>).login !== 'string') return false;

    const repo = b.repository as Record<string, unknown> | undefined;
    if (!repo || typeof repo.name !== 'string' || typeof repo.full_name !== 'string') return false;
    if (!repo.owner || typeof (repo.owner as Record<string, unknown>).login !== 'string') return false;

    return true;
};

const isValidIssueCommentPayload = (body: unknown): body is IssueCommentPayload => {
    if (typeof body !== 'object' || body === null) return false;
    const b = body as Record<string, unknown>;
    if (typeof b.action !== 'string') return false;

    const comment = b.comment as Record<string, unknown> | undefined;
    if (!comment || typeof comment.id !== 'number' || typeof comment.body !== 'string') return false;
    if (!comment.user || typeof (comment.user as Record<string, unknown>).login !== 'string') return false;

    const issue = b.issue as Record<string, unknown> | undefined;
    if (!issue || typeof issue.number !== 'number') return false;

    const repo = b.repository as Record<string, unknown> | undefined;
    if (!repo || typeof repo.name !== 'string' || typeof repo.full_name !== 'string') return false;
    if (!repo.owner || typeof (repo.owner as Record<string, unknown>).login !== 'string') return false;

    return true;
};

const isValidPRReviewCommentPayload = (body: unknown): body is PullRequestReviewCommentPayload => {
    if (typeof body !== 'object' || body === null) return false;
    const b = body as Record<string, unknown>;
    if (typeof b.action !== 'string') return false;

    const comment = b.comment as Record<string, unknown> | undefined;
    if (!comment || typeof comment.id !== 'number' || typeof comment.body !== 'string') return false;
    if (!comment.user || typeof (comment.user as Record<string, unknown>).login !== 'string') return false;

    const pullRequest = b.pull_request as Record<string, unknown> | undefined;
    if (!pullRequest || typeof pullRequest.number !== 'number') return false;

    const repo = b.repository as Record<string, unknown> | undefined;
    if (!repo || typeof repo.name !== 'string' || typeof repo.full_name !== 'string') return false;
    if (!repo.owner || typeof (repo.owner as Record<string, unknown>).login !== 'string') return false;

    return true;
};

const isValidPRReviewPayload = (body: unknown): body is PullRequestReviewPayload => {
    if (typeof body !== 'object' || body === null) return false;
    const b = body as Record<string, unknown>;
    if (typeof b.action !== 'string') return false;

    const review = b.review as Record<string, unknown> | undefined;
    if (!review || typeof review.id !== 'number' || typeof review.state !== 'string') return false;
    if (!review.user || typeof (review.user as Record<string, unknown>).login !== 'string') return false;
    if (typeof review.submitted_at !== 'string') return false;

    const pr = b.pull_request as Record<string, unknown> | undefined;
    if (!pr || typeof pr.number !== 'number' || typeof pr.created_at !== 'string') return false;

    const repo = b.repository as Record<string, unknown> | undefined;
    if (!repo || typeof repo.name !== 'string' || typeof repo.full_name !== 'string') return false;
    if (!repo.owner || typeof (repo.owner as Record<string, unknown>).login !== 'string') return false;

    return true;
};

const isValidPushPayload = (body: unknown): body is PushPayload => {
    if (typeof body !== 'object' || body === null) return false;
    const b = body as Record<string, unknown>;
    if (typeof b.ref !== 'string' || typeof b.after !== 'string') return false;
    if (!Array.isArray(b.commits)) return false;

    const repo = b.repository as Record<string, unknown> | undefined;
    if (!repo || typeof repo.name !== 'string' || typeof repo.full_name !== 'string') return false;
    if (!repo.owner || typeof (repo.owner as Record<string, unknown>).login !== 'string') return false;

    return true;
};

const isValidInstallationPayload = (body: unknown): body is InstallationPayload => {
    if (typeof body !== 'object' || body === null) return false;
    const b = body as Record<string, unknown>;
    if (typeof b.action !== 'string') return false;

    const inst = b.installation as Record<string, unknown> | undefined;
    if (!inst || typeof inst.id !== 'number') return false;

    const account = inst.account as Record<string, unknown> | undefined;
    if (!account || typeof account.login !== 'string' || typeof account.id !== 'number' || typeof account.type !== 'string') return false;

    return true;
};

const isValidMarketplacePurchasePayload = (body: unknown): body is MarketplacePurchasePayload => {
    if (typeof body !== 'object' || body === null) return false;
    const b = body as Record<string, unknown>;
    if (typeof b.action !== 'string') return false;

    const mp = b.marketplace_purchase as Record<string, unknown> | undefined;
    if (!mp) return false;

    const account = mp.account as Record<string, unknown> | undefined;
    if (!account || typeof account.id !== 'number' || typeof account.login !== 'string') return false;

    const plan = mp.plan as Record<string, unknown> | undefined;
    if (!plan || typeof plan.name !== 'string') return false;

    return true;
};

// Limits the number of inline comments posted per PR event to reduce noise.
const MAX_INLINE_COMMENTS = 3;

// Finds the first added line in a unified diff patch for inline comment placement.
const getFirstAddedLineFromPatch = (patch?: string): number | null => {
    if (!patch) return null;

    let currentNewLine = 0;
    let insideHunk = false;
    const lines = patch.split("\n");

    for (const line of lines) {
        const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (hunkMatch) {
            const parsed = Number(hunkMatch[1]);
            if (!Number.isInteger(parsed) || parsed < 0) continue;
            currentNewLine = parsed;
            insideHunk = true;
            continue;
        }

        if (!insideHunk) continue;

        if (line.startsWith("+") && !line.startsWith("+++")) {
            return currentNewLine > 0 ? currentNewLine : null;
        }

        if (!line.startsWith("-")) {
            currentNewLine += 1;
        }
    }

    return null;
};

// Extracts short actionable highlights from the model output.
const extractAnalysisHighlights = (analysis: string): string[] => {
    const bullets = analysis
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => /^(?:-|\*|\d+\.)\s+/.test(line))
        .map((line) => line.replace(/^(?:-|\*|\d+\.)\s+/, ""))
        .filter((line) => line.length > 0);

    if (bullets.length > 0) {
        return bullets.slice(0, MAX_INLINE_COMMENTS);
    }

    return [analysis.replace(/\s+/g, " ").slice(0, 220)];
};

// Formats a review highlight as a GitHub suggestion block.
const formatInlineSuggestionBody = (highlight: string): string => {
    const safeHighlight = highlight.replace(/```/g, "'''").trim();
    return [
        "AI suggestion:",
        `> ${safeHighlight}`,
        "",
        "```suggestion",
        `// ${safeHighlight}`,
        "```",
    ].join("\n");
};

// Maps analysis highlights to changed file locations and removes duplicate targets.
const buildInlineComments = (files: GitHubChangedFile[], analysis: string) => {
    const highlights = extractAnalysisHighlights(analysis);
    const candidates = files
        .filter((file) => file.status !== "removed" && file.patch)
        .map((file) => ({
            path: file.filename,
            line: getFirstAddedLineFromPatch(file.patch),
        }))
        .filter((item): item is { path: string; line: number } => item.line !== null);

    const seen = new Set<string>();
    const dedupedCandidates = candidates.filter((item) => {
        const key = `${item.path}:${item.line}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    return dedupedCandidates.slice(0, MAX_INLINE_COMMENTS).map((candidate, index) => ({
        path: candidate.path,
        line: candidate.line,
        side: "RIGHT" as const,
        body: formatInlineSuggestionBody(highlights[index % highlights.length]),
    }));
};

// Generation-counter map for deduplicating concurrent async work on the same key.
// Each new event for a key increments its generation; after the async work finishes,
// results are only applied if the generation hasn't been superseded.
const activeGenerations = new Map<string, number>();

const nextGeneration = (key: string): number => {
    const gen = (activeGenerations.get(key) ?? 0) + 1;
    activeGenerations.set(key, gen);
    return gen;
};

const isCurrentGeneration = (key: string, gen: number): boolean => {
    return activeGenerations.get(key) === gen;
};

const clearGeneration = (key: string, gen: number): void => {
    if (activeGenerations.get(key) === gen) {
        activeGenerations.delete(key);
    }
};

// Validates the webhook signature against the configured secret.
// Rejects all requests when the secret is not configured — this is a hard requirement.
const verifyWebhookSignature = (req: Request): boolean => {
    const secret = process.env.GITHUB_WEBHOOK_SECRET;
    if (!secret) {
        logger.error("GITHUB_WEBHOOK_SECRET is not set — all webhooks will be rejected. Set this variable to the webhook secret configured in your GitHub App.");
        return false;
    }

    const signature = req.headers["x-hub-signature-256"];
    if (typeof signature !== 'string' || !signature.startsWith("sha256=")) {
        return false;
    }

    const hmac = crypto.createHmac("sha256", secret);
    const digest = "sha256=" + hmac.update(JSON.stringify(req.body)).digest("hex");

    try {
        return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
    } catch {
        return false;
    }
};

// Returns a validated positive integer installation ID, or null if invalid.
const validateInstallationId = (installation?: { id?: unknown }): number | null => {
    const id = installation?.id;
    if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0 || id > Number.MAX_SAFE_INTEGER) return null;
    return id;
};

// Executes end-to-end PR analysis and posts summary plus inline comments.
// Accepts a generation number so stale results from superseded events are discarded.
const analyzeAndCommentOnPR = async (prDataPayload: WebhookPullRequest, repoData: WebhookRepository, installationId: number, dedupKey: string, generation: number) => {
    const owner = repoData.owner.login;
    const repo = repoData.name;
    const prNumber = prDataPayload.number;

    // Post a placeholder comment so the author knows review is in progress.
    let commentId: number | undefined;
    try {
        commentId = await createPRComment(
            owner, repo, prNumber,
            "⏳ **Prism AI** is reviewing this pull request…",
            installationId
        );
    } catch (err: unknown) {
        logger.warn({ prNumber, message: getErrorMessage(err) }, "Failed to post progress comment — continuing without it");
    }

    const updateOrPost = async (body: string) => {
        if (commentId) {
            await updatePRComment(owner, repo, commentId, body, installationId);
        } else {
            await postPullRequestComment(owner, repo, prNumber, body, installationId);
        }
    };

    const { prData, files } = await fetchPRDetails(owner, repo, prNumber, installationId);

    logger.info({ fileCount: files.length, prNumber }, "Fetched files for PR analysis");

    const repoInfo: RepoInfo = {
        owner,
        repo,
        headSha: prData.head.sha,
        installationId,
    };

    let result: Awaited<ReturnType<typeof analyzeFiles>>;
    try {
        result = await analyzeFiles(files, prNumber, repoInfo, prDataPayload.user.login);
    } catch (err: unknown) {
        clearGeneration(dedupKey, generation);
        logger.error({
            prNumber,
            repo: repoData.full_name,
            message: getErrorMessage(err),
            stack: getErrorStack(err),
        }, "AI analysis failed — skipping comment posting");
        try {
            await updateOrPost("❌ **Prism AI** encountered an error while reviewing this pull request.");
        } catch { /* best-effort */ }
        throw err;
    }

    // If a newer event arrived for this PR while we were analyzing, discard our results.
    if (!isCurrentGeneration(dedupKey, generation)) {
        logger.info({ prNumber, generation }, "Analysis superseded by newer event — discarding");
        return;
    }
    clearGeneration(dedupKey, generation);

    logger.info({
        prNumber,
        inlineCount: result.inlineFindings.length,
        nonInlineCount: result.nonInlineResults.reduce((n, r) => n + r.findings.length, 0),
        suggestionCount: result.suggestions.length,
    }, "AI Review for PR");

    // Post each inline-eligible finding as its own review comment on the relevant diff line.
    // Each becomes its own thread so users can reply with per-finding feedback.
    if (result.inlineFindings.length > 0) {
        try {
            const inlineComments = result.inlineFindings.map((f) => ({
                path: f.path,
                line: f.fix ? f.fix.endLine : f.line,
                ...(f.fix && f.fix.startLine !== f.fix.endLine && { startLine: f.fix.startLine }),
                side: "RIGHT" as const,
                body: formatInlineCommentBody(f),
            }));
            await postPullRequestInlineComments(owner, repo, prNumber, installationId, prData.head.sha, inlineComments);
            logger.info({ prNumber, count: inlineComments.length }, "Inline finding comments posted");
        } catch (err: unknown) {
            logger.warn({ prNumber, message: getErrorMessage(err) }, "Failed to post inline findings — falling back to summary-only");
        }
    }

    // Build lightweight summary: inline findings removed, only non-inline + counts.
    const summaryBody = generateSummary(
        result.nonInlineResults,
        result.recommendations,
        result.inlineFindings.length,
    );

    try {
        await updateOrPost(`### AI Review\n\n${summaryBody}`);
    } catch (err: unknown) {
        logger.error({
            prNumber,
            message: getErrorMessage(err),
        }, "Failed to post PR summary comment");
    }
};

// Handles issue_comment webhook events for feedback processing.
const handleIssueCommentEvent = (req: Request, res: Response) => {
    if (!isValidIssueCommentPayload(req.body)) {
        return res.status(422).send("Invalid issue_comment payload");
    }
    const icPayload = req.body;
    if (icPayload.action === "created" && icPayload.issue.pull_request) {
        handleFeedbackComment(icPayload).catch((err: unknown) => {
            logger.error({
                commentId: icPayload.comment.id,
                message: getErrorMessage(err),
            }, "Feedback processing failed");
        });
    }
    return res.sendStatus(200);
};

// Handles pull_request_review_comment webhook events for feedback processing.
const handlePullRequestReviewCommentEvent = (req: Request, res: Response) => {
    if (!isValidPRReviewCommentPayload(req.body)) {
        return res.status(422).send("Invalid pull_request_review_comment payload");
    }
    const reviewPayload = req.body;
    if (reviewPayload.action === "created") {
        handleReviewFeedbackComment(reviewPayload).catch((err: unknown) => {
            logger.error({
                commentId: reviewPayload.comment.id,
                message: getErrorMessage(err),
            }, "Review feedback processing failed");
        });
    }
    return res.sendStatus(200);
};

// Handles pull_request webhook events for AI review.
const handlePullRequestEvent = async (req: Request, res: Response) => {
    if (!isValidPRPayload(req.body)) {
        return res.status(422).send("Invalid pull_request payload");
    }
    const payload = req.body;
    const { action, pull_request: pr, repository: repo } = payload;
    logger.info({ action, prTitle: pr.title, author: pr.user.login, prNumber: pr.number }, "PR webhook received");

    if (action === "opened" || action === "synchronize") {
        const installationId = validateInstallationId(payload.installation);
        if (!installationId) {
            logger.error({
                action: payload.action,
                repo: payload.repository?.full_name,
                prNumber: payload.pull_request?.number,
                installationId: payload.installation?.id,
            }, "Missing or invalid installation.id in webhook payload");
            return res.status(400).send("Missing or invalid installation.id");
        }

        // Gate: ensure this installation is active in our database.
        const installation = await getInstallationByGithubId(installationId).catch(() => null);
        if (installation && installation.status !== "active") {
            logger.warn({ installationId, status: installation.status }, "Webhook from non-active installation");
            return res.status(200).send("Installation not active");
        }

        // On first PR opened for this repo, bootstrap in background to seed
        // risk scoring data and RAG context from merged PR history.
        if (action === "opened") {
            bootstrapRepo(repo.owner.login, repo.name, "HEAD", installationId).catch((err: unknown) => {
                logger.warn({ repo: repo.full_name, message: getErrorMessage(err) }, "Background bootstrap failed");
            });
        }

        const dedupKey = `pr:${repo.full_name}#${pr.number}`;
        const generation = nextGeneration(dedupKey);

        // Track this review event in the database.
        const dbInstallation = installation ?? await getInstallationByGithubId(installationId).catch(() => null);
        const reviewEventId = dbInstallation
            ? await createReviewEvent(dbInstallation.id, repo.full_name, pr.number, "pr_review").catch(() => null)
            : null;

        analyzeAndCommentOnPR(pr, repo, installationId, dedupKey, generation).then(() => {
            if (reviewEventId) completeReviewEvent(reviewEventId, "completed").catch(() => {});
        }).catch((err: unknown) => {
            clearGeneration(dedupKey, generation);
            if (reviewEventId) completeReviewEvent(reviewEventId, "failed", { error: getErrorMessage(err) }).catch(() => {});
            logger.error({
                prNumber: pr.number,
                repo: repo.full_name,
                action,
                message: getErrorMessage(err),
                stack: getErrorStack(err),
            }, "analyzeAndCommentOnPR failed");
        });
    }

    return res.sendStatus(200);
};

// Handles pull_request_review webhook events to update review coverage on the Prism comment.
const handlePullRequestReviewEvent = (req: Request, res: Response) => {
    if (!isValidPRReviewPayload(req.body)) {
        return res.status(422).send("Invalid pull_request_review payload");
    }
    const payload = req.body;

    // Only react to newly submitted reviews, not edits or dismissals.
    if (payload.action !== 'submitted') {
        return res.sendStatus(200);
    }

    const installationId = validateInstallationId(payload.installation);
    if (!installationId) {
        logger.error({ repo: payload.repository.full_name, prNumber: payload.pull_request.number }, "pull_request_review event missing installation.id");
        return res.status(400).send("Missing or invalid installation.id");
    }

    const { repository: repo, pull_request: pr, review } = payload;

    logger.info(
        { prNumber: pr.number, repo: repo.full_name, reviewer: review.user.login, state: review.state },
        "Review submitted — updating coverage"
    );

    updateReviewCoverage(
        repo.owner.login,
        repo.name,
        pr.number,
        pr.created_at,
        installationId,
    ).catch((err: unknown) => {
        logger.error({
            prNumber: pr.number,
            repo: repo.full_name,
            message: getErrorMessage(err),
        }, "Review coverage update failed");
    });

    return res.sendStatus(200);
};

// Handles push webhook events for incremental vector DB ingestion.
const handlePushEvent = async (req: Request, res: Response) => {
    if (!isValidPushPayload(req.body)) {
        return res.status(422).send("Invalid push payload");
    }
    const payload = req.body;
    const { ref, after, commits, repository: repo } = payload;

    // Only ingest pushes to the default branch (main or master).
    const branch = ref.replace('refs/heads/', '');
    if (branch !== 'main' && branch !== 'master') {
        return res.status(200).send("Non-default branch push ignored");
    }

    const installationId = validateInstallationId(payload.installation);
    if (!installationId) {
        logger.error({ ref, repo: repo.full_name }, "Push event missing installation.id");
        return res.status(400).send("Missing or invalid installation.id");
    }

    // Gate: ensure this installation is active in our database.
    const installation = await getInstallationByGithubId(installationId).catch(() => null);
    if (installation && installation.status !== "active") {
        logger.warn({ installationId, status: installation.status }, "Push from non-active installation");
        return res.status(200).send("Installation not active");
    }

    // Aggregate file changes across all commits in this push.
    const changes: PushFileChange = { added: [], removed: [], modified: [] };
    for (const commit of commits) {
        if (Array.isArray(commit.added)) changes.added.push(...commit.added);
        if (Array.isArray(commit.removed)) changes.removed.push(...commit.removed);
        if (Array.isArray(commit.modified)) changes.modified.push(...commit.modified);
    }

    const totalChanges = changes.added.length + changes.removed.length + changes.modified.length;
    if (totalChanges === 0) {
        return res.status(200).send("No file changes to ingest");
    }

    logger.info(
        { branch, repo: repo.full_name, added: changes.added.length, removed: changes.removed.length, modified: changes.modified.length },
        "Push event — starting ingestion"
    );

    const dedupKey = `push:${repo.full_name}:${branch}`;
    const generation = nextGeneration(dedupKey);

    ingestPushChanges(repo.owner.login, repo.name, after, changes, installationId).then(
        () => { clearGeneration(dedupKey, generation); }
    ).catch(
        (err: unknown) => {
            clearGeneration(dedupKey, generation);
            logger.error({
                repo: repo.full_name,
                ref,
                message: getErrorMessage(err),
                stack: getErrorStack(err),
            }, "Push ingestion failed");
        }
    );

    return res.sendStatus(200);
};

// Handles installation lifecycle events (created, deleted, suspend, unsuspend).
const handleInstallationEvent = async (req: Request, res: Response) => {
    if (!isValidInstallationPayload(req.body)) {
        return res.status(422).send("Invalid installation payload");
    }
    const { action, installation: inst } = req.body;
    const { id: githubInstallId, account } = inst;

    logger.info({ action, githubInstallId, account: account.login }, "Installation event received");

    try {
        switch (action) {
            case "created":
                await upsertInstallation({
                    githubInstallId,
                    accountLogin: account.login,
                    accountType: account.type,
                    accountId: account.id,
                });
                break;
            case "deleted":
                await deleteInstallation(githubInstallId);
                break;
            case "suspend":
                await suspendInstallation(githubInstallId);
                break;
            case "unsuspend":
                await unsuspendInstallation(githubInstallId);
                break;
            default:
                logger.info({ action, githubInstallId }, "Unhandled installation action");
        }
    } catch (err: unknown) {
        logger.error({ action, githubInstallId, message: getErrorMessage(err) }, "Installation event handling failed");
    }

    return res.sendStatus(200);
};

// Handles marketplace_purchase events for plan changes.
const handleMarketplacePurchaseEvent = async (req: Request, res: Response) => {
    if (!isValidMarketplacePurchasePayload(req.body)) {
        return res.status(422).send("Invalid marketplace_purchase payload");
    }
    const { action, marketplace_purchase: mp } = req.body;
    const { account, plan } = mp;
    const planSlug = plan.slug ?? plan.name.toLowerCase().replace(/\s+/g, "-");

    logger.info({ action, account: account.login, plan: plan.name }, "Marketplace event received");

    // Log every marketplace event for reconciliation.
    await logMarketplaceEvent(action, account.id, plan, req.body).catch((err: unknown) => {
        logger.error({ action, message: getErrorMessage(err) }, "Failed to log marketplace event");
    });

    try {
        switch (action) {
            case "purchased": {
                // Upsert in case installation event hasn't arrived yet.
                const installationId = validateInstallationId(req.body.installation);
                if (installationId) {
                    await upsertInstallation({
                        githubInstallId: installationId,
                        accountLogin: account.login,
                        accountType: account.type ?? "Organization",
                        accountId: account.id,
                        planSlug,
                        planName: plan.name,
                    });
                } else {
                    // No installation ID in payload — try to find by account and update plan.
                    logger.warn({ account: account.login }, "marketplace_purchase.purchased without installation.id");
                }
                break;
            }
            case "changed": {
                // Plan upgrade/downgrade — find the installation by account and update.
                const installationId = validateInstallationId(req.body.installation);
                if (installationId) {
                    await updateInstallationPlan(installationId, planSlug, plan.name);
                }
                break;
            }
            case "cancelled": {
                const installationId = validateInstallationId(req.body.installation);
                if (installationId) {
                    await updateInstallationPlan(installationId, "free", "Free");
                }
                break;
            }
            default:
                logger.info({ action }, "Marketplace action logged but no state change applied");
        }
    } catch (err: unknown) {
        logger.error({ action, account: account.login, message: getErrorMessage(err) }, "Marketplace event handling failed");
    }

    return res.sendStatus(200);
};

// Webhook entry point — verifies signature and routes to event-specific handlers.
export const handleWebhook = (req: Request, res: Response) => {
    if (!verifyWebhookSignature(req)) {
        return res.status(401).send("Unauthorized");
    }

    const event = req.headers["x-github-event"] as string;

    switch (event) {
        case "push":
            return handlePushEvent(req, res);
        case "issue_comment":
            return handleIssueCommentEvent(req, res);
        case "pull_request_review_comment":
            return handlePullRequestReviewCommentEvent(req, res);
        case "pull_request_review":
            return handlePullRequestReviewEvent(req, res);
        case "pull_request":
            return handlePullRequestEvent(req, res);
        case "installation":
            return handleInstallationEvent(req, res);
        case "marketplace_purchase":
            return handleMarketplacePurchaseEvent(req, res);
        default:
            return res.status(200).send("Event ignored");
    }
};

/*
 * Processes a feedback command left as a PR comment reply.
 * Parses the command, fetches the parent AI review comment, and stores the feedback.
 */
interface FeedbackCommandContext {
    commentId: number;
    commentBody: string;
    inReplyToId?: number;
    prNumber: number;
    owner: string;
    repo: string;
    repoFullName: string;
    installation?: { id?: unknown };
}

const processFeedbackCommand = async (context: FeedbackCommandContext): Promise<void> => {
    const parsed = parseFeedbackCommand(context.commentBody);
    if (!parsed) return; // not a feedback command

    logger.info({
        commentId: context.commentId,
        prNumber: context.prNumber,
        sentiment: parsed.sentiment,
    }, "Feedback command detected");

    const installationId = validateInstallationId(context.installation);
    if (!installationId) {
        logger.warn({ installationId: context.installation?.id }, "Feedback comment missing or invalid installation.id — skipping");
        return;
    }

    // Resolve the AI review text this feedback refers to.
    let aiReviewSnippet = '';
    const parentId = context.inReplyToId;
    if (parentId) {
        const parentBody = await fetchCommentBody(
            context.owner,
            context.repo,
            parentId,
            installationId
        );
        if (parentBody) {
            aiReviewSnippet = parentBody;
        } else {
            logger.warn({
                parentId,
                prNumber: context.prNumber,
            }, "Could not fetch parent comment body for feedback context");
        }
    } else {
        logger.warn({
            commentId: context.commentId,
            prNumber: context.prNumber,
        }, "Feedback comment is not a reply — no AI review context available");
    }

    await storeFeedback({
        commentId: context.commentId,
        prNumber: context.prNumber,
        repo: context.repoFullName,
        sentiment: parsed.sentiment,
        userFeedback: parsed.explanation || `(${parsed.sentiment})`,
        aiReviewSnippet: aiReviewSnippet.slice(0, 2000),
    });

    logger.info({
        prNumber: context.prNumber,
        sentiment: parsed.sentiment,
        commentId: context.commentId,
    }, "Feedback recorded");
};

const handleFeedbackComment = async (payload: IssueCommentPayload): Promise<void> => {
    await processFeedbackCommand({
        commentId: payload.comment.id,
        commentBody: payload.comment.body,
        inReplyToId: payload.comment.in_reply_to_id,
        prNumber: payload.issue.number,
        owner: payload.repository.owner.login,
        repo: payload.repository.name,
        repoFullName: payload.repository.full_name,
        installation: payload.installation,
    });
};

const handleReviewFeedbackComment = async (payload: PullRequestReviewCommentPayload): Promise<void> => {
    await processFeedbackCommand({
        commentId: payload.comment.id,
        commentBody: payload.comment.body,
        inReplyToId: payload.comment.in_reply_to_id,
        prNumber: payload.pull_request.number,
        owner: payload.repository.owner.login,
        repo: payload.repository.name,
        repoFullName: payload.repository.full_name,
        installation: payload.installation,
    });
};