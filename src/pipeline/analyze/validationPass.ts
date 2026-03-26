// Validation pass: reviews raw findings from all analysis passes and filters out
// false positives, duplicates, and speculative issues before ranking.
import type { ProcessedFile } from '../extractDiff';

const VALIDATION_SYSTEM_PROMPT =
  'You are a strict code review validator. You are given a list of findings produced by automated analysis passes, ' +
  'along with the actual source code those findings refer to.\n\n' +
  'Your job is to FILTER the findings. Remove any finding that:\n' +
  '1. Is a FALSE POSITIVE — the issue it describes is already handled in the code (try/catch, guards, defaults, null coalescing, validation, fallbacks, config bounds, .slice() limits).\n' +
  '2. Is SPECULATIVE — describes a hypothetical scenario that cannot happen given the code\'s actual constraints (e.g. bounded inputs, middleware guarantees, type system guarantees).\n' +
  '3. Is a DUPLICATE — the same issue is reported by multiple passes or repeated within a single pass.\n' +
  '4. MISREADS THE CODE — the finding describes behavior that contradicts what the code actually does (e.g. claims something is "not handled" when it clearly is).\n' +
  '5. Is OUT OF SCOPE — a bug pass finding about design, a design finding about performance, etc.\n' +
  '6. Is VAGUE — does not quote a specific code snippet or cannot be tied to a concrete line/function.\n' +
  '7. Describes STANDARD LANGUAGE BEHAVIOR as a bug (e.g. .slice() on a short array, JSON.stringify on a parsed object).\n\n' +
  'For each finding in the input, output one of:\n' +
  '- `KEEP: - [<severity>] <original finding text>` — if the finding is valid and grounded in real code.\n' +
  '- `DROP: <original finding text> — Reason: <one-sentence explanation>` — if the finding should be removed.\n\n' +
  'If a <custom_review_rules> section is present, also DROP any finding that violates those rules (e.g. a rule says "do not flag X" and the finding flags X).\n\n' +
  'Be aggressive about dropping. A review with zero findings is better than a review with false positives.\n' +
  'Do NOT add new findings. Do NOT modify the text of kept findings. Only output KEEP or DROP lines.';

const buildValidationContent = (
  findings: string,
  files: ProcessedFile[],
  repoContext: string,
  customRules: string
): string => {
  const codeSection = files
    .map((f) => `---\nFilename: ${f.filename}\nStatus: ${f.status}\n\n${f.content}`)
    .join('\n\n');
  return `${repoContext}${customRules}\n\n<source_code>\n${codeSection}\n</source_code>\n\n<findings_to_validate>\n${findings}\n</findings_to_validate>`;
};

// Extracts the kept findings from the validator output.
const parseValidatedFindings = (raw: string): string[] =>
  raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('KEEP:'))
    .map((l) => l.replace(/^KEEP:\s*/, '').trim())
    .filter((l) => l.startsWith('- ['));

export const runValidationPass = async (
  bugRaw: string,
  designRaw: string,
  performanceRaw: string,
  files: ProcessedFile[],
  repoContext: string,
  customRules: string,
  callOpenAI: (systemPrompt: string, userContent: string) => Promise<string>
): Promise<{ bugValidated: string; designValidated: string; performanceValidated: string }> => {
  // Combine all findings with pass labels for the validator.
  const allFindings = [
    '## Bugs & Security\n' + bugRaw,
    '## Design\n' + designRaw,
    '## Performance\n' + performanceRaw,
  ].join('\n\n');

  const validatorOutput = await callOpenAI(
    VALIDATION_SYSTEM_PROMPT,
    buildValidationContent(allFindings, files, repoContext, customRules)
  );

  const keptLines = parseValidatedFindings(validatorOutput);

  // Re-split kept findings back into their original pass buckets based on content matching.
  const bugBullets = keptLines.filter((l) => bugRaw.includes(l.replace(/^- /, '- ')) || bugRaw.includes(l));
  const designBullets = keptLines.filter((l) => designRaw.includes(l.replace(/^- /, '- ')) || designRaw.includes(l));
  const perfBullets = keptLines.filter((l) => performanceRaw.includes(l.replace(/^- /, '- ')) || performanceRaw.includes(l));

  return {
    bugValidated: bugBullets.length > 0 ? bugBullets.join('\n') : 'No bug findings.',
    designValidated: designBullets.length > 0 ? designBullets.join('\n') : 'No design findings.',
    performanceValidated: perfBullets.length > 0 ? perfBullets.join('\n') : 'No performance findings.',
  };
};
