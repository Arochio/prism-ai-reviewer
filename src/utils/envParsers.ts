// Utility functions for parsing, validating, and sanitising environment variables.

// Parses a numeric env var, returning undefined if missing, empty, or NaN.
export const parseNum = (raw: string | undefined): number | undefined => {
  if (!raw || raw.trim().length === 0) return undefined;
  const n = Number(raw.trim());
  return Number.isFinite(n) ? n : undefined;
};

// Parses a numeric env var and clamps it within [min, max].
export const parseNumClamped = (raw: string | undefined, min: number, max: number): number | undefined => {
  const n = parseNum(raw);
  return n !== undefined ? Math.min(max, Math.max(min, n)) : undefined;
};

// Parses an integer env var (rejects floats) and clamps it within [min, max].
export const parseIntClamped = (raw: string | undefined, min: number, max: number): number | undefined => {
  const n = parseNum(raw);
  if (n === undefined || !Number.isInteger(n)) return undefined;
  return Math.min(max, Math.max(min, n));
};

// Parses a boolean env var, accepting only "true"/"false" (case-insensitive).
// Throws for any other non-empty value to avoid silent misconfiguration.
export const parseBool = (raw: string | undefined): boolean | undefined => {
  if (!raw) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === 'true') return true;
  if (v === 'false') return false;
  throw new Error(`Invalid boolean value: "${raw}". Expected "true" or "false".`);
};

// Sanitises a model string: trims whitespace and strips characters outside the
// alphanumeric / dash / dot / colon set that OpenAI model IDs use.
export const sanitizeModel = (raw: string | undefined): string | undefined => {
  if (!raw || raw.trim().length === 0) return undefined;
  const sanitized = raw.trim().replace(/[^a-zA-Z0-9\-._:]/g, '');
  return sanitized.length > 0 ? sanitized : undefined;
};
