// Formats ranked pass results into a structured Markdown PR review comment
import type { PassResult } from './rankFindings';

const PASS_ICONS: Record<string, string> = {
  'Bugs & Security': '\ud83d\udc1b',
  Design: '\ud83c\udfd7\ufe0f',
  Performance: '\u26a1',
};

// Formats ranked pipeline results into a single Markdown comment
// Passes with no findings are collapsed to a single line
// Recommendations from risk assessment are appended as a footer
//
// When inlineCount > 0, the summary is lightweight: only non-inline
// findings are shown in detail, with a note about inline comments
export const generateSummary = (
  results: PassResult[],
  recommendations: string[] = [],
  inlineCount: number = 0,
): string => {
  const totalFindings = results.reduce((n, r) => n + r.findings.length, 0);

  const sections = results.map((result) => {
    const pass_icons_default = '\u2022';
    const icon = PASS_ICONS[result.label] ?? pass_icons_default;
    const header = `### ${icon} ${result.label}`;
    if (result.findings.length === 0) {
      return `${header}\n\nNo issues found.`;
    }
    return `${header}\n\n${result.findings.join('\n')}`;
  });

  let output = `## AI Code Review\n\n`;

  if (inlineCount > 0) {
    const alsoInline = totalFindings > 0
      ? ` ${totalFindings} additional finding${totalFindings !== 1 ? 's' : ''} listed below.`
      : '';
    output += `> 💬 **${inlineCount}** finding${inlineCount !== 1 ? 's' : ''} posted as inline comments on the relevant lines.${alsoInline}\n\n`;
  }

  output += sections.join('\n\n---\n\n');

  if (recommendations.length > 0) {
    output += `\n\n---\n\n### 📊 Risk Insights\n\n${recommendations.join('\n')}`;
  }

  return output;
};
