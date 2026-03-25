import { Request, Response } from "express";
import crypto from "crypto";
import { fetchPRDetails, postPullRequestComment } from "../services/githubService";
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
        const { files } = await fetchPRDetails(repoData.owner.login, repoData.name, prDataPayload.number, installationId);

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
    };

    //handle pr action
    if (action === "opened" || action === "synchronize") {
        const installationId = payload.installation?.id;
        if (!installationId) {
            console.error("Missing installation.id in webhook payload", { body: payload });
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