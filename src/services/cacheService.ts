// Redis-backed cache for OpenAI analysis responses.
//
// Purpose: OpenAI calls are expensive and slow. When the same set of files is analyzed
// more than once (e.g. a PR re-synchronized with no code changes, or the same files
// appearing in multiple PRs), this cache returns the stored result instantly instead of
// re-running the full pipeline. The cache key is a SHA-256 hash of the model settings,
// file content, repo context, and custom rules — so any meaningful change to the input
// produces a different key and bypasses the cache automatically.
//
// Isolation: Cache keys are namespaced per installation (prism:<installationId>:openai:)
// so tenants cannot read each other's cached results. A global prefix (prism:openai:) is
// used when no installationId is provided (e.g. dry runs).
//
// TTL: Entries expire after OPENAI_CACHE_TTL_SECONDS (default 1 hour). This trades a small
// risk of serving a stale result against the cost of hitting the OpenAI API on every pass.
//
// Fail-open: If Redis is unavailable or misconfigured, all cache operations degrade
// gracefully to null/no-op. Analysis continues normally — just without caching.

import { createClient, RedisClientType } from "redis";
import { logger } from "./logger";

const CACHE_KEY_PREFIX = "prism:openai:";
const CACHE_TTL_SECONDS = Number(process.env.OPENAI_CACHE_TTL_SECONDS || 3600);

let redisClient: RedisClientType | null = null;

// Once set to true, all cache operations are skipped for the lifetime of the process.
// This is set on the first failed connection attempt to avoid repeated connection
// overhead on every cache call when Redis is misconfigured or unreachable.
let redisDisabled = false;

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  return "Unknown error";
};

// Builds a Redis client from environment config.
// Accepts either a full connection URL (REDIS_URL) or individual host/port/auth vars
// (REDIS_HOST, REDIS_PORT, REDIS_USERNAME, REDIS_PASSWORD). Railway injects REDIS_URL
// automatically when a Redis addon is attached to the project.
const buildRedisClient = (): RedisClientType => {
  const redisUrl = process.env.REDIS_URL;
  if (redisUrl) {
    return createClient({ url: redisUrl });
  }

  const host = process.env.REDIS_HOST;
  const port = process.env.REDIS_PORT ? Number(process.env.REDIS_PORT) : undefined;

  if (!host || !port) {
    throw new Error("Redis is not configured. Set REDIS_URL or REDIS_HOST + REDIS_PORT.");
  }

  return createClient({
    username: process.env.REDIS_USERNAME,
    password: process.env.REDIS_PASSWORD,
    socket: {
      host,
      port,
    },
  });
};

// Returns the shared Redis client, connecting lazily on first use.
// Returns null if Redis is disabled (failed previously) or if the connection fails,
// allowing all callers to treat null as a cache miss without error handling of their own.
const getRedisClient = async (): Promise<RedisClientType | null> => {
  if (redisDisabled) return null;
  if (redisClient?.isOpen) return redisClient;

  try {
    if (!redisClient) {
      redisClient = buildRedisClient();
      redisClient.on("error", (err) => {
        logger.error({ message: err.message }, "Redis client error");
      });
    }

    if (!redisClient.isOpen) {
      await redisClient.connect();
      logger.info("Redis connected for OpenAI cache");
    }

    return redisClient;
  } catch (err: unknown) {
    logger.error({
      message: getErrorMessage(err),
    }, "Failed to connect to Redis; cache disabled for this runtime");
    redisDisabled = true;
    return null;
  }
};

// Builds the full Redis key for a cache entry.
// When an installationId is provided, the key is scoped to that tenant to prevent
// cross-tenant cache hits. Falls back to the global prefix for unauthenticated contexts.
const normalizeKey = (key: string, installationId?: number): string => {
  const prefix = installationId ? `prism:${installationId}:openai:` : CACHE_KEY_PREFIX;
  return `${prefix}${key}`;
};

// Looks up a cached OpenAI response by its content hash key.
// Returns null on a cache miss, a Redis error, or when the cache is disabled —
// callers should treat null as "no cached result, proceed with the API call".
// The installationId scopes the lookup to the correct tenant namespace.
export const getCachedOpenAIResponse = async (key: string, installationId?: number): Promise<string | null> => {
  const client = await getRedisClient();
  if (!client) return null;

  try {
    return await client.get(normalizeKey(key, installationId));
  } catch (err: unknown) {
    logger.error({ message: getErrorMessage(err) }, "Failed to read from Redis cache");
    return null;
  }
};

// Stores an OpenAI response in Redis with a rolling TTL.
// The key should be the SHA-256 hash produced by buildCacheKey in openaiService.ts,
// which encodes the model settings, file content, and all context inputs.
// Write failures are logged and swallowed — a failed cache write does not affect
// the analysis result that was already returned to the caller.
export const setCachedOpenAIResponse = async (key: string, value: string, installationId?: number): Promise<void> => {
  const client = await getRedisClient();
  if (!client) return;

  try {
    await client.set(normalizeKey(key, installationId), value, { EX: CACHE_TTL_SECONDS });
  } catch (err: unknown) {
    logger.error({ message: getErrorMessage(err) }, "Failed to write to Redis cache");
  }
};
