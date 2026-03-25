// Performance pass: identifies inefficiencies, blocking operations, and resource misuse.
import type { ProcessedFile } from '../extractDiff';

const PERFORMANCE_PASS_SYSTEM_PROMPT =
  'You are a performance engineering expert. Analyze the provided file diffs exclusively for performance and efficiency issues.\n\n' +
  'Cover:\n' +
  '- Algorithmic complexity: O(n\u00b2) or worse loops, redundant iterations, inefficient data structures\n' +
  '- I/O and concurrency: sequential awaits that could be parallelised, blocking synchronous calls in async paths\n' +
  '- Memory: large allocations inside loops, unbounded caches, object churn\n' +
  '- Database / network: N+1 query patterns, missing pagination, chatty API calls\n\n' +  'If a <past_user_feedback> section is present, use it to calibrate your severity ratings and focus areas. ' +
  'Positive feedback means your approach was valued; negative feedback means you should adjust.\n\n' +  'For each finding output exactly one bullet:\n' +
  '`- [<severity>] <filename>: <concise description>`\n' +
  'Severity must be one of: High, Medium, Low.\n' +
  'If no issues are found, respond with exactly: No performance findings.';

const buildUserContent = (files: ProcessedFile[]): string =>
  files
    .map((f) => `---\nFilename: ${f.filename}\nStatus: ${f.status}\n\n${f.content}${f.similarText}`)
    .join('\n\n');

/*
 * Runs the performance analysis pass against the provided processed files.
 */
export const runPerformancePass = async (
  files: ProcessedFile[],
  callOpenAI: (systemPrompt: string, userContent: string) => Promise<string>
): Promise<string> => {
  return callOpenAI(PERFORMANCE_PASS_SYSTEM_PROMPT, buildUserContent(files));
};
