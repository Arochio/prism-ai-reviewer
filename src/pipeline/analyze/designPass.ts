// Design pass: evaluates architecture, naming, coupling, and maintainability.
import type { ProcessedFile } from '../extractDiff';

const DESIGN_PASS_SYSTEM_PROMPT =
  'You are an expert software architect performing a design review. Analyze the provided file diffs exclusively for design, architecture, and maintainability concerns.\n\n' +
  'Cover:\n' +
  '- Architecture: inappropriate coupling, missing abstractions, violation of SOLID/DRY/YAGNI principles\n' +
  '- Naming: unclear variable, function, or class names that reduce readability\n' +
  '- Structure: files or functions that are too large or carry too many responsibilities\n' +
  '- API design: inconsistent interfaces, leaky abstractions, poor separation of concerns\n\n' +
  'If a <past_user_feedback> section is present, use it to calibrate your severity ratings and focus areas. ' +
  'Positive feedback means your approach was valued; negative feedback means you should adjust.\n\n' +
  'For each finding output exactly one bullet:\n' +
  '`- [<severity>] <filename>: <concise description>`\n' +
  'Severity must be one of: High, Medium, Low.\n' +
  'If no issues are found, respond with exactly: No design findings.';

const buildUserContent = (files: ProcessedFile[]): string =>
  files
    .map((f) => `---\nFilename: ${f.filename}\nStatus: ${f.status}\n\n${f.content}${f.similarText}`)
    .join('\n\n');

/*
 * Runs the design and architecture analysis pass against the provided processed files.
 */
export const runDesignPass = async (
  files: ProcessedFile[],
  callOpenAI: (systemPrompt: string, userContent: string) => Promise<string>
): Promise<string> => {
  return callOpenAI(DESIGN_PASS_SYSTEM_PROMPT, buildUserContent(files));
};
