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
  enableEmbeddings: boolean; // enables embedding generation
  vectorDbTopK: number; // top K vectors to return from vector DB
}

import { parseNumClamped, parseIntClamped, parseBool, sanitizeModel } from '../utils/envParsers';

const defaultConfig: OpenAIConfig = {
  model: "gpt-4o-mini",
  maxTokens: 1200,
  temperature: 0.2,
  topP: 1,
  n: 1,
  frequencyPenalty: 0,
  presencePenalty: 0,
  fileContentSizeLimit: 24_000,
  totalFilesLimit: 8,
  bypassLargeFiles: true,
  enableCache: true,
  enableEmbeddings: true,
  vectorDbTopK: 5,
};

const envConfig: Partial<OpenAIConfig> = {
  model: sanitizeModel(process.env.OPENAI_MODEL),
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
};

export const openAIConfig = {
  ...defaultConfig,
  ...Object.fromEntries(Object.entries(envConfig).filter(([_, v]) => v !== undefined)),
} as OpenAIConfig;
