import axios from "axios";
import { openAIConfig } from "../config/openai.config";
import { storeEmbedding } from './vectorService';
import { getCachedOpenAIResponse, setCachedOpenAIResponse } from "./cacheService";
import { extractDiff, type AnalyzableFile, type ProcessedFile } from '../pipeline/extractDiff';
import { retrieveContext } from '../pipeline/retrieveContext';
import { runBugPass } from '../pipeline/analyze/bugPass';
import { runDesignPass } from '../pipeline/analyze/designPass';
import { runPerformancePass } from '../pipeline/analyze/performancePass';
import { rankFindings } from '../pipeline/rankFindings';
import { generateSummary } from '../pipeline/generateSummary';

// Converts unknown errors into a stable log message.
const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  return "Unknown error";
};

// Builds a deterministic cache key from model settings and truncated file content.
const buildCacheKey = (files: ProcessedFile[]): string => {
  const fileKey = files
    .map((file) => `${file.filename}:${file.content.slice(0, 128)}`)
    .join("|");
  return [
    openAIConfig.model,
    openAIConfig.maxTokens,
    openAIConfig.temperature,
    openAIConfig.fileContentSizeLimit,
    openAIConfig.totalFilesLimit,
    fileKey,
  ].join("::");
};

// Sends a single chat completion request to the OpenAI API using shared config.
export const callOpenAI = async (systemPrompt: string, userContent: string): Promise<string> => {
  let response;
  try {
    response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
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
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );
  } catch (err: unknown) {
    const status = axios.isAxiosError(err) ? err.response?.status : undefined;
    const data = axios.isAxiosError(err) ? err.response?.data : undefined;
    console.error("OpenAI API request failed", {
      status,
      data,
      message: getErrorMessage(err),
    });
    throw err;
  }

  const result: string = response.data.choices?.[0]?.message?.content;
  if (!result) {
    console.error("OpenAI returned an empty or unexpected response", { data: response.data });
    throw new Error("OpenAI returned no content in response");
  }

  return result;
};

// Orchestrates the multi-pass analysis pipeline and returns a formatted PR review comment.
export const analyzeFiles = async (files: AnalyzableFile[], prNumber: number): Promise<string> => {
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

  // Runs all three analysis passes in parallel to reduce total latency.
  const [bugRaw, designRaw, performanceRaw] = await Promise.all([
    runBugPass(enrichedFiles, callOpenAI),
    runDesignPass(enrichedFiles, callOpenAI),
    runPerformancePass(enrichedFiles, callOpenAI),
  ]);

  const ranked = rankFindings(bugRaw, designRaw, performanceRaw);
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