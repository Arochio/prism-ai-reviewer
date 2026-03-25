import { createClient, RedisClientType } from "redis";

const CACHE_KEY_PREFIX = "prism:openai:";
const CACHE_TTL_SECONDS = Number(process.env.OPENAI_CACHE_TTL_SECONDS || 3600);

let redisClient: RedisClientType | null = null;
let redisDisabled = false;

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  return "Unknown error";
};

// Builds a Redis client from either URL form or host/port credentials.
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

const getRedisClient = async (): Promise<RedisClientType | null> => {
  if (redisDisabled) return null;
  if (redisClient?.isOpen) return redisClient;

  try {
    if (!redisClient) {
      redisClient = buildRedisClient();
      redisClient.on("error", (err) => {
        console.error("Redis client error", { message: err.message });
      });
    }

    if (!redisClient.isOpen) {
      await redisClient.connect();
      console.log("Redis connected for OpenAI cache");
    }

    return redisClient;
  } catch (err: unknown) {
    console.error("Failed to connect to Redis; cache disabled for this runtime", {
      message: getErrorMessage(err),
    });
    redisDisabled = true;
    return null;
  }
};

const normalizeKey = (key: string): string => `${CACHE_KEY_PREFIX}${key}`;

// Reads a cached OpenAI response by key.
export const getCachedOpenAIResponse = async (key: string): Promise<string | null> => {
  const client = await getRedisClient();
  if (!client) return null;

  try {
    return await client.get(normalizeKey(key));
  } catch (err: unknown) {
    console.error("Failed to read from Redis cache", { message: getErrorMessage(err) });
    return null;
  }
};

// Writes a cached OpenAI response with configured TTL.
export const setCachedOpenAIResponse = async (key: string, value: string): Promise<void> => {
  const client = await getRedisClient();
  if (!client) return;

  try {
    await client.set(normalizeKey(key), value, { EX: CACHE_TTL_SECONDS });
  } catch (err: unknown) {
    console.error("Failed to write to Redis cache", { message: getErrorMessage(err) });
  }
};
