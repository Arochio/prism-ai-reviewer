// Bug pass: detects correctness errors, security vulnerabilities, and runtime risks.
import type { ProcessedFile } from '../extractDiff';

const BUG_PASS_SYSTEM_PROMPT =
  'You are a security-focused code reviewer. You are given the full repository file tree, related source files for context, and the specific files that were changed in a pull request. ' +
  'Analyze the changed files in the context of the full repository for bugs, security vulnerabilities, and correctness issues.\n\n' +
  'Use the repository context to understand how the changed code interacts with the rest of the codebase — check for mismatched interfaces, incorrect assumptions about callers or dependencies, and cross-file issues.\n\n' +
  'Cover:\n' +
  '- Security: injection flaws, authentication/authorisation bypasses, exposed secrets, OWASP Top 10 issues\n' +
  '- Correctness: logic errors, off-by-one errors, null/undefined dereferences, incorrect assumptions about other parts of the codebase\n' +
  '- Error handling: unhandled exceptions, swallowed errors, missing input validation\n' +
  '- Integration: breaking changes to shared interfaces, incorrect usage of APIs defined elsewhere in the repo\n\n' +
  'If a <past_user_feedback> section is present, use it to calibrate your severity ratings and focus areas. ' +
  'Positive feedback means your approach was valued; negative feedback means you should adjust.\n\n' +
  'For each finding output exactly one bullet:\n' +
  '`- [<severity>] <filename>: <concise description>`\n' +
  'Severity must be one of: Critical, High, Medium, Low.\n' +
  'If no issues are found, respond with exactly: No bug findings.';

const buildUserContent = (files: ProcessedFile[], repoContext: string): string => {
  const changedSection = files
    .map((f) => `---\nFilename: ${f.filename}\nStatus: ${f.status}\n\n${f.content}${f.similarText}`)
    .join('\n\n');
  return `${repoContext}\n\n<changed_files>\n${changedSection}\n</changed_files>`;
};

/*
 * Runs the bug and security analysis pass against the provided processed files.
 */
export const runBugPass = async (
  files: ProcessedFile[],
  callOpenAI: (systemPrompt: string, userContent: string) => Promise<string>,
  repoContext: string
): Promise<string> => {
  return callOpenAI(BUG_PASS_SYSTEM_PROMPT, buildUserContent(files, repoContext));
};
