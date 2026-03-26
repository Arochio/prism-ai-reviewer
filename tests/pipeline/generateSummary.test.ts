import { describe, it, expect } from 'vitest';
import { generateSummary } from '../../src/pipeline/generateSummary';
import type { PassResult } from '../../src/pipeline/rankFindings';

describe('generateSummary', () => {
  it('generates header with all three sections', () => {
    const results: PassResult[] = [
      { label: 'Bugs & Security', raw: '', findings: [] },
      { label: 'Design', raw: '', findings: [] },
      { label: 'Performance', raw: '', findings: [] },
    ];
    const summary = generateSummary(results);
    expect(summary).toContain('## AI Code Review');
    expect(summary).toContain('Bugs & Security');
    expect(summary).toContain('Design');
    expect(summary).toContain('Performance');
  });

  it('shows "No issues found." for passes with no findings', () => {
    const results: PassResult[] = [
      { label: 'Bugs & Security', raw: '', findings: [] },
      { label: 'Design', raw: '', findings: [] },
      { label: 'Performance', raw: '', findings: [] },
    ];
    const summary = generateSummary(results);
    expect(summary.match(/No issues found\./g)?.length).toBe(3);
  });

  it('includes findings in the output', () => {
    const results: PassResult[] = [
      { label: 'Bugs & Security', raw: '', findings: ['- [High] file.ts:10: A real bug'] },
      { label: 'Design', raw: '', findings: [] },
      { label: 'Performance', raw: '', findings: [] },
    ];
    const summary = generateSummary(results);
    expect(summary).toContain('- [High] file.ts:10: A real bug');
  });

  it('separates sections with dividers', () => {
    const results: PassResult[] = [
      { label: 'Bugs & Security', raw: '', findings: [] },
      { label: 'Design', raw: '', findings: [] },
      { label: 'Performance', raw: '', findings: [] },
    ];
    const summary = generateSummary(results);
    expect(summary).toContain('---');
  });

  it('includes correct icons for each pass', () => {
    const results: PassResult[] = [
      { label: 'Bugs & Security', raw: '', findings: [] },
      { label: 'Design', raw: '', findings: [] },
      { label: 'Performance', raw: '', findings: [] },
    ];
    const summary = generateSummary(results);
    expect(summary).toContain('🐛');
    expect(summary).toContain('🏗️');
    expect(summary).toContain('⚡');
  });

  it('handles multiple findings per section', () => {
    const results: PassResult[] = [
      {
        label: 'Bugs & Security',
        raw: '',
        findings: [
          '- [Critical] a.ts: critical bug',
          '- [High] b.ts: high bug',
          '- [Low] c.ts: low bug',
        ],
      },
      { label: 'Design', raw: '', findings: [] },
      { label: 'Performance', raw: '', findings: [] },
    ];
    const summary = generateSummary(results);
    expect(summary).toContain('critical bug');
    expect(summary).toContain('high bug');
    expect(summary).toContain('low bug');
  });
});
