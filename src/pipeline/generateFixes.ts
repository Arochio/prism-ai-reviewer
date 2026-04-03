// Generates one-click fix suggestions for ranked findings.
// Each suggestion maps to an inline GitHub PR review comment with a ```suggestion block.

import type { ProcessedFile } from './extractDiff';
import type { PassResult } from './rankFindings';
import { logger } from '../services/logger';

export interface CodeSuggestion {
  path: string;
  startLine: number;
  endLine: number;
  suggestedCode: string;
  finding: string;
}

interface ParsedFinding {
  severity: string;
  filename: string;
  line: number;
  description: string;
  raw: string;
}

const MAX_SUGGESTIONS = 5;
const CONTEXT_LINES = 4;
const SEVERITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

const FIX_SYSTEM_PROMPT =
  'You are a precise code repair assistant. Given identified code issues and surrounding context, generate the minimal code change that fixes each issue.\n\n' +
  'RULES:\n' +
  '- Output ONLY valid JSON — an array of fix objects. No markdown fences, no explanation.\n' +
  '- Each fix replaces one or more consecutive source lines with corrected code.\n' +
  '- "start_line" and "end_line" are the 1-based line numbers of the lines to replace (inclusive).\n' +
  '- "suggested_code" is the exact replacement text for those lines, preserving original indentation.\n' +
  '- Keep fixes minimal — change only what is needed to resolve the issue.\n' +
  '- Do NOT add explanatory comments in the code.\n' +
  '- If a finding requires architectural changes, large refactors, or cannot be fixed by replacing a few lines, set "fixable" to false.\n' +
  '- A fix that only adds new lines should use the same start_line and end_line as the line AFTER which code is inserted, and include that existing line in suggested_code followed by the new lines.\n\n' +
  'Output format (JSON array):\n' +
  '[\n' +
  '  { "finding_index": 0, "fixable": true, "start_line": 42, "end_line": 43, "suggested_code": "  const x = bar ?? null;\\n  if (!x) throw new Error(\'missing\');" },\n' +
  '  { "finding_index": 1, "fixable": false }\n' +
  ']';

// Parses the standard finding format: - [Severity] filename:L42: description
const parseFinding = (raw: string): ParsedFinding | null => {
  const match = raw.match(/^-\s*\[(\w+)\]\s+(.+?):L(\d+):\s+(.+)/);
  if (!match) return null;
  return {
    severity: match[1].toLowerCase(),
    filename: match[2],
    line: parseInt(match[3], 10),
    description: match[4],
    raw,
  };
};

// Strips line number prefixes ("42 | code") from processed content, returning raw source lines
const getSourceLines = (content: string): string[] =>
  content.split('\n').map((line) => {
    const m = line.match(/^\d+\s*\|\s?(.*)/);
    return m ? m[1] : line;
  });

// Returns the set of new-file line numbers visible in a unified diff patch.
// Only these lines are eligible for GitHub suggestion comments.
export const getDiffEligibleLines = (patch: string): Set<number> => {
  const eligible = new Set<number>();
  if (!patch) return eligible;
  let newLine = 0;

  for (const line of patch.split('\n')) {
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      newLine = parseInt(hunkMatch[1], 10);
      continue;
    }
    if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('\\')) continue;
    if (line.startsWith('-')) continue; // removed lines have no new-file position
    // Context lines and added (+) lines both occupy a new-file position.
    eligible.add(newLine);
    newLine++;
  }

  return eligible;
};

// Generates code fix suggestions for the highest-severity findings.
export const generateFixes = async (
  ranked: PassResult[],
  files: ProcessedFile[],
  callOpenAI: (systemPrompt: string, userContent: string) => Promise<string>,
): Promise<CodeSuggestion[]> => {
  const allFindings = ranked.flatMap((r) => r.findings);
  const parsed = allFindings.map(parseFinding).filter((f): f is ParsedFinding => f !== null);

  if (parsed.length === 0) return [];

  // Prioritise by severity and cap at MAX_SUGGESTIONS.
  const topFindings = parsed
    .sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 4) - (SEVERITY_ORDER[b.severity] ?? 4))
    .slice(0, MAX_SUGGESTIONS);

  // Build lookup maps.
  const fileMap = new Map(files.map((f) => [f.filename, f]));

  const diffEligibleMap = new Map<string, Set<number>>();
  for (const file of files) {
    if (file.patch) {
      diffEligibleMap.set(file.filename, getDiffEligibleLines(file.patch));
    }
  }

  // Keep only findings whose target line is visible in the diff.
  const eligible = topFindings.filter((f) => {
    const diffLines = diffEligibleMap.get(f.filename);
    return diffLines?.has(f.line);
  });

  if (eligible.length === 0) return [];

  // Build per-finding context for the model.
  const sections = eligible
    .map((f, i) => {
      const file = fileMap.get(f.filename);
      if (!file) return null;

      const sourceLines = getSourceLines(file.content);
      const startCtx = Math.max(0, f.line - 1 - CONTEXT_LINES);
      const endCtx = Math.min(sourceLines.length - 1, f.line - 1 + CONTEXT_LINES);
      const codeContext = sourceLines
        .slice(startCtx, endCtx + 1)
        .map((line, idx) => `${startCtx + idx + 1} | ${line}`)
        .join('\n');

      return `Finding ${i}: ${f.raw}\nFile: ${f.filename}\nCode context (lines ${startCtx + 1}–${endCtx + 1}):\n${codeContext}`;
    })
    .filter(Boolean)
    .join('\n\n---\n\n');

  const userContent = `Generate minimal code fixes for these findings. Output JSON only.\n\n${sections}`;

  let response: string;
  try {
    response = await callOpenAI(FIX_SYSTEM_PROMPT, userContent);
  } catch (err: unknown) {
    logger.warn({ message: err instanceof Error ? err.message : 'unknown' }, 'Fix generation OpenAI call failed');
    return [];
  }

  // Extract JSON from response (may be wrapped in markdown fences).
  const jsonMatch = response.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    logger.warn('Fix generation returned no parseable JSON');
    return [];
  }

  let fixes: Array<{
    finding_index: number;
    fixable: boolean;
    start_line?: number;
    end_line?: number;
    suggested_code?: string;
  }>;

  try {
    fixes = JSON.parse(jsonMatch[0]);
  } catch {
    logger.warn('Fix generation returned invalid JSON');
    return [];
  }

  if (!Array.isArray(fixes)) return [];

  return fixes
    .filter(
      (fix) =>
        fix.fixable &&
        typeof fix.suggested_code === 'string' &&
        typeof fix.start_line === 'number' &&
        typeof fix.end_line === 'number' &&
        fix.finding_index >= 0 &&
        fix.finding_index < eligible.length,
    )
    .map((fix) => {
      const finding = eligible[fix.finding_index];
      return {
        path: finding.filename,
        startLine: fix.start_line!,
        endLine: fix.end_line!,
        suggestedCode: fix.suggested_code!,
        finding: finding.description,
      };
    });
};
