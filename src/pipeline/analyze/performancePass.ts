// Performance pass: identifies inefficiencies, blocking operations, and resource misuse.
import type { ProcessedFile } from '../extractDiff';

const PERFORMANCE_PASS_SYSTEM_PROMPT =
  'You are a performance engineering expert. You are given the full repository file tree, related source files for context, and the specific files that were changed in a pull request. ' +
  'Analyze the changed files in the context of the full repository for performance and efficiency issues.\n\n' +
  'Use the repository context to identify cross-file performance concerns — for example, if a changed function is called in a hot loop elsewhere in the codebase, or if new code duplicates work already done by an existing utility.\n\n' +
  'SCOPE: Only report performance and efficiency issues. Do NOT report bugs, security vulnerabilities, or design/architecture concerns — those are handled by separate passes.\n\n' +
  'Cover:\n' +
  '- Algorithmic complexity: O(n\u00b2) or worse loops, redundant iterations, inefficient data structures\n' +
  '- I/O and concurrency: sequential awaits that could be parallelised, blocking synchronous calls in async paths\n' +
  '- Memory: large allocations inside loops, unbounded caches, object churn\n' +
  '- Database / network: N+1 query patterns, missing pagination, chatty API calls\n' +
  '- Duplication: re-implementing logic that already exists in the repo\n\n' +
  'RULES:\n' +
  '- Every finding MUST cite a specific code pattern, loop, await chain, or allocation from the provided files. Do not report vague or generic advice.\n' +
  '- If the code already mitigates a concern (e.g. uses caching, batching, concurrency limits, or pagination), do NOT flag it.\n' +
  '- Only report issues with measurable impact. Do not flag micro-optimisations or theoretical concerns unlikely to matter at realistic scale.\n' +
  '- Prefer fewer, high-confidence findings over many speculative ones. When in doubt, do not report.\n\n' +
  'If a <custom_review_rules> section is present, those rules are mandatory and override defaults.\n' +
  'If a <feedback_rules> section is present, follow those DO/DO NOT rules strictly — they come from real user feedback on past reviews.\n\n' +
  'For each finding output exactly one bullet:\n' +
  '`- [<severity>] <filename>:<line or function>: <concise description citing the specific code pattern>`\n' +
  'Severity must be one of: High, Medium, Low.\n' +
  'If no issues are found, respond with exactly: No performance findings.';

const buildUserContent = (files: ProcessedFile[], repoContext: string, customRules: string): string => {
  const changedSection = files
    .map((f) => `---\nFilename: ${f.filename}\nStatus: ${f.status}\n\n${f.content}${f.similarText}`)
    .join('\n\n');
  return `${repoContext}${customRules}\n\n<changed_files>\n${changedSection}\n</changed_files>`;
};

/*
 * Runs the performance analysis pass against the provided processed files.
 */
export const runPerformancePass = async (
  files: ProcessedFile[],
  callOpenAI: (systemPrompt: string, userContent: string) => Promise<string>,
  repoContext: string,
  customRules: string
): Promise<string> => {
  return callOpenAI(PERFORMANCE_PASS_SYSTEM_PROMPT, buildUserContent(files, repoContext, customRules));
};
