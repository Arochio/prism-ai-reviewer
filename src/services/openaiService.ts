import OpenAI from 'openai';
import crypto from 'crypto';
import { openAIConfig } from "../config/openai.config";
import { storeEmbedding } from './vectorService';
import { getCachedOpenAIResponse, setCachedOpenAIResponse } from "./cacheService";
import { extractDiff, type AnalyzableFile, type ProcessedFile } from '../pipeline/extractDiff';
import { retrieveContext } from '../pipeline/retrieveContext';
import { runBugPass } from '../pipeline/analyze/bugPass';
import { runDesignPass } from '../pipeline/analyze/designPass';
import { runPerformancePass } from '../pipeline/analyze/performancePass';
import { runValidationPass } from '../pipeline/analyze/validationPass';
import { rankFindings } from '../pipeline/rankFindings';
import { generateSummary } from '../pipeline/generateSummary';
import { fetchRepoContext, type RepoInfo } from '../pipeline/fetchRepoContext';
import { logger } from './logger';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Converts unknown errors into a stable log message.
const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  return "Unknown error";
};

// Builds a deterministic cache key by hashing model settings and full file content.
const buildCacheKey = (files: ProcessedFile[]): string => {
  const hash = crypto.createHash('sha256');
  hash.update(openAIConfig.model);
  hash.update(String(openAIConfig.maxTokens));
  hash.update(String(openAIConfig.temperature));
  hash.update(String(openAIConfig.fileContentSizeLimit));
  hash.update(String(openAIConfig.totalFilesLimit));
  for (const file of files) {
    hash.update(file.filename);
    hash.update(file.content);
  }
  return hash.digest('hex');
};

// Sends a single chat completion request to the OpenAI API using shared config.
// The OpenAI SDK handles retries (2 by default) and rate-limit backoff automatically.
export const callOpenAI = async (systemPrompt: string, userContent: string): Promise<string> => {
  let result: string | null;
  try {
    const completion = await openai.chat.completions.create({
      model: openAIConfig.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
      max_tokens: openAIConfig.maxTokens,
      temperature: openAIConfig.temperature,
      top_p: openAIConfig.topP,
      n: openAIConfig.n,
      frequency_penalty: openAIConfig.frequencyPenalty,
      presence_penalty: openAIConfig.presencePenalty,
    });
    result = completion.choices?.[0]?.message?.content;
  } catch (err: unknown) {
    const status = err instanceof OpenAI.APIError ? err.status : undefined;
    logger.error({
      status,
      message: getErrorMessage(err),
    }, "OpenAI API request failed");
    throw new Error(`OpenAI API request failed${status ? ` (status ${status})` : ""}`);
  }

  if (!result) {
    logger.error("OpenAI returned an empty or unexpected response");
    throw new Error("OpenAI returned no content in response");
  }

  return result;
};

// Orchestrates the multi-pass analysis pipeline and returns a formatted PR review comment.
export const analyzeFiles = async (files: AnalyzableFile[], prNumber: number, repoInfo: RepoInfo): Promise<string> => {
  const processedFiles = extractDiff(files);

  if (processedFiles.length === 0) {
    return "No files to analyze (bypassed due to large size or removed files).";
  }

  const cacheKey = buildCacheKey(processedFiles);
  if (openAIConfig.enableCache) {
    // Returns early on cache hit to avoid duplicate OpenAI requests.
    const cached = await getCachedOpenAIResponse(cacheKey);
    if (cached) {
      return cached;
    }
  }

  // Enriches files with vector similarity context before analysis passes.
  const enrichedFiles = openAIConfig.enableEmbeddings
    ? await retrieveContext(processedFiles)
    : processedFiles;

  // Fetches full repository context (file tree + related file contents + custom rules).
  const { repoContext, customRules } = await fetchRepoContext(repoInfo, enrichedFiles);

  // Runs analysis passes sequentially to stay within TPM rate limits.
  const bugRaw = await runBugPass(enrichedFiles, callOpenAI, repoContext, customRules);
  const designRaw = await runDesignPass(enrichedFiles, callOpenAI, repoContext, customRules);
  const performanceRaw = await runPerformancePass(enrichedFiles, callOpenAI, repoContext, customRules);

  // Validates findings to filter false positives, duplicates, and speculative issues.
  const { bugValidated, designValidated, performanceValidated } = await runValidationPass(
    bugRaw, designRaw, performanceRaw,
    enrichedFiles, repoContext, customRules, callOpenAI
  );

  const ranked = rankFindings(bugValidated, designValidated, performanceValidated);
  const summary = generateSummary(ranked);

  if (openAIConfig.enableCache) {
    // Persists successful responses for subsequent identical requests.
    await setCachedOpenAIResponse(cacheKey, summary);
  }

  // Stores embeddings with truncated content for RAG retrieval on future PRs.
  // Content is capped at 2000 chars to stay within Pinecone's 40KB metadata limit.
  for (const file of enrichedFiles) {
    if (file.embedding) {
      await storeEmbedding(`pr-${prNumber}-${file.filename}`, file.embedding, {
        prNumber,
        filename: file.filename,
        content: file.content.slice(0, 2000),
      });
    }
  }

  return summary;
};