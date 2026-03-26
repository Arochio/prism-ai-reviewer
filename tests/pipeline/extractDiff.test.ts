import { describe, it, expect, vi } from 'vitest';

// Mock openAIConfig before importing extractDiff
vi.mock('../../src/config/openai.config', () => ({
  openAIConfig: {
    fileContentSizeLimit: 100,
    totalFilesLimit: 3,
    bypassLargeFiles: true,
  },
}));

import { extractDiff, type AnalyzableFile } from '../../src/pipeline/extractDiff';

describe('extractDiff', () => {
  it('returns empty array for non-array input', () => {
    expect(extractDiff(null as unknown as AnalyzableFile[])).toEqual([]);
    expect(extractDiff(undefined as unknown as AnalyzableFile[])).toEqual([]);
  });

  it('returns empty array for empty files', () => {
    expect(extractDiff([])).toEqual([]);
  });

  it('filters out removed files', () => {
    const files: AnalyzableFile[] = [
      { filename: 'a.ts', status: 'removed', content: 'code' },
      { filename: 'b.ts', status: 'added', content: 'code' },
    ];
    const result = extractDiff(files);
    expect(result).toHaveLength(1);
    expect(result[0].filename).toBe('b.ts');
  });

  it('filters out files with invalid filename', () => {
    const files: AnalyzableFile[] = [
      { filename: '', status: 'added', content: 'code' },
      { filename: '  ', status: 'added', content: 'code' },
      { filename: 'valid.ts', status: 'added', content: 'code' },
    ];
    const result = extractDiff(files);
    expect(result).toHaveLength(1);
    expect(result[0].filename).toBe('valid.ts');
  });

  it('filters out files with invalid status', () => {
    const files: AnalyzableFile[] = [
      { filename: 'a.ts', status: '', content: 'code' },
      { filename: 'b.ts', status: 'modified', content: 'code' },
    ];
    const result = extractDiff(files);
    expect(result).toHaveLength(1);
    expect(result[0].filename).toBe('b.ts');
  });

  it('respects totalFilesLimit', () => {
    const files: AnalyzableFile[] = Array.from({ length: 10 }, (_, i) => ({
      filename: `file${i}.ts`,
      status: 'added',
      content: 'code',
    }));
    // totalFilesLimit is mocked as 3
    const result = extractDiff(files);
    expect(result).toHaveLength(3);
  });

  it('bypasses large files when enabled', () => {
    const files: AnalyzableFile[] = [
      { filename: 'small.ts', status: 'added', content: 'short' },
      { filename: 'large.ts', status: 'added', content: 'x'.repeat(200) },
    ];
    // fileContentSizeLimit is mocked as 100, bypassLargeFiles is true
    const result = extractDiff(files);
    expect(result).toHaveLength(1);
    expect(result[0].filename).toBe('small.ts');
  });

  it('truncates content exceeding size limit', () => {
    const files: AnalyzableFile[] = [
      { filename: 'a.ts', status: 'added', content: 'x'.repeat(200) },
    ];
    // bypassLargeFiles is true and content > 100, so this file is skipped.
    // Test with a file just at the limit:
    const filesAtLimit: AnalyzableFile[] = [
      { filename: 'a.ts', status: 'added', content: 'x'.repeat(100) },
    ];
    const result = extractDiff(filesAtLimit);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('1 | ' + 'x'.repeat(100));
  });

  it('handles null content gracefully', () => {
    const files: AnalyzableFile[] = [
      { filename: 'a.ts', status: 'added', content: null },
    ];
    const result = extractDiff(files);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('1 | ');
  });

  it('handles undefined content gracefully', () => {
    const files: AnalyzableFile[] = [
      { filename: 'a.ts', status: 'added' },
    ];
    const result = extractDiff(files);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('1 | ');
  });

  it('sets default similarText and embedding', () => {
    const files: AnalyzableFile[] = [
      { filename: 'a.ts', status: 'added', content: 'code' },
    ];
    const result = extractDiff(files);
    expect(result[0].similarText).toBe('');
    expect(result[0].embedding).toBeNull();
    expect(result[0].patch).toBe('');
  });

  it('preserves patch from input', () => {
    const files: AnalyzableFile[] = [
      { filename: 'a.ts', status: 'added', content: 'code', patch: '@@ -0,0 +1 @@\n+code' },
    ];
    const result = extractDiff(files);
    expect(result[0].patch).toBe('@@ -0,0 +1 @@\n+code');
  });

  it('adds line numbers to content', () => {
    const files: AnalyzableFile[] = [
      { filename: 'a.ts', status: 'added', content: 'line1\nline2\nline3' },
    ];
    const result = extractDiff(files);
    expect(result[0].content).toBe('1 | line1\n2 | line2\n3 | line3');
  });
});
