import OpenAI from 'openai';
import crypto from 'crypto';
import { openAIConfig } from "../config/openai.config";
import { getPlan } from "../config/plans";
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
import { generateFixes, type CodeSuggestion } from '../pipeline/generateFixes';
import { splitFindings, type InlineFinding } from '../pipeline/splitFindings';
import { fetchRepoContext, type RepoInfo } from '../pipeline/fetchRepoContext';
import { assessPRRisk } from './riskService';
import { assessCodeValue } from '../pipeline/assessCodeValue';
import { updateDeveloperProfile } from './developerProfileService';
import { suggestReviewers } from './reviewerSuggestionService';
import { logger } from './logger';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Converts unknown errors into a stable log message.
const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  return "Unknown error";
};

// Builds a deterministic cache key by hashing model settings, file content, and all context
// that influences the analysis output (repo context, custom rules, risk signals).
const buildCacheKey = (files: ProcessedFile[], repoContext: string, customRules: string): string => {
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
  hash.update(repoContext);
  hash.update(customRules);
  return hash.digest('hex');
};

// Sends a single chat completion request to the OpenAI API using shared config.
// The OpenAI SDK handles retries (2 by default) and rate-limit backoff automatically.
export const callOpenAI = async (systemPrompt: string, userContent: string, model?: string): Promise<string> => {
  let result: string | null;
  try {
    const completion = await openai.chat.completions.create({
      model: model ?? openAIConfig.model,
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
    throw new Error(`OpenAI API request failed${status ? ` (status ${status})` : ""}`, { cause: err });
  }

  if (!result) {
    logger.error("OpenAI returned an empty or unexpected response");
    throw new Error("OpenAI returned no content in response");
  }

  return result;
};

export interface AnalysisResult {
  summary: string;
  suggestions: CodeSuggestion[];
  inlineFindings: InlineFinding[];
  nonInlineResults: import('../pipeline/rankFindings').PassResult[];
  recommendations: string[];
}

// Orchestrates the multi-pass analysis pipeline and returns a formatted PR review comment.
export const analyzeFiles = async (files: AnalyzableFile[], prNumber: number, repoInfo: RepoInfo, author?: string): Promise<AnalysisResult> => {
  const processedFiles = extractDiff(files);

  if (processedFiles.length === 0) {
    return { summary: "No files to analyze (bypassed due to large size or removed files).", suggestions: [], inlineFindings: [], nonInlineResults: [], recommendations: [] };
  }

  const planFeatures = getPlan(repoInfo.planSlug ?? 'free').features;

  // Enriches files with vector similarity context before analysis passes.
  const enrichedFiles = openAIConfig.enableEmbeddings && planFeatures.ragContext
    ? await retrieveContext(processedFiles, repoInfo.installationId)
    : processedFiles;

  // Fetches full repository context (file tree + related file contents + custom rules).
  const { repoContext, customRules: rawCustomRules } = await fetchRepoContext(repoInfo, enrichedFiles);
  // Custom rules are a paid feature — strip them for plans that don't include it.
  const customRules = planFeatures.customRules ? rawCustomRules : '';

  // Computes PR risk score from git history.
  const riskAssessment = planFeatures.riskScoring
    ? await assessPRRisk(
        repoInfo.owner, repoInfo.repo,
        enrichedFiles.map((f) => f.filename),
        repoInfo.installationId
      )
    : { signals: [], recommendations: [] };

  // Inject risk signals into the context so analysis passes are more thorough in risky areas.
  const riskContext = riskAssessment.signals.length > 0
    ? `\n\n<risk_signals>\nThe following risk signals were detected from git history analysis. Use these to calibrate your review intensity — pay extra attention to the areas highlighted below.\n\n${riskAssessment.signals.map((s) => `- ${s}`).join('\n')}\n</risk_signals>`
    : '';
  const augmentedRepoContext = repoContext + riskContext;

  // Cache key now includes repo context, custom rules, and risk signals so that
  // different repos / rule sets / risk states never share cached results.
  const cacheKey = buildCacheKey(enrichedFiles, augmentedRepoContext, customRules);
  if (openAIConfig.enableCache) {
    const cached = await getCachedOpenAIResponse(cacheKey, repoInfo.installationId);
    if (cached) {
      return { summary: cached, suggestions: [], inlineFindings: [], nonInlineResults: [], recommendations: [] };
    }
  }

  // Per-pass callers — each binds its configured model so passes run with the right capability/cost tradeoff.
  const bugCaller        = (sys: string, user: string) => callOpenAI(sys, user, openAIConfig.bugPassModel);
  const designCaller     = (sys: string, user: string) => callOpenAI(sys, user, openAIConfig.designPassModel);
  const performanceCaller = (sys: string, user: string) => callOpenAI(sys, user, openAIConfig.performancePassModel);
  const validationCaller = (sys: string, user: string) => callOpenAI(sys, user, openAIConfig.validationPassModel);

  // Runs analysis passes sequentially to stay within TPM rate limits.
  const bugRaw = await runBugPass(enrichedFiles, bugCaller, augmentedRepoContext, customRules);
  const designRaw: string = planFeatures.designPass
    ? await runDesignPass(enrichedFiles, designCaller, augmentedRepoContext, customRules)
    : '';
  const performanceRaw: string = planFeatures.performancePass
    ? await runPerformancePass(enrichedFiles, performanceCaller, augmentedRepoContext, customRules)
    : '';

  // Validates findings to filter false positives, duplicates, and speculative issues.
  const { bugValidated, designValidated, performanceValidated } = await runValidationPass(
    bugRaw, designRaw, performanceRaw,
    enrichedFiles, augmentedRepoContext, customRules, validationCaller
  );

  const ranked = rankFindings(bugValidated, designValidated, performanceValidated);
  const summary = generateSummary(ranked, riskAssessment.recommendations);

  // Generate fix suggestions (best-effort — review still posts if this fails).
  let suggestions: CodeSuggestion[] = [];
  if (planFeatures.fixSuggestions) {
    try {
      suggestions = await generateFixes(ranked, enrichedFiles, callOpenAI);
    } catch (err: unknown) {
      logger.warn({ message: getErrorMessage(err) }, 'Fix suggestion generation failed — continuing without suggestions');
    }
  }

  // Split findings into inline-eligible (posted on diff lines) and non-inline (kept in summary).
  const { inline: inlineFindings, nonInline: nonInlineResults } = splitFindings(ranked, enrichedFiles, suggestions);

  if (openAIConfig.enableCache) {
    // Persists successful responses for subsequent identical requests.
    await setCachedOpenAIResponse(cacheKey, summary, repoInfo.installationId);
  }

  // Stores embeddings for RAG retrieval on future PRs.
  // Uses a stable per-file ID (repo:owner/repo:path) so repeated reviews of the same
  // file upsert in place rather than accumulating a new vector on every PR.
  // Line-number prefixes added by extractDiff are stripped before storing so the
  // metadata content stays consistent with what push ingestion writes.
  const repoFullName = `${repoInfo.owner}/${repoInfo.repo}`;
  for (const file of enrichedFiles) {
    if (file.embedding) {
      const rawContent = file.content.replace(/^\d+ \| /gm, '').slice(0, 2000);
      await storeEmbedding(`repo:${repoFullName}:${file.filename}`, file.embedding, {
        filename: file.filename,
        content: rawContent,
        source: 'pr-review',
        repo: repoFullName,
      }, repoInfo.installationId);
    }
  }

  // Silently compute code value and update the developer's Pinecone profile.
  // Non-blocking — any failure is caught inside updateDeveloperProfile.
  if (author) {
    const codeValue = assessCodeValue(enrichedFiles, ranked);
    updateDeveloperProfile(author, repoFullName, prNumber, codeValue, enrichedFiles, ranked).catch(() => {
      // already logged inside service
    });
  }

  // Append reviewer suggestion based on accumulated developer profiles.
  // Non-blocking — an empty string is returned on any failure or insufficient data.
  let reviewerSuggestion = '';
  if (author && planFeatures.reviewerSuggestions) {
    try {
      reviewerSuggestion = await suggestReviewers(repoFullName, author, enrichedFiles);
    } catch {
      // logged inside suggestReviewers
    }
  }

  return { summary: summary + reviewerSuggestion, suggestions, inlineFindings, nonInlineResults, recommendations: riskAssessment.recommendations };
};