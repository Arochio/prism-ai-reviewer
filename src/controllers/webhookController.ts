import { Request, Response } from "express";
import crypto from "crypto";
import { fetchPRDetails, fetchCommentBody, GitHubChangedFile, postPullRequestComment, postPullRequestInlineComments, createPRComment, updatePRComment } from "../services/githubService";
import { analyzeFiles } from "../services/openaiService";
import type { RepoInfo } from "../pipeline/fetchRepoContext";
import { parseFeedbackCommand, storeFeedback } from "../services/feedbackService";
import { ingestPushChanges, type PushFileChange } from "../services/ingestionService";
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
const verifyWebhookSignature = (req: Request): boolean => {
    const secret = process.env.GITHUB_WEBHOOK_SECRET;
    if (!secret) {
        logger.warn("GITHUB_WEBHOOK_SECRET is not set — webhook signature verification is disabled");
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

    let result: { summary: string; suggestions: import('../pipeline/generateFixes').CodeSuggestion[] };
    try {
        result = await analyzeFiles(files, prNumber, repoInfo);
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

    logger.info({ prNumber, summary: result.summary, suggestionCount: result.suggestions.length }, "AI Review for PR");

    // Append suggestion count hint to the summary so authors know to look for inline fixes.
    let analysis = result.summary;
    if (result.suggestions.length > 0) {
        analysis += `\n\n---\n💡 **${result.suggestions.length}** fix suggestion${result.suggestions.length > 1 ? 's' : ''} posted as inline comments.`;
    }

    try {
        await updateOrPost(`### AI Review\n\n${analysis}`);
    } catch (err: unknown) {
        logger.error({
            prNumber,
            message: getErrorMessage(err),
        }, "Failed to post PR summary comment");
    }

    // Post one-click fix suggestions as inline PR review comments.
    if (result.suggestions.length > 0) {
        try {
            const inlineComments = result.suggestions.map((s) => ({
                path: s.path,
                line: s.endLine,
                ...(s.startLine !== s.endLine && { startLine: s.startLine }),
                side: "RIGHT" as const,
                body: `🔧 **Suggested fix**\n> ${s.finding.replace(/`[^`]*`/g, '').replace(/\s+/g, ' ').trim().slice(0, 200)}\n\n\`\`\`suggestion\n${s.suggestedCode}\n\`\`\``,
            }));
            await postPullRequestInlineComments(owner, repo, prNumber, installationId, prData.head.sha, inlineComments);
            logger.info({ prNumber, count: inlineComments.length }, "Inline fix suggestions posted");
        } catch (err: unknown) {
            logger.warn({ prNumber, message: getErrorMessage(err) }, "Failed to post inline suggestions — summary was still posted");
        }
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
const handlePullRequestEvent = (req: Request, res: Response) => {
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

        const dedupKey = `pr:${repo.full_name}#${pr.number}`;
        const generation = nextGeneration(dedupKey);

        analyzeAndCommentOnPR(pr, repo, installationId, dedupKey, generation).catch((err: unknown) => {
            clearGeneration(dedupKey, generation);
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

// Handles push webhook events for incremental vector DB ingestion.
const handlePushEvent = (req: Request, res: Response) => {
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
        case "pull_request":
            return handlePullRequestEvent(req, res);
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