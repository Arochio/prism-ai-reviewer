import axios from "axios";
import jwt from "jsonwebtoken";

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

  return jwt.sign(
    {
      iat: Math.floor(Date.now() / 1000) - 60,
      exp: Math.floor(Date.now() / 1000) + 600,
      iss: Number(process.env.GITHUB_APP_ID),
    },
    privateKey,
    { algorithm: "RS256" }
  );
};

//github installation token
const getInstallationToken = async (installationId: number) => {
  const jwtToken = generateJWT();

  if (!installationId || Number.isNaN(installationId)) {
    throw new Error("Invalid installationId: " + installationId);
  }

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

    return response.data.token;
  } catch (err: any) {
    console.error("Failed to get installation token", {
      installationId,
      status: err.response?.status,
      data: err.response?.data,
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
  const token = await getInstallationToken(installationId);
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
  };

  const prResponse = await axios.get(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`,
    { headers }
  );

  const filesResponse = await axios.get(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/files`,
    { headers }
  );
  const files = filesResponse.data;

  // Fetch content for each changed file
  const fileContents = await Promise.all(
    files
      .filter((f: any) => f.status !== "removed")
      .map(async (f: any) => {
        if (!f.raw_url) return { ...f, content: null };
        const r = await axios.get(f.raw_url, { headers });
        return { ...f, content: r.data };
      })
  );

  const reviewsResponse = await axios.get(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/reviews`,
    { headers }
  );

  return {
    prData: prResponse.data,
    files: fileContents,
    reviews: reviewsResponse.data,
  };
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