// Merges findings from all analysis passes and orders them by severity.

export type PassLabel = 'Bugs & Security' | 'Design' | 'Performance';

export interface PassResult {
  label: PassLabel;
  raw: string;
  findings: string[];
}

const SEVERITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

// Extracts bullet lines from a pass output string.
const extractBullets = (raw: string): string[] =>
  raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- ['));

// Returns the numeric severity rank for a finding line.
const severityOf = (finding: string): number => {
  const match = finding.match(/^-\s*\[(\w+)\]/i);
  const label = match?.[1]?.toLowerCase() ?? '';
  return SEVERITY_ORDER[label] ?? 99;
};

/*
 * Converts raw pass outputs into structured PassResult objects and sorts each
 * finding list from highest to lowest severity.
 */
export const rankFindings = (
  bugRaw: string,
  designRaw: string,
  performanceRaw: string
): PassResult[] => {
  const passes: { label: PassLabel; raw: string }[] = [
    { label: 'Bugs & Security', raw: bugRaw },
    { label: 'Design', raw: designRaw },
    { label: 'Performance', raw: performanceRaw },
  ];

  return passes.map(({ label, raw }) => {
    const findings = extractBullets(raw).sort((a, b) => severityOf(a) - severityOf(b));
    return { label, raw, findings };
  });
};
