import axios from "axios";
import jwt from "jsonwebtoken";
import type { AxiosResponse } from "axios";

interface GitHubApiErrorResponse {
  message?: string;
}

interface GitHubChangedFile {
  filename: string;
  status: string;
  raw_url?: string;
  content?: string | null;
}

const getAxiosErrorDetails = (error: unknown): { status?: number; data?: unknown; message: string } => {
  if (axios.isAxiosError<GitHubApiErrorResponse>(error)) {
    return {
      status: error.response?.status,
      data: error.response?.data,
      message: error.message,
    };
  }
  if (error instanceof Error) {
    return { message: error.message };
  }
  return { message: "Unknown error" };
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
    const response = await axios.post(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      {},
      {
        headers: {
          Authorization: `Bearer ${jwtToken}`,
          Accept: "application/vnd.github+json",
        },
      }
    );

    const token = response.data.token;
    // Cache for 55 minutes (3,300,000 ms); GitHub tokens expire after 60 minutes
    installationTokenCache.set(installationId, { token, expiresAt: Date.now() + 3_300_000 });
    return token;
  } catch (err: unknown) {
    const { status, data } = getAxiosErrorDetails(err);
    console.error("Failed to get installation token", {
      installationId,
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
) => {
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
  ]> => Promise.all([
    axios.get(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`, { headers: hdrs }),
    axios.get<GitHubChangedFile[]>(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/files`, { headers: hdrs }),
    axios.get(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/reviews`, { headers: hdrs }),
  ]);

  let prResponse, filesResponse, reviewsResponse;
  try {
    [prResponse, filesResponse, reviewsResponse] = await fetchAll(headers);
  } catch (err: unknown) {
    const { status, data } = getAxiosErrorDetails(err);
    // If the cached token was revoked (401), evict it and retry once with a fresh token
    if (status === 401) {
      console.warn("GitHub returned 401 — evicting cached token and retrying", { installationId });
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
          const r = await axios.get<string>(f.raw_url, { headers });
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
    prData: prResponse.data,
    files: fileContents,
    reviews: reviewsResponse.data,
  };
};

// GitHub enforces a 65,536 character limit on issue comments
const GITHUB_COMMENT_MAX_LENGTH = 65_536;
const TRUNCATION_NOTICE = "\n\n---\n> ⚠️ *Review truncated — exceeded GitHub's comment length limit.*";

const postComment = async (token: string, owner: string, repo: string, prNumber: number, body: string) => {
  await axios.post(
    `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments`,
    { body },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
      },
    }
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
        owner, repo, prNumber, installationId,
        status,
        data,
      });
      throw err;
    }
  }
};