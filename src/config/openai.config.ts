export interface OpenAIConfig {
  model: string;           // default model for all passes unless overridden
  bugPassModel: string;    // model for the bug/security analysis pass
  designPassModel: string; // model for the design/architecture pass
  performancePassModel: string; // model for the performance pass
  validationPassModel: string;  // model for the validation/filter pass
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
  enableEmbeddings: boolean; // enables embedding generation
  vectorDbTopK: number; // top K vectors to return from vector DB
  repoContextFileLimit: number; // max related repo files to fetch for context
  repoContextSizeLimit: number; // max total chars of repo context sent to model
}

import { parseNumClamped, parseIntClamped, parseBool, sanitizeModel } from '../utils/envParsers';

const defaultConfig: OpenAIConfig = {
  model: "gpt-4o-mini",
  bugPassModel: "gpt-4.1",        // stronger model — catches edge-case logic and security bugs
  designPassModel: "gpt-4o-mini",
  performancePassModel: "gpt-4o-mini",
  validationPassModel: "gpt-4o-mini",
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
  enableEmbeddings: true,
  vectorDbTopK: 5,
  repoContextFileLimit: 15,
  repoContextSizeLimit: 32_000,
};

const envConfig: Partial<OpenAIConfig> = {
  model: sanitizeModel(process.env.OPENAI_MODEL),
  bugPassModel: sanitizeModel(process.env.OPENAI_BUG_PASS_MODEL),
  designPassModel: sanitizeModel(process.env.OPENAI_DESIGN_PASS_MODEL),
  performancePassModel: sanitizeModel(process.env.OPENAI_PERFORMANCE_PASS_MODEL),
  validationPassModel: sanitizeModel(process.env.OPENAI_VALIDATION_PASS_MODEL),
  maxTokens: parseIntClamped(process.env.OPENAI_MAX_TOKENS, 1, 128_000),
  temperature: parseNumClamped(process.env.OPENAI_TEMPERATURE, 0, 2),
  topP: parseNumClamped(process.env.OPENAI_TOP_P, 0, 1),
  n: parseIntClamped(process.env.OPENAI_N, 1, 10),
  frequencyPenalty: parseNumClamped(process.env.OPENAI_FREQUENCY_PENALTY, -2, 2),
  presencePenalty: parseNumClamped(process.env.OPENAI_PRESENCE_PENALTY, -2, 2),
  fileContentSizeLimit: parseIntClamped(process.env.OPENAI_FILE_CONTENT_SIZE_LIMIT, 1, 128_000),
  totalFilesLimit: parseIntClamped(process.env.OPENAI_TOTAL_FILES_LIMIT, 1, 100),
  bypassLargeFiles: parseBool(process.env.OPENAI_BYPASS_LARGE_FILES),
  enableCache: parseBool(process.env.OPENAI_ENABLE_CACHE),
  enableEmbeddings: parseBool(process.env.OPENAI_ENABLE_EMBEDDINGS),
  vectorDbTopK: parseIntClamped(process.env.OPENAI_VECTOR_DB_TOP_K, 1, 100),
  repoContextFileLimit: parseIntClamped(process.env.REPO_CONTEXT_FILE_LIMIT, 1, 50),
  repoContextSizeLimit: parseIntClamped(process.env.REPO_CONTEXT_SIZE_LIMIT, 1, 128_000),
};

export const openAIConfig = {
  ...defaultConfig,
  ...Object.fromEntries(Object.entries(envConfig).filter(([_, v]) => v !== undefined)),
} as OpenAIConfig;
