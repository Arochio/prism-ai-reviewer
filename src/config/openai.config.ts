export interface OpenAIConfig {
  model: string;
  maxTokens: number;
  temperature: number;
  topP: number;
  n: number;
  frequencyPenalty: number;
  presencePenalty: number;
  fileContentSizeLimit: number; // max chars to send per file
  totalFilesLimit: number; // max files to analyze
  bypassLargeFiles: boolean; // skip files exceeding size limit
  enableCache: boolean; // caches OpenAI responses for identical file sets
  textPromptPrefix: string;
  enableEmbeddings: boolean; // enables embedding generation
  vectorDbTopK: number; // top K vectors to return from vector DB
}

const defaultConfig: OpenAIConfig = {
  model: "gpt-4o-mini",
  maxTokens: 1200,
  temperature: 0.2,
  topP: 1,
  n: 1,
  frequencyPenalty: 0,
  presencePenalty: 0,
  fileContentSizeLimit: 16_000,
  totalFilesLimit: 8,
  bypassLargeFiles: true,
  enableCache: true,
  textPromptPrefix:
    "You are an expert code reviewer. Analyze the changed file content and provide a structured review with the following sections:\n\n" +
    "**Risk Level**: Assign an overall risk level (🔴 High / 🟡 Medium / 🟢 Low) based on the severity of issues found.\n\n" +
    "**Security**: Identify any vulnerabilities (e.g. injection, auth issues, exposed secrets, OWASP Top 10). Label each finding with [High], [Medium], or [Low] risk.\n\n" +
    "**Correctness**: Flag logic errors, edge cases, null/undefined issues, or incorrect assumptions.\n\n" +
    "**Performance**: Note inefficient algorithms, unnecessary re-renders, blocking calls, or memory concerns.\n\n" +
    "**Style & Maintainability**: Comment on readability, naming conventions, code duplication, and adherence to best practices.\n\n" +
    "**Suggestions**: Provide 1-3 concrete, actionable improvements with brief code examples where helpful.\n\n" +
    "Be concise. Skip sections that have no findings. If similar files were provided, use them for consistency context.",
  enableEmbeddings: true,
  vectorDbTopK: 5,
};

const envConfig: Partial<OpenAIConfig> = {
  model: process.env.OPENAI_MODEL,
  maxTokens: process.env.OPENAI_MAX_TOKENS ? Number(process.env.OPENAI_MAX_TOKENS) : undefined,
  temperature: process.env.OPENAI_TEMPERATURE ? Number(process.env.OPENAI_TEMPERATURE) : undefined,
  topP: process.env.OPENAI_TOP_P ? Number(process.env.OPENAI_TOP_P) : undefined,
  n: process.env.OPENAI_N ? Number(process.env.OPENAI_N) : undefined,
  frequencyPenalty: process.env.OPENAI_FREQUENCY_PENALTY
    ? Number(process.env.OPENAI_FREQUENCY_PENALTY)
    : undefined,
  presencePenalty: process.env.OPENAI_PRESENCE_PENALTY
    ? Number(process.env.OPENAI_PRESENCE_PENALTY)
    : undefined,
  fileContentSizeLimit: process.env.OPENAI_FILE_CONTENT_SIZE_LIMIT
    ? Number(process.env.OPENAI_FILE_CONTENT_SIZE_LIMIT)
    : undefined,
  totalFilesLimit: process.env.OPENAI_TOTAL_FILES_LIMIT
    ? Number(process.env.OPENAI_TOTAL_FILES_LIMIT)
    : undefined,
  bypassLargeFiles: process.env.OPENAI_BYPASS_LARGE_FILES
    ? process.env.OPENAI_BYPASS_LARGE_FILES.toLowerCase() === "true"
    : undefined,
  enableCache: process.env.OPENAI_ENABLE_CACHE
    ? process.env.OPENAI_ENABLE_CACHE.toLowerCase() === "true"
    : undefined,
  textPromptPrefix: process.env.OPENAI_PROMPT_PREFIX,
  enableEmbeddings: process.env.OPENAI_ENABLE_EMBEDDINGS
    ? process.env.OPENAI_ENABLE_EMBEDDINGS.toLowerCase() === "true"
    : undefined,
  vectorDbTopK: process.env.OPENAI_VECTOR_DB_TOP_K
    ? Number(process.env.OPENAI_VECTOR_DB_TOP_K)
    : undefined,
};

export const openAIConfig = {
  ...defaultConfig,
  ...Object.fromEntries(Object.entries(envConfig).filter(([_, v]) => v !== undefined)),
} as OpenAIConfig;
