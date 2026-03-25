import axios from "axios";
import jwt from "jsonwebtoken";
import type { AxiosResponse } from "axios";

interface GitHubApiErrorResponse {
  message?: string;
}

interface GitHubPRData {
  head: {
    sha: string;
  };
}

export interface GitHubChangedFile {
  filename: string;
  status: string;
  raw_url?: string;
  patch?: string;
  content?: string | null;
}

export interface InlineReviewCommentInput {
  path: string;
  line: number;
  body: string;
  side?: "RIGHT" | "LEFT";
}

interface FetchPRDetailsResult {
  prData: GitHubPRData;
  files: GitHubChangedFile[];
  reviews: unknown[];
}

const getAxiosErrorDetails = (error: unknown): { status?: number; data?: unknown; message: string; headers?: Record<string, unknown> } => {
  if (axios.isAxiosError<GitHubApiErrorResponse>(error)) {
    return {
      status: error.response?.status,
      data: error.response?.data,
      message: error.message,
      headers: (error.response?.headers as Record<string, unknown> | undefined),
    };
  }
  if (error instanceof Error) {
    return { message: error.message };
  }
  return { message: "Unknown error" };
};

const GITHUB_RATE_LIMIT_MAX_RETRIES = 2;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const getHeaderValue = (headers: Record<string, unknown> | undefined, key: string): string | undefined => {
  if (!headers) return undefined;
  const value = headers[key] ?? headers[key.toLowerCase()] ?? headers[key.toUpperCase()];
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return undefined;
};

const isGitHubRateLimitError = (status?: number, headers?: Record<string, unknown>): boolean => {
  if (status === 429) return true;
  if (status === 403) {
    const remaining = getHeaderValue(headers, "x-ratelimit-remaining");
    return remaining === "0";
  }
  return false;
};

const getRateLimitDelayMs = (headers?: Record<string, unknown>, fallbackMs = 3000): number => {
  const retryAfter = getHeaderValue(headers, "retry-after");
  const retryAfterSeconds = retryAfter ? Number(retryAfter) : NaN;
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return Math.max(1000, retryAfterSeconds * 1000);
  }

  const reset = getHeaderValue(headers, "x-ratelimit-reset");
  const resetSeconds = reset ? Number(reset) : NaN;
  if (Number.isFinite(resetSeconds) && resetSeconds > 0) {
    const delay = resetSeconds * 1000 - Date.now() + 1000;
    return Math.max(1000, delay);
  }

  return fallbackMs;
};

const withGitHubRateLimitRetry = async <T>(
  operation: () => Promise<T>,
  label: string,
  maxRetries = GITHUB_RATE_LIMIT_MAX_RETRIES
): Promise<T> => {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error: unknown) {
      const { status, headers, message } = getAxiosErrorDetails(error);
      const isRateLimited = isGitHubRateLimitError(status, headers);

      if (!isRateLimited || attempt >= maxRetries) {
        throw error;
      }

      const delayMs = getRateLimitDelayMs(headers, 3000 * (attempt + 1));
      console.warn("GitHub API rate limit hit; retrying request", {
        label,
        status,
        attempt: attempt + 1,
        maxRetries,
        delayMs,
        message,
      });
      await sleep(delayMs);
    }
  }
};

// JWT is valid for 10 minutes; cache it for 9 to allow a safety margin
let cachedJWT: { token: string; expiresAt: number } | null = null;

// Installation tokens are valid for 1 hour; cache per installationId for 55 minutes
const installationTokenCache = new Map<number, { token: string; expiresAt: number }>();

const generateJWT = () => {
  const rawKey = process.env.GITHUB_PRIVATE_KEY;
  if (!rawKey) {
    throw new Error("GITHUB_PRIVATE_KEY is missing in env");
  }

  // Convert escaped newlines to real newlines
  const privateKey = rawKey.includes("\\n") ? rawKey.replace(/\\n/g, "\n") : rawKey;

  const normalized = privateKey.trim();
  const isValidPem = normalized.startsWith("-----BEGIN PRIVATE KEY-----") || normalized.startsWith("-----BEGIN RSA PRIVATE KEY-----");
  if (!isValidPem) {
    throw new Error("GITHUB_PRIVATE_KEY must be a PEM formatted private key starting with -----BEGIN PRIVATE KEY----- or -----BEGIN RSA PRIVATE KEY-----");
  }

  if (cachedJWT && Date.now() < cachedJWT.expiresAt) {
    return cachedJWT.token;
  }

  const token = jwt.sign(
    {
      iat: Math.floor(Date.now() / 1000) - 60,
      exp: Math.floor(Date.now() / 1000) + 600,
      iss: Number(process.env.GITHUB_APP_ID),
    },
    privateKey,
    { algorithm: "RS256" }
  );

  // Cache for 9 minutes (540,000 ms)
  cachedJWT = { token, expiresAt: Date.now() + 540_000 };
  return token;
};

//github installation token
const getInstallationToken = async (installationId: number) => {
  if (!installationId || Number.isNaN(installationId)) {
    throw new Error("Invalid installationId: " + installationId);
  }

  const cached = installationTokenCache.get(installationId);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.token;
  }

  const jwtToken = generateJWT();

  try {
    const response = await withGitHubRateLimitRetry(
      () => axios.post(
        `https://api.github.com/app/installations/${installationId}/access_tokens`,
        {},
        {
          headers: {
            Authorization: `Bearer ${jwtToken}`,
            Accept: "application/vnd.github+json",
          },
        }
      ),
      "getInstallationToken"
    );

    const token = response.data.token;
    // Cache for 55 minutes (3,300,000 ms); GitHub tokens expire after 60 minutes
    installationTokenCache.set(installationId, { token, expiresAt: Date.now() + 3_300_000 });
    return token;
  } catch (err: unknown) {
    const { status, data } = getAxiosErrorDetails(err);
    console.error("Failed to get installation token", {
      status,
      data,
    });
    throw err;
  }
};

//fetch pr details from url strings from webhook
//used by /controllers/webhookController.ts
export const fetchPRDetails = async (
  owner: string,
  repo: string,
  prNumber: number,
  installationId: number
): Promise<FetchPRDetailsResult> => {
  let token: string;
  token = await getInstallationToken(installationId);


  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
  };

  const fetchAll = (hdrs: typeof headers): Promise<[
    AxiosResponse,
    AxiosResponse<GitHubChangedFile[]>,
    AxiosResponse
  ]> => withGitHubRateLimitRetry(
    () => Promise.all([
      axios.get(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`, { headers: hdrs }),
      axios.get<GitHubChangedFile[]>(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/files`, { headers: hdrs }),
      axios.get(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/reviews`, { headers: hdrs }),
    ]),
    `fetchPRDetails:${owner}/${repo}#${prNumber}`
  );

  let prResponse, filesResponse, reviewsResponse;
  try {
    [prResponse, filesResponse, reviewsResponse] = await fetchAll(headers);
  } catch (err: unknown) {
    const { status, data } = getAxiosErrorDetails(err);
    // If the cached token was revoked (401), evict it and retry once with a fresh token
    if (status === 401) {
      console.warn("GitHub returned 401 — evicting cached token and retrying");
      installationTokenCache.delete(installationId);
      const freshToken = await getInstallationToken(installationId);
      const retryHeaders = { ...headers, Authorization: `Bearer ${freshToken}` };
      try {
        [prResponse, filesResponse, reviewsResponse] = await fetchAll(retryHeaders);
      } catch (retryErr: unknown) {
        const retryDetails = getAxiosErrorDetails(retryErr);
        console.error("Failed to fetch PR data after token refresh", {
          owner, repo, prNumber,
          status: retryDetails.status,
          data: retryDetails.data,
        });
        throw retryErr;
      }
    } else {
      console.error("Failed to fetch PR data from GitHub", {
        owner, repo, prNumber,
        status,
        data,
      });
      throw err;
    }
  }

  const files = filesResponse.data;

  // Fetch content for each changed file; failures per file are caught individually
  const fileContents = await Promise.all(
    files
      .filter((f) => f.status !== "removed")
      .map(async (f) => {
        if (!f.raw_url) return { ...f, content: null };
        try {
          const r = await withGitHubRateLimitRetry(
            () => axios.get<string>(f.raw_url!, { headers }),
            `fetchFileContent:${owner}/${repo}:${f.filename}`
          );
          return { ...f, content: r.data };
        } catch (err: unknown) {
          const details = getAxiosErrorDetails(err);
          console.error(`Failed to fetch content for file ${f.filename}`, {
            status: details.status,
            message: details.message,
          });
          return { ...f, content: null };
        }
      })
  );

  return {
    prData: prResponse.data as GitHubPRData,
    files: fileContents,
    reviews: reviewsResponse.data as unknown[],
  };
};

// GitHub enforces a 65,536 character limit on issue comments
const GITHUB_COMMENT_MAX_LENGTH = 65_536;
const TRUNCATION_NOTICE = "\n\n---\n> ⚠️ *Review truncated — exceeded GitHub's comment length limit.*";

const postComment = async (token: string, owner: string, repo: string, prNumber: number, body: string) => {
  await withGitHubRateLimitRetry(
    () => axios.post(
      `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments`,
      { body },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
        },
      }
    ),
    `postPullRequestComment:${owner}/${repo}#${prNumber}`
  );
};

//post pull request comment to github
export const postPullRequestComment = async (
  owner: string,
  repo: string,
  prNumber: number,
  body: string,
  installationId: number
) => {
  const token = await getInstallationToken(installationId);

  // Truncate proactively if body exceeds GitHub's limit
  const safeBody = body.length > GITHUB_COMMENT_MAX_LENGTH
    ? body.slice(0, GITHUB_COMMENT_MAX_LENGTH - TRUNCATION_NOTICE.length) + TRUNCATION_NOTICE
    : body;

  try {
    await postComment(token, owner, repo, prNumber, safeBody);
    console.log("Comment posted successfully");
  } catch (err: unknown) {
    const { status, data } = getAxiosErrorDetails(err);
    // 422 can still occur for other validation reasons — retry with a hard-truncated fallback
    if (status === 422) {
      console.warn("GitHub rejected comment with 422 — retrying with hard-truncated body", {
        owner, repo, prNumber, originalLength: body.length,
      });
      const fallbackBody = body.slice(0, 10_000) + TRUNCATION_NOTICE;
      try {
        await postComment(token, owner, repo, prNumber, fallbackBody);
        console.log("Comment posted successfully (truncated fallback)");
      } catch (retryErr: unknown) {
        const retryDetails = getAxiosErrorDetails(retryErr);
        console.error("Failed to post truncated PR comment", {
          owner, repo, prNumber,
          status: retryDetails.status,
          data: retryDetails.data,
        });
        throw retryErr;
      }
    } else {
      console.error("Failed to post PR comment", {
        owner, repo, prNumber,
        status,
        data,
      });
      throw err;
    }
  }
};

export const postPullRequestInlineComments = async (
  owner: string,
  repo: string,
  prNumber: number,
  installationId: number,
  commitId: string,
  comments: InlineReviewCommentInput[]
) => {
  if (!comments.length) return;

  const token = await getInstallationToken(installationId);

  try {
    await withGitHubRateLimitRetry(
      () => axios.post(
        `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/reviews`,
        {
          commit_id: commitId,
          event: "COMMENT",
          comments: comments.map((comment) => ({
            path: comment.path,
            line: comment.line,
            side: comment.side ?? "RIGHT",
            body: comment.body,
          })),
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
          },
        }
      ),
      `postInlineReview:${owner}/${repo}#${prNumber}`
    );
    console.log("Inline review comment posted successfully");
  } catch (err: unknown) {
    const { status, data } = getAxiosErrorDetails(err);
    console.error("Failed to post inline review comments", {
      owner,
      repo,
      prNumber,
      status,
      data,
    });
    throw err;
  }
};