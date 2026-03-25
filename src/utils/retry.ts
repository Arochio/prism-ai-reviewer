// Statuses that are permanent failures — no point retrying
import { logger } from "../services/logger";

// Statuses that are permanent failures — no point retrying
const NON_RETRYABLE_STATUSES = new Set([400, 401, 403, 404, 422]);

// Extracts HTTP status from unknown error objects when available.
const getStatusCode = (error: unknown): number | undefined => {
  if (typeof error === "object" && error !== null && "response" in error) {
    const response = (error as { response?: { status?: number } }).response;
    return response?.status;
  }
  return undefined;
};

// Normalizes unknown errors into a message string.
const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  return "Unknown error";
};

// Determines whether an error should be retried.
const isRetryable = (err: unknown): boolean => {
  const status = getStatusCode(err);
  if (status !== undefined && NON_RETRYABLE_STATUSES.has(status)) return false;
  return true;
};

/**
 * Retries an async function up to `maxAttempts` times with exponential backoff.
 * Non-retryable HTTP errors (4xx except 429) are thrown immediately.
 *
 * @param fn - The async function to retry
 * @param maxAttempts - Total attempts including the first (default: 3)
 * @param baseDelayMs - Initial delay in ms; doubles each attempt (default: 1000)
 * @param label - Label used in log output to identify the operation
 */
export const retryWithBackoff = async <T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  baseDelayMs = 1000,
  label = "operation"
): Promise<T> => {
  let lastErr: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastErr = err;

      if (!isRetryable(err)) {
        logger.error({
          attempt,
          status: getStatusCode(err),
          message: getErrorMessage(err),
        }, `[retry] ${label} failed with non-retryable error — aborting`);
        throw err;
      }

      if (attempt === maxAttempts) {
        logger.error({
          message: getErrorMessage(err),
        }, `[retry] ${label} failed after ${maxAttempts} attempts`);
        break;
      }

      const delayMs = baseDelayMs * 2 ** (attempt - 1);
      logger.warn({
        status: getStatusCode(err),
        message: getErrorMessage(err),
      }, `[retry] ${label} attempt ${attempt} failed — retrying in ${delayMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastErr;
};
