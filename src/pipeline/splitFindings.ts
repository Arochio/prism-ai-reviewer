// Splits ranked findings into inline-eligible (posted on diff lines) and
// non-inline (kept in the summary comment), and attaches fix suggestions where available.

import type { PassResult, PassLabel } from './rankFindings';
import type { CodeSuggestion } from './generateFixes';
import { getDiffEligibleLines } from './generateFixes';
import type { ProcessedFile } from './extractDiff';

export interface InlineFinding {
  path: string;
  line: number;
  severity: string;
  description: string;
  raw: string;
  passLabel: PassLabel;
  fix?: CodeSuggestion;
}

export interface SplitFindings {
  inline: InlineFinding[];
  nonInline: PassResult[];
}

// Parses the standard finding format: - [Severity] filename:L42: description
const parseFindingLine = (raw: string): { severity: string; filename: string; line: number; description: string } | null => {
  const match = raw.match(/^-\s*\[(\w+)\]\s+(.+?):L(\d+):\s+(.+)/);
  if (!match) return null;
  return {
    severity: match[1],
    filename: match[2],
    line: parseInt(match[3], 10),
    description: match[4],
  };
};

const SEVERITY_ICONS: Record<string, string> = {
  critical: '🔴',
  high: '🟠',
  medium: '🟡',
  low: '🔵',
};

// Formats an inline finding as a review comment body.
// If a fix is attached, includes a suggestion block.
export const formatInlineCommentBody = (finding: InlineFinding): string => {
  const icon = SEVERITY_ICONS[finding.severity.toLowerCase()] ?? '•';
  const passTag = finding.passLabel;
  let body = `${icon} **[${finding.severity}]** — ${passTag}\n\n${finding.description}`;

  if (finding.fix) {
    body += `\n\n🔧 **Suggested fix:**\n\`\`\`suggestion\n${finding.fix.suggestedCode}\n\`\`\``;
  }

  body += `\n\n<sub>Reply with \`/prism-feedback 👍\` or \`/prism-feedback 👎 reason\` to give feedback on this finding.</sub>`;

  return body;
};

// Splits findings into inline-eligible and non-inline, attaching fixes where matched.
export const splitFindings = (
  ranked: PassResult[],
  files: ProcessedFile[],
  suggestions: CodeSuggestion[],
): SplitFindings => {
  // Build diff-eligible line sets per file.
  const diffEligibleMap = new Map<string, Set<number>>();
  for (const file of files) {
    if (file.patch) {
      diffEligibleMap.set(file.filename, getDiffEligibleLines(file.patch));
    }
  }

  // Index suggestions by path:line for fast lookup.
  const fixIndex = new Map<string, CodeSuggestion>();
  for (const s of suggestions) {
    // Use endLine as the anchor since that's where the comment will be placed.
    fixIndex.set(`${s.path}:${s.endLine}`, s);
    // Also index by startLine in case finding line matches start rather than end.
    if (s.startLine !== s.endLine) {
      fixIndex.set(`${s.path}:${s.startLine}`, s);
    }
  }

  const inline: InlineFinding[] = [];
  const nonInlineResults: PassResult[] = [];

  for (const pass of ranked) {
    const nonInlineFindings: string[] = [];

    for (const raw of pass.findings) {
      const parsed = parseFindingLine(raw);
      if (!parsed) {
        nonInlineFindings.push(raw);
        continue;
      }

      const eligibleLines = diffEligibleMap.get(parsed.filename);
      if (!eligibleLines?.has(parsed.line)) {
        nonInlineFindings.push(raw);
        continue;
      }

      const fix = fixIndex.get(`${parsed.filename}:${parsed.line}`);

      inline.push({
        path: parsed.filename,
        line: parsed.line,
        severity: parsed.severity,
        description: parsed.description,
        raw,
        passLabel: pass.label,
        fix,
      });
    }

    nonInlineResults.push({
      label: pass.label,
      raw: pass.raw,
      findings: nonInlineFindings,
    });
  }

  return { inline, nonInline: nonInlineResults };
};
