import axios from "axios";
import { openAIConfig } from "../config/openai.config";

const openAICache = new Map<string, string>();

const buildCacheKey = (files: any[]) => {
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
export const analyzeFiles = async (files: any[]) => {
  const limitedFiles = files.slice(0, openAIConfig.totalFilesLimit);

  const processedFiles = limitedFiles
    .filter((f) => f.status !== "removed")
    .filter((f) => {
      const contentLength = (f.content || "").length;
      if (!openAIConfig.bypassLargeFiles) return true;
      return contentLength <= openAIConfig.fileContentSizeLimit;
    })
    .map((f) => ({
      ...f,
      content:
        (f.content || "").slice(0, openAIConfig.fileContentSizeLimit) +
        ((f.content || "").length > openAIConfig.fileContentSizeLimit
          ? "\n\n...truncated..."
          : ""),
    }));

  if (processedFiles.length === 0) {
    return "No files to analyze (bypassed due to large size or removed files).";
  }

  const cacheKey = buildCacheKey(processedFiles);
  if (openAIConfig.enableCache && openAICache.has(cacheKey)) {
    return openAICache.get(cacheKey)!;
  }

  const prompt = [
    { role: "system", content: openAIConfig.textPromptPrefix },
    {
      role: "user",
      content: processedFiles
        .map(
          (f) => `---\nFilename: ${f.filename}\nStatus: ${f.status}\n\n${f.content}`
        )
        .join("\n\n"),
    },
  ];

  const response = await axios.post(
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

  const result = response.data.choices?.[0]?.message?.content ?? "";

  if (openAIConfig.enableCache) {
    openAICache.set(cacheKey, result);
  }

  return result;
};