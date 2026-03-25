// Statuses that are permanent failures — no point retrying
const NON_RETRYABLE_STATUSES = new Set([400, 401, 403, 404, 422]);

const isRetryable = (err: any): boolean => {
  const status: number | undefined = err?.response?.status;
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
  let lastErr: any;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;

      if (!isRetryable(err)) {
        console.error(`[retry] ${label} failed with non-retryable error — aborting`, {
          attempt,
          status: err?.response?.status,
          message: err?.message,
        });
        throw err;
      }

      if (attempt === maxAttempts) {
        console.error(`[retry] ${label} failed after ${maxAttempts} attempts`, {
          message: err?.message,
        });
        break;
      }

      const delayMs = baseDelayMs * 2 ** (attempt - 1);
      console.warn(`[retry] ${label} attempt ${attempt} failed — retrying in ${delayMs}ms`, {
        status: err?.response?.status,
        message: err?.message,
      });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastErr;
};
