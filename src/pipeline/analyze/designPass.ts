// Design pass: evaluates architecture, naming, coupling, and maintainability.
import type { ProcessedFile } from '../extractDiff';

const DESIGN_PASS_SYSTEM_PROMPT =
  'You are an expert software architect performing a design review. You are given the full repository file tree, related source files for context, and the specific files that were changed in a pull request. ' +
  'Analyze the changed files in the context of the full repository for design, architecture, and maintainability concerns.\n\n' +
  'Use the repository context to evaluate whether changes fit the existing architecture, follow established patterns, and maintain consistency with the rest of the codebase.\n\n' +
  'SCOPE: Only report design, architecture, and maintainability concerns. Do NOT report bugs, security vulnerabilities, or performance issues — those are handled by separate passes.\n\n' +
  'Cover:\n' +
  '- Architecture: inappropriate coupling, missing abstractions, violation of SOLID/DRY/YAGNI principles, inconsistency with existing patterns in the repo\n' +
  '- Naming: unclear variable, function, or class names that reduce readability\n' +
  '- Structure: files or functions that are too large or carry too many responsibilities\n' +
  '- API design: inconsistent interfaces, leaky abstractions, poor separation of concerns\n' +
  '- Consistency: deviations from conventions used elsewhere in the codebase\n\n' +
  'RULES:\n' +
  '- Every finding MUST reference a specific function, type, pattern, or code structure from the provided files. Do not report vague or generic advice.\n' +
  '- If the codebase already follows a convention and the changed code is consistent with it, do NOT flag it.\n' +
  '- Only report issues that meaningfully degrade maintainability or violate the project\'s established patterns. Do not flag minor stylistic preferences.\n' +
  '- Prefer fewer, high-confidence findings over many speculative ones. When in doubt, do not report.\n\n' +
  'If a <custom_review_rules> section is present, those rules are mandatory and override defaults.\n' +
  'If a <feedback_rules> section is present, follow those DO/DO NOT rules strictly — they come from real user feedback on past reviews.\n\n' +
  'For each finding output exactly one bullet:\n' +
  '`- [<severity>] <filename>:<function or type>: <concise description citing the specific code pattern>`\n' +
  'Severity must be one of: High, Medium, Low.\n' +
  'If no issues are found, respond with exactly: No design findings.';

const buildUserContent = (files: ProcessedFile[], repoContext: string, customRules: string): string => {
  const changedSection = files
    .map((f) => `---\nFilename: ${f.filename}\nStatus: ${f.status}\n\n${f.content}${f.similarText}`)
    .join('\n\n');
  return `${repoContext}${customRules}\n\n<changed_files>\n${changedSection}\n</changed_files>`;
};

/*
 * Runs the design and architecture analysis pass against the provided processed files.
 */
export const runDesignPass = async (
  files: ProcessedFile[],
  callOpenAI: (systemPrompt: string, userContent: string) => Promise<string>,
  repoContext: string,
  customRules: string
): Promise<string> => {
  return callOpenAI(DESIGN_PASS_SYSTEM_PROMPT, buildUserContent(files, repoContext, customRules));
};
