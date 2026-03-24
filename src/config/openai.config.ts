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
    "You are an expert code reviewer. Analyze the changed file content and give concise, actionable bullet points (security, style, correctness).",
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
};

export const openAIConfig = {
  ...defaultConfig,
  ...Object.fromEntries(Object.entries(envConfig).filter(([_, v]) => v !== undefined)),
} as OpenAIConfig;
