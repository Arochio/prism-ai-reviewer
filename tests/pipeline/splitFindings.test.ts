import { describe, it, expect } from 'vitest';
import { splitFindings, formatInlineCommentBody, type InlineFinding } from '../../src/pipeline/splitFindings';
import type { PassResult } from '../../src/pipeline/rankFindings';
import type { ProcessedFile } from '../../src/pipeline/extractDiff';
import type { CodeSuggestion } from '../../src/pipeline/generateFixes';

const makeFile = (filename: string, patch: string): ProcessedFile => ({
  filename,
  status: 'modified',
  content: Array.from({ length: 20 }, (_, i) => `${i + 1} | line ${i + 1}`).join('\n'),
  patch,
  similarText: '',
  embedding: null,
});

const simplePatch = [
  '@@ -5,3 +5,5 @@',
  ' context',
  '+added line',
  '+added line 2',
  ' context',
  '+added line 3',
].join('\n');

describe('splitFindings', () => {
  it('places diff-eligible findings in inline, others in nonInline', () => {
    const ranked: PassResult[] = [{
      label: 'Bugs & Security',
      raw: '',
      findings: [
        '- [High] src/foo.ts:L6: Bug on added line',
        '- [Medium] src/foo.ts:L1: Bug on non-diff line',
      ],
    }, {
      label: 'Design',
      raw: '',
      findings: [],
    }, {
      label: 'Performance',
      raw: '',
      findings: [],
    }];

    const files = [makeFile('src/foo.ts', simplePatch)];
    const { inline, nonInline } = splitFindings(ranked, files, []);

    expect(inline).toHaveLength(1);
    expect(inline[0].path).toBe('src/foo.ts');
    expect(inline[0].line).toBe(6);
    expect(inline[0].passLabel).toBe('Bugs & Security');

    expect(nonInline[0].findings).toHaveLength(1);
    expect(nonInline[0].findings[0]).toContain('L1');
  });

  it('attaches matching fix suggestions to inline findings', () => {
    const ranked: PassResult[] = [{
      label: 'Bugs & Security',
      raw: '',
      findings: ['- [High] src/foo.ts:L6: A bug'],
    }, { label: 'Design', raw: '', findings: [] }, { label: 'Performance', raw: '', findings: [] }];

    const files = [makeFile('src/foo.ts', simplePatch)];
    const suggestions: CodeSuggestion[] = [{
      path: 'src/foo.ts',
      startLine: 6,
      endLine: 6,
      suggestedCode: '  const fixed = true;',
      finding: 'A bug',
    }];

    const { inline } = splitFindings(ranked, files, suggestions);
    expect(inline).toHaveLength(1);
    expect(inline[0].fix).toBeDefined();
    expect(inline[0].fix!.suggestedCode).toBe('  const fixed = true;');
  });

  it('returns all findings as nonInline when no files have patches', () => {
    const ranked: PassResult[] = [{
      label: 'Bugs & Security',
      raw: '',
      findings: ['- [High] src/bar.ts:L10: Some bug'],
    }, { label: 'Design', raw: '', findings: [] }, { label: 'Performance', raw: '', findings: [] }];

    const files: ProcessedFile[] = [{
      filename: 'src/bar.ts',
      status: 'modified',
      content: '1 | code',
      patch: '',
      similarText: '',
      embedding: null,
    }];

    const { inline, nonInline } = splitFindings(ranked, files, []);
    expect(inline).toHaveLength(0);
    expect(nonInline[0].findings).toHaveLength(1);
  });

  it('handles unparseable findings gracefully', () => {
    const ranked: PassResult[] = [{
      label: 'Bugs & Security',
      raw: '',
      findings: ['Some malformed finding without the expected format'],
    }, { label: 'Design', raw: '', findings: [] }, { label: 'Performance', raw: '', findings: [] }];

    const files = [makeFile('src/foo.ts', simplePatch)];
    const { inline, nonInline } = splitFindings(ranked, files, []);

    expect(inline).toHaveLength(0);
    expect(nonInline[0].findings).toHaveLength(1);
    expect(nonInline[0].findings[0]).toContain('malformed');
  });
});

describe('formatInlineCommentBody', () => {
  it('formats a finding without a fix', () => {
    const finding: InlineFinding = {
      path: 'src/foo.ts',
      line: 10,
      severity: 'High',
      description: 'Missing null check on response',
      raw: '- [High] src/foo.ts:L10: Missing null check on response',
      passLabel: 'Bugs & Security',
    };

    const body = formatInlineCommentBody(finding);
    expect(body).toContain('🟠');
    expect(body).toContain('**[High]**');
    expect(body).toContain('Bugs & Security');
    expect(body).toContain('Missing null check on response');
    expect(body).toContain('/prism-feedback');
    expect(body).not.toContain('suggestion');
  });

  it('formats a finding with a fix suggestion', () => {
    const finding: InlineFinding = {
      path: 'src/foo.ts',
      line: 10,
      severity: 'Critical',
      description: 'SQL injection vulnerability',
      raw: '- [Critical] src/foo.ts:L10: SQL injection vulnerability',
      passLabel: 'Bugs & Security',
      fix: {
        path: 'src/foo.ts',
        startLine: 10,
        endLine: 10,
        suggestedCode: '  const query = db.escape(input);',
        finding: 'SQL injection vulnerability',
      },
    };

    const body = formatInlineCommentBody(finding);
    expect(body).toContain('🔴');
    expect(body).toContain('```suggestion');
    expect(body).toContain('const query = db.escape(input);');
    expect(body).toContain('🔧 **Suggested fix:**');
  });

  it('uses correct severity icons', () => {
    const base: InlineFinding = {
      path: 'f.ts', line: 1, description: 'test', raw: '', passLabel: 'Design',
      severity: '',
    };

    expect(formatInlineCommentBody({ ...base, severity: 'Critical' })).toContain('🔴');
    expect(formatInlineCommentBody({ ...base, severity: 'High' })).toContain('🟠');
    expect(formatInlineCommentBody({ ...base, severity: 'Medium' })).toContain('🟡');
    expect(formatInlineCommentBody({ ...base, severity: 'Low' })).toContain('🔵');
  });
});
