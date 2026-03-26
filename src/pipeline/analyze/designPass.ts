// Design pass: evaluates architecture, naming, coupling, and maintainability.
import type { ProcessedFile } from '../extractDiff';

const DESIGN_PASS_SYSTEM_PROMPT =
  'You are an expert software architect performing a design review. You are given the full repository file tree, related source files for context, and the specific files that were changed in a pull request. ' +
  'Analyze the changed files in the context of the full repository for design, architecture, and maintainability concerns.\n\n' +
  'Use the repository context to evaluate whether changes fit the existing architecture, follow established patterns, and maintain consistency with the rest of the codebase.\n\n' +
  'Cover:\n' +
  '- Architecture: inappropriate coupling, missing abstractions, violation of SOLID/DRY/YAGNI principles, inconsistency with existing patterns in the repo\n' +
  '- Naming: unclear variable, function, or class names that reduce readability\n' +
  '- Structure: files or functions that are too large or carry too many responsibilities\n' +
  '- API design: inconsistent interfaces, leaky abstractions, poor separation of concerns\n' +
  '- Consistency: deviations from conventions used elsewhere in the codebase\n\n' +
  'If a <past_user_feedback> section is present, use it to calibrate your severity ratings and focus areas. ' +
  'Positive feedback means your approach was valued; negative feedback means you should adjust.\n\n' +
  'For each finding output exactly one bullet:\n' +
  '`- [<severity>] <filename>: <concise description>`\n' +
  'Severity must be one of: High, Medium, Low.\n' +
  'If no issues are found, respond with exactly: No design findings.';

const buildUserContent = (files: ProcessedFile[], repoContext: string): string => {
  const changedSection = files
    .map((f) => `---\nFilename: ${f.filename}\nStatus: ${f.status}\n\n${f.content}${f.similarText}`)
    .join('\n\n');
  return `${repoContext}\n\n<changed_files>\n${changedSection}\n</changed_files>`;
};

/*
 * Runs the design and architecture analysis pass against the provided processed files.
 */
export const runDesignPass = async (
  files: ProcessedFile[],
  callOpenAI: (systemPrompt: string, userContent: string) => Promise<string>,
  repoContext: string
): Promise<string> => {
  return callOpenAI(DESIGN_PASS_SYSTEM_PROMPT, buildUserContent(files, repoContext));
};
