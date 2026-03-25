import axios from "axios";
import { openAIConfig } from "../config/openai.config";
import { createEmbedding, storeEmbedding, querySimilar } from './vectorService';
import { getCachedOpenAIResponse, setCachedOpenAIResponse } from "./cacheService";

interface AnalyzableFile {
  filename: string;
  status: string;
  content?: string | null;
}

interface ProcessedFile extends AnalyzableFile {
  content: string;
  embedding: number[] | null;
  similarText: string;
}

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  return "Unknown error";
};

const buildCacheKey = (files: AnalyzableFile[]) => {
  const fileKey = files
    .map((file) => `${file.filename}:${(file.content || "").slice(0, 128)}`)
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

// get file analysis for GitHub PR comment
export const analyzeFiles = async (files: AnalyzableFile[], prNumber: number) => {
  const limitedFiles = files.slice(0, openAIConfig.totalFilesLimit);

  const processedFiles: ProcessedFile[] = await Promise.all(
    limitedFiles
      .filter((f) => f.status !== "removed")
      .filter((f) => {
        const contentLength = (f.content || "").length;
        if (!openAIConfig.bypassLargeFiles) return true;
        return contentLength <= openAIConfig.fileContentSizeLimit;
      })
      .map(async (f) => {
        const content = (f.content || "").slice(0, openAIConfig.fileContentSizeLimit) +
          ((f.content || "").length > openAIConfig.fileContentSizeLimit
            ? "\n\n...truncated..."
            : "");

        // Embedding and similarity are best-effort — failures do not block analysis
        let embedding: number[] | null = null;
        let similarText = '';
        try {
          embedding = await createEmbedding(content);
          const similar = await querySimilar(embedding, openAIConfig.vectorDbTopK);
          if (similar.length > 0) {
            similarText = `\n\nSimilar files in codebase: ${similar.map((s) => String(s.metadata?.["filename"] || "unknown")).join(', ')}`;
          }
        } catch (err: unknown) {
          console.error(`Embedding/similarity skipped for ${f.filename}`, { message: getErrorMessage(err) });
        }

        return {
          ...f,
          content,
          embedding,
          similarText,
        };
      })
  );

  if (processedFiles.length === 0) {
    return "No files to analyze (bypassed due to large size or removed files).";
  }

  const cacheKey = buildCacheKey(processedFiles);
  if (openAIConfig.enableCache) {
    const cached = await getCachedOpenAIResponse(cacheKey);
    if (cached) {
      return cached;
    }
  }

  //initial prompt creation
  const prompt = [
    { role: "system", content: openAIConfig.textPromptPrefix },
    {
      role: "user",
      content: processedFiles
        .map(
          (f) => `---\nFilename: ${f.filename}\nStatus: ${f.status}\n\n${f.content}${f.similarText}`
        )
        .join("\n\n"),
    },
  ];

  let response;
  try {
    response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: openAIConfig.model,
        messages: prompt,
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

  if (openAIConfig.enableCache) {
    await setCachedOpenAIResponse(cacheKey, result);
  }

  // Store embeddings after analysis — non-critical, errors are swallowed in storeEmbedding
  for (const file of processedFiles) {
    if (file.embedding) {
      await storeEmbedding(`pr-${prNumber}-${file.filename}`, file.embedding, { prNumber, filename: file.filename });
    }
  }

  return result;
};