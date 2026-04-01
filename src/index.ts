import dotenv from "dotenv";
// Loads environment variables before any service initialization.
dotenv.config();

import express from "express";
import { handleWebhook } from "./controllers/webhookController";
import { openAIConfig } from "./config/openai.config";
import { getPool } from "./db/connection";
import { logger } from "./services/logger";
const app = express();
const PORT = process.env.PORT || 3000;

// Validates all required configuration at startup so misconfigurations surface
// immediately instead of failing silently on the first webhook.
const validateStartupConfig = async () => {
  const errors: string[] = [];
  const warnings: string[] = [];

  // --- Required env vars ---
  if (!process.env.OPENAI_API_KEY) errors.push("OPENAI_API_KEY is required");
  if (isNaN(openAIConfig.maxTokens) || openAIConfig.maxTokens <= 0) errors.push("OPENAI_MAX_TOKENS must be a positive integer");
  if (!process.env.GITHUB_APP_ID || isNaN(Number(process.env.GITHUB_APP_ID)) || Number(process.env.GITHUB_APP_ID) <= 0) {
    errors.push("GITHUB_APP_ID must be a positive integer");
  }
  if (!process.env.GITHUB_PRIVATE_KEY) errors.push("GITHUB_PRIVATE_KEY is required");
  if (!process.env.GITHUB_WEBHOOK_SECRET) errors.push("GITHUB_WEBHOOK_SECRET is required — all webhooks will be rejected without it");

  // --- PostgreSQL (required for installation tracking) ---
  if (process.env.DATABASE_URL) {
    try {
      const pool = getPool();
      const client = await pool.connect();
      await client.query("SELECT 1");
      client.release();
      logger.info("PostgreSQL connection verified");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "unknown error";
      errors.push(`PostgreSQL connection failed: ${msg}`);
    }
  } else {
    warnings.push("DATABASE_URL not set — installation tracking and billing features disabled");
  }

  // --- Pinecone (required for embeddings + feedback) ---
  if (openAIConfig.enableEmbeddings) {
    if (!process.env.PINECONE_API_KEY) errors.push("PINECONE_API_KEY is required when embeddings are enabled");
    if (!process.env.PINECONE_INDEX_NAME) errors.push("PINECONE_INDEX_NAME is required when embeddings are enabled");

    if (process.env.PINECONE_API_KEY && process.env.PINECONE_INDEX_NAME) {
      try {
        const { Pinecone } = await import("@pinecone-database/pinecone");
        const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
        const index = pc.index(process.env.PINECONE_INDEX_NAME);
        await index.describeIndexStats();
        logger.info("Pinecone connection verified");
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "unknown error";
        errors.push(`Pinecone connection failed: ${msg}`);
      }
    }
  } else {
    warnings.push("Embeddings disabled (OPENAI_ENABLE_EMBEDDINGS=false) — RAG context and feedback will not be available");
  }

  // --- Redis (required for caching) ---
  if (openAIConfig.enableCache) {
    const hasRedisConfig = process.env.REDIS_URL || (process.env.REDIS_HOST && process.env.REDIS_PORT);
    if (!hasRedisConfig) {
      errors.push("Redis is not configured (set REDIS_URL or REDIS_HOST + REDIS_PORT) — required when caching is enabled");
    } else {
      try {
        const { createClient } = await import("redis");
        const client = process.env.REDIS_URL
          ? createClient({ url: process.env.REDIS_URL })
          : createClient({
              socket: { host: process.env.REDIS_HOST!, port: Number(process.env.REDIS_PORT) },
              username: process.env.REDIS_USERNAME,
              password: process.env.REDIS_PASSWORD,
            });
        await client.connect();
        await client.ping();
        await client.disconnect();
        logger.info("Redis connection verified");
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "unknown error";
        errors.push(`Redis connection failed: ${msg}`);
      }
    }
  } else {
    warnings.push("Caching disabled (OPENAI_ENABLE_CACHE=false) — duplicate PR analyses will not be cached");
  }

  // --- Report ---
  for (const w of warnings) logger.warn(w);

  if (errors.length > 0) {
    for (const e of errors) logger.error(e);
    throw new Error(`Startup validation failed with ${errors.length} error(s) — see logs above`);
  }

  logger.info("Startup validation passed");
};

// Parses incoming webhook JSON payloads.
app.use(express.json());

app.get("/", (req, res) => {
  res.send("AI PR Reviewer is running");
});

// Health check endpoint for Railway and uptime monitors.
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// GitHub webhook endpoint.
app.post("/webhook", handleWebhook);

// Validates config and external connections before accepting traffic.
validateStartupConfig().then(() => {
  app.listen(PORT, () => {
    logger.info({ port: PORT }, "Server running");
  });
}).catch((err: unknown) => {
  logger.error({ message: err instanceof Error ? err.message : "unknown" }, "Server failed to start");
  process.exit(1);
});