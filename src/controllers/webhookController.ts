import { Request, Response } from "express";
import crypto from "crypto";
import { fetchPRDetails, fetchCommentBody, GitHubChangedFile, postPullRequestComment, postPullRequestInlineComments } from "../services/githubService";
import { analyzeFiles } from "../services/openaiService";
import { retryWithBackoff } from "../utils/retry";
import { parseFeedbackCommand, storeFeedback } from "../services/feedbackService";
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
const analyzeAndCommentOnPR = async (prDataPayload: WebhookPullRequest, repoData: WebhookRepository, installationId: number) => {
    const { prData, files } = await fetchPRDetails(repoData.owner.login, repoData.name, prDataPayload.number, installationId);

    logger.info({ fileCount: files.length, prNumber: prDataPayload.number }, "Fetched files for PR analysis");

    let analysis: string;
    try {
        analysis = await analyzeFiles(files, prDataPayload.number);
    } catch (err: unknown) {
        logger.error({
            prNumber: prDataPayload.number,
            repo: repoData.full_name,
            message: getErrorMessage(err),
            stack: getErrorStack(err),
        }, "AI analysis failed — skipping comment posting");
        throw err;
    }

    logger.info({ prNumber: prDataPayload.number, analysis }, "AI Review for PR");

    // Post results independently so a comment failure doesn't lose the analysis
    // or cause duplicate OpenAI calls on retry.
    try {
        await postPullRequestComment(
            repoData.owner.login,
            repoData.name,
            prDataPayload.number,
            `### AI Review\n\n${analysis}`,
            installationId
        );
    } catch (err: unknown) {
        logger.error({
            prNumber: prDataPayload.number,
            message: getErrorMessage(err),
        }, "Failed to post PR summary comment");
    }

    try {
        const inlineComments = buildInlineComments(files, analysis);

        if (inlineComments.length > 0 && prData.head?.sha) {
            await postPullRequestInlineComments(
                repoData.owner.login,
                repoData.name,
                prDataPayload.number,
                installationId,
                prData.head.sha,
                inlineComments
            );
        }
    } catch (err: unknown) {
        logger.error({
            prNumber: prDataPayload.number,
            message: getErrorMessage(err),
        }, "Failed to post inline review comments");
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

        retryWithBackoff(
            () => analyzeAndCommentOnPR(pr, repo, installationId),
            3,
            1000,
            `PR #${pr.number} analysis`
        ).catch((err: unknown) => {
            logger.error({
                prNumber: pr.number,
                repo: repo.full_name,
                action,
                message: getErrorMessage(err),
                stack: getErrorStack(err),
            }, "analyzeAndCommentOnPR failed after all retries");
        });
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