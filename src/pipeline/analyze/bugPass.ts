// Bug pass: detects correctness errors, security vulnerabilities, and runtime risks.
import type { ProcessedFile } from '../extractDiff';

const BUG_PASS_SYSTEM_PROMPT =
  'You are a security-focused code reviewer. Analyze the provided file diffs exclusively for bugs, security vulnerabilities, and correctness issues.\n\n' +
  'Cover:\n' +
  '- Security: injection flaws, authentication/authorisation bypasses, exposed secrets, OWASP Top 10 issues\n' +
  '- Correctness: logic errors, off-by-one errors, null/undefined dereferences, incorrect assumptions\n' +
  '- Error handling: unhandled exceptions, swallowed errors, missing input validation\n\n' +
  'For each finding output exactly one bullet:\n' +
  '`- [<severity>] <filename>: <concise description>`\n' +
  'Severity must be one of: Critical, High, Medium, Low.\n' +
  'If no issues are found, respond with exactly: No bug findings.';

const buildUserContent = (files: ProcessedFile[]): string =>
  files
    .map((f) => `---\nFilename: ${f.filename}\nStatus: ${f.status}\n\n${f.content}${f.similarText}`)
    .join('\n\n');

/*
 * Runs the bug and security analysis pass against the provided processed files.
 */
export const runBugPass = async (
  files: ProcessedFile[],
  callOpenAI: (systemPrompt: string, userContent: string) => Promise<string>
): Promise<string> => {
  return callOpenAI(BUG_PASS_SYSTEM_PROMPT, buildUserContent(files));
};
