import { describe, it, expect } from 'vitest';
import { rankFindings } from '../../src/pipeline/rankFindings';

describe('rankFindings', () => {
  it('returns three pass results with correct labels', () => {
    const results = rankFindings('', '', '');
    expect(results).toHaveLength(3);
    expect(results[0].label).toBe('Bugs & Security');
    expect(results[1].label).toBe('Design');
    expect(results[2].label).toBe('Performance');
  });

  it('returns empty findings for empty raw strings', () => {
    const results = rankFindings('', '', '');
    for (const result of results) {
      expect(result.findings).toEqual([]);
    }
  });

  it('returns empty findings for "No findings" messages', () => {
    const results = rankFindings('No bug findings.', 'No design findings.', 'No performance findings.');
    for (const result of results) {
      expect(result.findings).toEqual([]);
    }
  });

  it('extracts bullet findings', () => {
    const bugRaw = '- [High] file.ts:10: Some bug\n- [Low] file.ts:20: Another bug';
    const results = rankFindings(bugRaw, '', '');
    expect(results[0].findings).toHaveLength(2);
  });

  it('sorts findings by severity (Critical > High > Medium > Low)', () => {
    const bugRaw = [
      '- [Low] file.ts: low issue',
      '- [Critical] file.ts: critical issue',
      '- [Medium] file.ts: medium issue',
      '- [High] file.ts: high issue',
    ].join('\n');
    const results = rankFindings(bugRaw, '', '');
    const severities = results[0].findings.map((f) => {
      const match = f.match(/\[(\w+)\]/);
      return match?.[1];
    });
    expect(severities).toEqual(['Critical', 'High', 'Medium', 'Low']);
  });

  it('ignores non-bullet lines', () => {
    const raw = 'Some preamble text\n- [High] real finding\nSome trailing text';
    const results = rankFindings(raw, '', '');
    expect(results[0].findings).toHaveLength(1);
    expect(results[0].findings[0]).toContain('real finding');
  });

  it('preserves raw text in result', () => {
    const bugRaw = '- [High] something';
    const results = rankFindings(bugRaw, 'design text', 'perf text');
    expect(results[0].raw).toBe(bugRaw);
    expect(results[1].raw).toBe('design text');
    expect(results[2].raw).toBe('perf text');
  });

  it('handles findings with mixed whitespace', () => {
    const raw = '  - [High] finding with leading spaces  \n\t- [Low] finding with tab';
    const results = rankFindings(raw, '', '');
    expect(results[0].findings).toHaveLength(2);
  });
});
