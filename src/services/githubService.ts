import axios from "axios";
import jwt from "jsonwebtoken";
import type { AxiosResponse } from "axios";
import { logger } from "./logger";

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
  startLine?: number;
  startSide?: "RIGHT" | "LEFT";
}

interface FetchPRDetailsResult {
  prData: GitHubPRData;
  files: GitHubChangedFile[];
  reviews: unknown[];
}

// Normalizes unknown errors into a consistent log shape.
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

// Reads a response header value across common key casing variations.
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

// Computes wait duration from GitHub rate-limit headers with a fallback delay.
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

// Retries GitHub requests when throttled by rate limits.
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
      logger.warn({
        label,
        status,
        attempt: attempt + 1,
        maxRetries,
        delayMs,
        message,
      }, "GitHub API rate limit hit; retrying request");
      await sleep(delayMs);
    }
  }
};

// JWT is valid for 10 minutes; cache it for 9 to allow a safety margin
let cachedJWT: { token: string; expiresAt: number } | null = null;

// Installation tokens are valid for 1 hour; cache per installationId for 55 minutes
const installationTokenCache = new Map<number, { token: string; expiresAt: number }>();

// Generates a signed GitHub App JWT used to request installation tokens.
const generateJWT = () => {
  const rawKey = process.env.GITHUB_PRIVATE_KEY;
  if (!rawKey) {
    throw new Error("GITHUB_PRIVATE_KEY is missing in env");
  }

  // Convert escaped newlines to real newlines
  const privateKey = rawKey.includes("\\n") ? rawKey.replace(/\\n/g, "\n") : rawKey;

  const normalized = privateKey.trim();

  // Validate PEM envelope: must have matching BEGIN/END markers with base64 content between them.
  const pemMatch = normalized.match(
    /^(-----BEGIN (RSA )?PRIVATE KEY-----)\n([\s\S]+?)\n(-----END \2PRIVATE KEY-----)$/
  );
  if (!pemMatch) {
    throw new Error(
      "GITHUB_PRIVATE_KEY must be a valid PEM private key with matching " +
      "-----BEGIN PRIVATE KEY----- / -----END PRIVATE KEY----- (or RSA PRIVATE KEY) markers"
    );
  }

  // Verify the body between markers is valid base64 (allows whitespace/newlines).
  const pemBody = pemMatch[3].replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+=*$/.test(pemBody) || pemBody.length < 100) {
    throw new Error("GITHUB_PRIVATE_KEY has an invalid or truncated base64 body");
  }

  const appId = Number(process.env.GITHUB_APP_ID);
  if (!Number.isInteger(appId) || appId <= 0) {
    throw new Error("GITHUB_APP_ID must be a positive integer");
  }

  if (cachedJWT && Date.now() < cachedJWT.expiresAt) {
    return cachedJWT.token;
  }

  const token = jwt.sign(
    {
      iat: Math.floor(Date.now() / 1000) - 60,
      exp: Math.floor(Date.now() / 1000) + 600,
      iss: appId,
    },
    privateKey,
    { algorithm: "RS256" }
  );

  // Cache for 9 minutes (540,000 ms)
  cachedJWT = { token, expiresAt: Date.now() + 540_000 };
  return token;
};

// Retrieves and caches a GitHub installation access token.
const getInstallationToken = async (installationId: number) => {
  if (typeof installationId !== 'number' || !Number.isInteger(installationId) || installationId <= 0) {
    throw new Error(`Invalid installationId: expected a positive integer, got ${String(installationId)}`);
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
    if (typeof token !== 'string' || token.length === 0) {
      throw new Error(`GitHub returned an empty or missing token for installation ${installationId}`);
    }

    // Cache for 55 minutes (3,300,000 ms); GitHub tokens expire after 60 minutes
    installationTokenCache.set(installationId, { token, expiresAt: Date.now() + 3_300_000 });
    return token;
  } catch (err: unknown) {
    const { status, data } = getAxiosErrorDetails(err);

    // 404 = installation not found; evict any stale cache entry.
    if (status === 404) {
      installationTokenCache.delete(installationId);
      logger.error({
        installationId,
        status,
      }, "Installation not found — the app may have been uninstalled or the ID is invalid");
      throw new Error(`GitHub installation ${installationId} not found (404). Verify the app is still installed.`, { cause: err });
    }

    logger.error({
      installationId,
      status,
      data,
    }, "Failed to get installation token");
    throw err;
  }
};

// Fetches PR metadata, file list, file content, and review history.
export const fetchPRDetails = async (
  owner: string,
  repo: string,
  prNumber: number,
  installationId: number
): Promise<FetchPRDetailsResult> => {
  const token = await getInstallationToken(installationId);

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
  };

  // Groups primary PR API calls under a shared retry envelope.
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
      logger.warn("GitHub returned 401 — evicting cached token and retrying");
      installationTokenCache.delete(installationId);
      const freshToken = await getInstallationToken(installationId);
      const retryHeaders = { ...headers, Authorization: `Bearer ${freshToken}` };
      try {
        [prResponse, filesResponse, reviewsResponse] = await fetchAll(retryHeaders);
      } catch (retryErr: unknown) {
        const retryDetails = getAxiosErrorDetails(retryErr);
        logger.error({
          owner, repo, prNumber,
          status: retryDetails.status,
          data: retryDetails.data,
        }, "Failed to fetch PR data after token refresh");
        throw retryErr;
      }
    } else {
      logger.error({
        owner, repo, prNumber,
        status,
        data,
      }, "Failed to fetch PR data from GitHub");
      throw err;
    }
  }

  // Validate PR response contains the expected head SHA.
  const prData = prResponse.data;
  if (!prData || typeof prData !== 'object' || !prData.head || typeof prData.head.sha !== 'string') {
    throw new Error(`GitHub PR response missing head.sha for ${owner}/${repo}#${prNumber}`);
  }

  // Validate files response is an array.
  const filesData = filesResponse.data;
  if (!Array.isArray(filesData)) {
    throw new Error(`GitHub files response is not an array for ${owner}/${repo}#${prNumber}`);
  }

  // Filter out malformed file entries that lack required fields.
  const validFiles = filesData.filter(
    (f): f is GitHubChangedFile =>
      f != null &&
      typeof f.filename === 'string' && f.filename.length > 0 &&
      typeof f.status === 'string' && f.status.length > 0
  );

  // Validate reviews response is an array (non-critical — default to empty).
  const reviewsData = Array.isArray(reviewsResponse.data) ? reviewsResponse.data as unknown[] : [];

  // Fetches content for changed files; individual file failures do not stop processing.
  const fileContents = await Promise.all(
    validFiles
      .filter((f) => f.status !== "removed")
      .map(async (f) => {
        if (!f.raw_url) return { ...f, content: null };
        try {
          const r = await withGitHubRateLimitRetry(
            () => axios.get<string>(f.raw_url!, { headers }),
            `fetchFileContent:${owner}/${repo}:${f.filename}`
          );
          const content = typeof r.data === 'string' ? r.data : null;
          return { ...f, content };
        } catch (err: unknown) {
          const details = getAxiosErrorDetails(err);
          logger.error({
            status: details.status,
            message: details.message,
          }, `Failed to fetch content for file ${f.filename}`);
          return { ...f, content: null };
        }
      })
  );

  return {
    prData: prData as GitHubPRData,
    files: fileContents,
    reviews: reviewsData,
  };
};

// GitHub enforces a 65,536 character limit on issue comments
const GITHUB_COMMENT_MAX_LENGTH = 65_536;
const TRUNCATION_NOTICE = "\n\n---\n> ⚠️ *Review truncated — exceeded GitHub's comment length limit.*";
const HARD_FALLBACK_LENGTH = 10_000;

// Truncates a comment body to fit within a character budget, breaking at the
// last newline before the limit to avoid corrupting markdown formatting.
const truncateAtLineBoundary = (body: string, maxContentLength: number): string => {
  if (body.length <= maxContentLength) return body;

  const slice = body.slice(0, maxContentLength);
  const lastNewline = slice.lastIndexOf('\n');

  // Prefer breaking at a line boundary; fall back to hard cut if no newline found.
  const safeSlice = lastNewline > maxContentLength * 0.5 ? slice.slice(0, lastNewline) : slice;

  return safeSlice + TRUNCATION_NOTICE;
};

// Posts a standard PR issue comment.
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

// Creates a PR comment and returns its ID so it can be updated later.
export const createPRComment = async (
  owner: string,
  repo: string,
  prNumber: number,
  body: string,
  installationId: number
): Promise<number> => {
  const token = await getInstallationToken(installationId);
  const response = await withGitHubRateLimitRetry(
    () => axios.post<{ id: number }>(
      `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments`,
      { body },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
        },
      }
    ),
    `createPRComment:${owner}/${repo}#${prNumber}`
  );
  return response.data.id;
};

// Updates an existing PR issue comment by ID.
export const updatePRComment = async (
  owner: string,
  repo: string,
  commentId: number,
  body: string,
  installationId: number
): Promise<void> => {
  const token = await getInstallationToken(installationId);

  const maxContentLength = GITHUB_COMMENT_MAX_LENGTH - TRUNCATION_NOTICE.length;
  const safeBody = truncateAtLineBoundary(body, maxContentLength);

  await withGitHubRateLimitRetry(
    () => axios.patch(
      `https://api.github.com/repos/${owner}/${repo}/issues/comments/${commentId}`,
      { body: safeBody },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
        },
      }
    ),
    `updatePRComment:${owner}/${repo}:${commentId}`
  );
};

// Posts the top-level PR review summary comment with length safeguards.
export const postPullRequestComment = async (
  owner: string,
  repo: string,
  prNumber: number,
  body: string,
  installationId: number
) => {
  const token = await getInstallationToken(installationId);

  const maxContentLength = GITHUB_COMMENT_MAX_LENGTH - TRUNCATION_NOTICE.length;
  const safeBody = truncateAtLineBoundary(body, maxContentLength);

  if (safeBody.length < body.length) {
    logger.warn({
      owner, repo, prNumber,
      originalLength: body.length,
      truncatedLength: safeBody.length,
      charsDropped: body.length - safeBody.length,
    }, "PR comment truncated to fit GitHub limit");
  }

  try {
    await postComment(token, owner, repo, prNumber, safeBody);
    logger.info({ owner, repo, prNumber }, "Comment posted successfully");
  } catch (err: unknown) {
    const { status, data } = getAxiosErrorDetails(err);
    // 422 can still occur for other validation reasons — retry with a hard-truncated fallback
    if (status === 422) {
      const fallbackBody = truncateAtLineBoundary(body, HARD_FALLBACK_LENGTH);
      logger.warn({
        owner, repo, prNumber,
        originalLength: body.length,
        fallbackLength: fallbackBody.length,
      }, "GitHub rejected comment with 422 — retrying with hard-truncated body");
      try {
        await postComment(token, owner, repo, prNumber, fallbackBody);
        logger.info({ owner, repo, prNumber }, "Comment posted successfully (truncated fallback)");
      } catch (retryErr: unknown) {
        const retryDetails = getAxiosErrorDetails(retryErr);
        logger.error({
          owner, repo, prNumber,
          status: retryDetails.status,
          data: retryDetails.data,
        }, "Failed to post truncated PR comment");
        throw retryErr;
      }
    } else {
      logger.error({
        owner, repo, prNumber,
        status,
        data,
      }, "Failed to post PR comment");
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
  // The GitHub Reviews API supports batching multiple inline comments in one request.
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
            ...(comment.startLine !== undefined && {
              start_line: comment.startLine,
              start_side: comment.startSide ?? comment.side ?? "RIGHT",
            }),
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
    logger.info({ owner, repo, prNumber, commentCount: comments.length }, "Inline review comment posted successfully");
  } catch (err: unknown) {
    const { status, data } = getAxiosErrorDetails(err);
    logger.error({
      owner,
      repo,
      prNumber,
      status,
      data,
    }, "Failed to post inline review comments");
    throw err;
  }
};

// Fetches the body of a single issue/PR comment by ID. Returns null on failure.
export const fetchCommentBody = async (
  owner: string,
  repo: string,
  commentId: number,
  installationId: number
): Promise<string | null> => {
  try {
    const token = await getInstallationToken(installationId);
    const endpoints = [
      `https://api.github.com/repos/${owner}/${repo}/issues/comments/${commentId}`,
      `https://api.github.com/repos/${owner}/${repo}/pulls/comments/${commentId}`,
    ];

    for (const endpoint of endpoints) {
      try {
        const response = await withGitHubRateLimitRetry(
          () => axios.get<{ body?: string }>(
            endpoint,
            {
              headers: {
                Authorization: `Bearer ${token}`,
                Accept: "application/vnd.github+json",
              },
            }
          ),
          `fetchCommentBody:${owner}/${repo}:${commentId}`
        );
        if (typeof response.data.body === "string") {
          return response.data.body;
        }
      } catch {
        continue;
      }
    }

    return null;
  } catch (err: unknown) {
    const { status, message } = getAxiosErrorDetails(err);
    logger.error({ owner, repo, commentId, status, message }, "Failed to fetch comment body");
    return null;
  }
};

export interface GitHubTreeEntry {
  path: string;
  type: 'blob' | 'tree';
  size?: number;
}

// Fetches the full recursive file tree for a given commit SHA.
export const fetchRepoTree = async (
  owner: string,
  repo: string,
  sha: string,
  installationId: number
): Promise<GitHubTreeEntry[]> => {
  const token = await getInstallationToken(installationId);
  try {
    const response = await withGitHubRateLimitRetry(
      () => axios.get<{ tree: GitHubTreeEntry[]; truncated: boolean }>(
        `https://api.github.com/repos/${owner}/${repo}/git/trees/${sha}?recursive=1`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
          },
        }
      ),
      `fetchRepoTree:${owner}/${repo}`
    );
    if (response.data.truncated) {
      logger.warn({ owner, repo, sha }, "GitHub tree response was truncated — some files may be missing from context");
    }
    return (response.data.tree || []).filter(
      (entry): entry is GitHubTreeEntry =>
        entry != null && typeof entry.path === 'string' && entry.path.length > 0
    );
  } catch (err: unknown) {
    const { status, message } = getAxiosErrorDetails(err);
    logger.error({ owner, repo, sha, status, message }, "Failed to fetch repo tree");
    return [];
  }
};

// Fetches raw file content for a list of file paths at a given ref.
// Individual file failures are non-blocking and return null content.
export const fetchRepoFileContents = async (
  owner: string,
  repo: string,
  ref: string,
  filePaths: string[],
  installationId: number
): Promise<{ path: string; content: string | null }[]> => {
  const token = await getInstallationToken(installationId);
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github.v3.raw",
  };

  return Promise.all(
    filePaths.map(async (filePath) => {
      try {
        const response = await withGitHubRateLimitRetry(
          () => axios.get<string>(
            `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(filePath)}?ref=${ref}`,
            { headers, responseType: 'text' }
          ),
          `fetchRepoFile:${owner}/${repo}:${filePath}`
        );
        const content = typeof response.data === 'string' ? response.data : null;
        return { path: filePath, content };
      } catch (err: unknown) {
        const { status, message } = getAxiosErrorDetails(err);
        logger.error({ filePath, status, message }, `Failed to fetch repo file ${filePath}`);
        return { path: filePath, content: null };
      }
    })
  );
};

// Fetches the .prism-rules file from the repo root, if it exists.
// Returns the file content as a string, or an empty string if not found.
export const fetchRepoRules = async (
  owner: string,
  repo: string,
  ref: string,
  installationId: number
): Promise<string> => {
  const token = await getInstallationToken(installationId);
  try {
    const response = await withGitHubRateLimitRetry(
      () => axios.get<string>(
        `https://api.github.com/repos/${owner}/${repo}/contents/.prism-rules?ref=${ref}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github.v3.raw",
          },
          responseType: 'text',
        }
      ),
      `fetchRepoRules:${owner}/${repo}`
    );
    const content = typeof response.data === 'string' ? response.data.trim() : '';
    if (content) {
      logger.info({ owner, repo }, "Loaded .prism-rules from repository");
    }
    return content;
  } catch (err: unknown) {
    const { status } = getAxiosErrorDetails(err);
    // 404 is expected when the file doesn't exist — not an error.
    if (status !== 404) {
      const { message } = getAxiosErrorDetails(err);
      logger.error({ owner, repo, status, message }, "Failed to fetch .prism-rules");
    }
    return '';
  }
};

// Fetches recent commit activity for specific file paths.
// Returns an array of { path, commitCount, lastCommitDate } over the trailing 90-day window.
export interface FileCommitStats {
  path: string;
  commitCount: number;
  authors: string[];
  lastCommitDate: string | null;
}

export const fetchFileCommitStats = async (
  owner: string,
  repo: string,
  filePaths: string[],
  installationId: number
): Promise<FileCommitStats[]> => {
  const token = await getInstallationToken(installationId);
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
  };

  const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

  return Promise.all(
    filePaths.map(async (filePath): Promise<FileCommitStats> => {
      try {
        const response = await withGitHubRateLimitRetry(
          () => axios.get<Array<{ commit: { author: { name: string; date: string } } }>>(
            `https://api.github.com/repos/${owner}/${repo}/commits`,
            {
              headers,
              params: { path: filePath, since, per_page: 100 },
            }
          ),
          `fetchFileCommits:${owner}/${repo}:${filePath}`
        );
        const commits = Array.isArray(response.data) ? response.data : [];
        const authors = [...new Set(
          commits
            .map((c) => c.commit?.author?.name)
            .filter((n): n is string => typeof n === 'string')
        )];
        const lastDate = commits[0]?.commit?.author?.date ?? null;
        return { path: filePath, commitCount: commits.length, authors, lastCommitDate: lastDate };
      } catch {
        return { path: filePath, commitCount: 0, authors: [], lastCommitDate: null };
      }
    })
  );
};

// Represents a recently merged PR with metadata used for retroactive scanning.
export interface MergedPRSummary {
  number: number;
  title: string;
  filesChanged: number;
  additions: number;
  deletions: number;
  mergedAt: string;
  author: string;
  changedFiles: string[];
}

// Fetches recently merged PRs including their changed file lists.
// Used by the bootstrap service to seed risk scoring data on first install.
export const fetchMergedPRs = async (
  owner: string,
  repo: string,
  installationId: number,
  limit = 100,
): Promise<MergedPRSummary[]> => {
  const token = await getInstallationToken(installationId);
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
  };

  const results: MergedPRSummary[] = [];
  const perPage = Math.min(limit, 100);
  let page = 1;

  while (results.length < limit) {
    const response = await withGitHubRateLimitRetry(
      () => axios.get<Array<{
        number: number;
        title: string;
        changed_files: number;
        additions: number;
        deletions: number;
        merged_at: string | null;
        user: { login: string } | null;
      }>>(
        `https://api.github.com/repos/${owner}/${repo}/pulls`,
        {
          headers,
          params: { state: 'closed', sort: 'updated', direction: 'desc', per_page: perPage, page },
        },
      ),
      `fetchMergedPRs:${owner}/${repo}:page${page}`,
    );

    const prs = Array.isArray(response.data) ? response.data : [];
    if (prs.length === 0) break;

    for (const pr of prs) {
      if (!pr.merged_at) continue; // closed but not merged — skip
      if (results.length >= limit) break;
      results.push({
        number: pr.number,
        title: pr.title,
        filesChanged: pr.changed_files,
        additions: pr.additions,
        deletions: pr.deletions,
        mergedAt: pr.merged_at,
        author: pr.user?.login ?? 'unknown',
        changedFiles: [], // populated below
      });
    }

    page++;
    // Safety: no more than 5 pages to cap API usage during bootstrap.
    if (page > 5) break;
  }

  // Fetch changed file lists for each merged PR (capped to avoid rate limits).
  const FILE_FETCH_LIMIT = 30;
  const toEnrich = results.slice(0, FILE_FETCH_LIMIT);
  await Promise.all(
    toEnrich.map(async (pr) => {
      try {
        const resp = await withGitHubRateLimitRetry(
          () => axios.get<Array<{ filename: string }>>(
            `https://api.github.com/repos/${owner}/${repo}/pulls/${pr.number}/files`,
            { headers, params: { per_page: 100 } },
          ),
          `fetchMergedPRFiles:${owner}/${repo}#${pr.number}`,
        );
        pr.changedFiles = Array.isArray(resp.data)
          ? resp.data.map((f) => f.filename).filter((f): f is string => typeof f === 'string')
          : [];
      } catch {
        // Non-blocking — we still have the aggregate counts.
      }
    }),
  );

  return results;
};

// --- Review depth helpers ---

export interface PRReview {
  id: number;
  user: { login: string };
  state: string;         // APPROVED | CHANGES_REQUESTED | COMMENTED | PENDING
  submitted_at: string;
}

// Fetches all submitted reviews for a PR.
export const fetchPRReviews = async (
  owner: string,
  repo: string,
  prNumber: number,
  installationId: number,
): Promise<PRReview[]> => {
  const token = await getInstallationToken(installationId);
  try {
    const response = await withGitHubRateLimitRetry(
      () => axios.get<PRReview[]>(
        `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/reviews`,
        {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
          params: { per_page: 100 },
        },
      ),
      `fetchPRReviews:${owner}/${repo}#${prNumber}`,
    );
    return Array.isArray(response.data) ? response.data : [];
  } catch (err: unknown) {
    const { status, message } = getAxiosErrorDetails(err);
    logger.error({ owner, repo, prNumber, status, message }, 'Failed to fetch PR reviews');
    return [];
  }
};

export interface PRReviewComment {
  id: number;
  pull_request_review_id: number;
  user: { login: string };
  path: string;
  body: string;
}

// Fetches all inline review comments (diff comments) for a PR.
export const fetchPRReviewComments = async (
  owner: string,
  repo: string,
  prNumber: number,
  installationId: number,
): Promise<PRReviewComment[]> => {
  const token = await getInstallationToken(installationId);
  try {
    const response = await withGitHubRateLimitRetry(
      () => axios.get<PRReviewComment[]>(
        `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/comments`,
        {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
          params: { per_page: 100 },
        },
      ),
      `fetchPRReviewComments:${owner}/${repo}#${prNumber}`,
    );
    return Array.isArray(response.data) ? response.data : [];
  } catch (err: unknown) {
    const { status, message } = getAxiosErrorDetails(err);
    logger.error({ owner, repo, prNumber, status, message }, 'Failed to fetch PR review comments');
    return [];
  }
};

// Fetches just the filenames changed in a PR (lightweight — no content).
export const fetchPRFilenames = async (
  owner: string,
  repo: string,
  prNumber: number,
  installationId: number,
): Promise<string[]> => {
  const token = await getInstallationToken(installationId);
  try {
    const response = await withGitHubRateLimitRetry(
      () => axios.get<Array<{ filename: string }>>(
        `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/files`,
        {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
          params: { per_page: 100 },
        },
      ),
      `fetchPRFilenames:${owner}/${repo}#${prNumber}`,
    );
    return Array.isArray(response.data)
      ? response.data.map((f) => f.filename).filter((f): f is string => typeof f === 'string')
      : [];
  } catch (err: unknown) {
    const { status, message } = getAxiosErrorDetails(err);
    logger.error({ owner, repo, prNumber, status, message }, 'Failed to fetch PR filenames');
    return [];
  }
};

// Finds the PRism summary comment on a PR by matching its well-known header.
// Returns the comment id and current body, or null if not found.
export const findPrismSummaryComment = async (
  owner: string,
  repo: string,
  prNumber: number,
  installationId: number,
): Promise<{ id: number; body: string } | null> => {
  const token = await getInstallationToken(installationId);
  try {
    const response = await withGitHubRateLimitRetry(
      () => axios.get<Array<{ id: number; body?: string }>>(
        `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments`,
        {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
          params: { per_page: 100 },
        },
      ),
      `findPrismSummaryComment:${owner}/${repo}#${prNumber}`,
    );
    const comments = Array.isArray(response.data) ? response.data : [];
    const prismComment = comments.find((c) => typeof c.body === 'string' && c.body.startsWith('### AI Review'));
    return prismComment
      ? { id: prismComment.id, body: prismComment.body as string }
      : null;
  } catch (err: unknown) {
    const { status, message } = getAxiosErrorDetails(err);
    logger.error({ owner, repo, prNumber, status, message }, 'Failed to find Prism summary comment');
    return null;
  }
};