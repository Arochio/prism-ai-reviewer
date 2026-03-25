import { Request, Response } from "express";
import crypto from "crypto";
import { fetchPRDetails, GitHubChangedFile, postPullRequestComment, postPullRequestInlineComments } from "../services/githubService";
import { analyzeFiles } from "../services/openaiService";
import { retryWithBackoff } from "../utils/retry";

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

const getErrorMessage = (error: unknown): string => {
    if (error instanceof Error) return error.message;
    return "Unknown error";
};

const getErrorStack = (error: unknown): string | undefined => {
    if (error instanceof Error) return error.stack;
    return undefined;
};

const MAX_INLINE_COMMENTS = 3;

const getFirstAddedLineFromPatch = (patch?: string): number | null => {
    if (!patch) return null;

    let currentNewLine = 0;
    const lines = patch.split("\n");

    for (const line of lines) {
        const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (hunkMatch) {
            currentNewLine = Number(hunkMatch[1]);
            continue;
        }

        if (line.startsWith("+") && !line.startsWith("+++")) {
            return currentNewLine;
        }

        if (!line.startsWith("-")) {
            currentNewLine += 1;
        }
    }

    return null;
};

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
        body: `AI note: ${highlights[index % highlights.length]}`,
    }));
};

//webhook handling
export const handleWebhook = (req: Request, res: Response) => {
    const signature = req.headers["x-hub-signature-256"] as string;
    const secret = process.env.GITHUB_WEBHOOK_SECRET;

    //github webhook secret authorization
    if (secret) {
        const hmac = crypto.createHmac("sha256", secret);
        const digest = "sha256=" + hmac.update(JSON.stringify(req.body)).digest("hex");
        if (signature !== digest) {
            return res.status(401).send("Unauthorized");
        }
    }

    //handle if event isnt a pr
    const event = req.headers["x-github-event"] as string;
    if (event !== "pull_request") {
        return res.status(200).send("Event ignored");
    }

    const payload = req.body as WebhookPayload;
    const { action, pull_request: pr, repository: repo } = payload;
    console.log(`PR ${action}: ${pr.title} by ${pr.user.login}`);

    const processPRData = async (prDataPayload: WebhookPullRequest, repoData: WebhookRepository, installationId: number) => {
        const { prData, files } = await fetchPRDetails(repoData.owner.login, repoData.name, prDataPayload.number, installationId);

        console.log(`Fetched ${files.length} files for PR #${prDataPayload.number}`);

        const analysis = await analyzeFiles(files, prDataPayload.number);

        console.log("AI Review for PR:", analysis);

        // optionally post back as a comment to PR:
        await postPullRequestComment(
            repoData.owner.login,
            repoData.name,
            prDataPayload.number,
            `### AI Review\n\n${analysis}`,
            installationId
        );

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
    };

    //handle pr action
    if (action === "opened" || action === "synchronize") {
        const installationId = payload.installation?.id;
        if (!installationId) {
            console.error("Missing installation.id in webhook payload", {
                action: payload.action,
                repo: payload.repository?.full_name,
                prNumber: payload.pull_request?.number,
            });
            return res.status(400).send("Missing installation.id");
        }

        retryWithBackoff(
            () => processPRData(pr, repo, installationId),
            3,
            1000,
            `PR #${pr.number} analysis`
        ).catch((err: unknown) => {
            console.error("processPRData failed after all retries", {
                prNumber: pr.number,
                repo: repo.full_name,
                action,
                message: getErrorMessage(err),
                stack: getErrorStack(err),
            });
        });
    }

    res.sendStatus(200);
};