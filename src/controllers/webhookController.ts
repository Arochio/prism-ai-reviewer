import { Request, Response } from "express";
import crypto from "crypto";
import { fetchPRDetails, postPullRequestComment } from "../services/githubService";
import { analyzeFiles } from "../services/openaiService";

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

    const { action, pull_request: pr, repository: repo } = req.body;
    console.log(`PR ${action}: ${pr.title} by ${pr.user.login}`);

    const processPRData = async (pr: any, repo: any, installationId: number) => {
        const { prData, files, reviews } = await fetchPRDetails(repo.owner.login, repo.name, pr.number, installationId);

        console.log(`Fetched ${files.length} files for PR #${pr.number}`);

        const analysis = await analyzeFiles(files);

        console.log("AI Review for PR:", analysis);

        // optionally post back as a comment to PR:
        await postPullRequestComment(
            repo.owner.login,
            repo.name,
            pr.number,
            `### AI Review\n\n${analysis}`,
            installationId
        );
    };

    //handle pr action
    if (action === "opened" || action === "synchronize") {
        const installationId = req.body.installation?.id;
        if (!installationId) {
            console.error("Missing installation.id in webhook payload", { body: req.body });
            return res.status(400).send("Missing installation.id");
        }

        processPRData(pr, repo, installationId).catch((err) => {
            console.error("processPRData error", err);
        });
    }

    res.sendStatus(200);
};