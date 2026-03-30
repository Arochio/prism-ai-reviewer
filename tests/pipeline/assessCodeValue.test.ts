import { describe, it, expect } from 'vitest';
import { assessCodeValue } from '../../src/pipeline/assessCodeValue';
import type { ProcessedFile } from '../../src/pipeline/extractDiff';
import type { PassResult } from '../../src/pipeline/rankFindings';

const makeFile = (overrides: Partial<ProcessedFile> = {}): ProcessedFile => ({
  filename: 'src/index.ts',
  status: 'modified',
  content: 'const x = 1;',
  patch: '@@ -1,1 +1,1 @@\n+const x = 1;',
  similarText: '',
  embedding: null,
  ...overrides,
});

const noRanked: PassResult[] = [];

// Builds a patch with exactly `count` added lines.
const patchWithLines = (count: number): string => {
  const lines = Array.from({ length: count }, (_, i) => `+line ${i + 1}`).join('\n');
  return `@@ -0,0 +1,${count} @@\n${lines}`;
};

describe('assessCodeValue', () => {
  describe('linesAdded / filesChanged', () => {
    it('returns zeros for an empty file list', () => {
      const r = assessCodeValue([], noRanked);
      expect(r.linesAdded).toBe(0);
      expect(r.filesChanged).toBe(0);
      expect(r.quantityScore).toBe(0);
      expect(r.complexityScore).toBe(0);
      expect(r.codeValue).toBe(0);
    });

    it('counts + lines from the patch', () => {
      const file = makeFile({ patch: '@@ -1,3 +1,5 @@\n context\n+added 1\n+added 2\n context\n+added 3' });
      expect(assessCodeValue([file], noRanked).linesAdded).toBe(3);
    });

    it('does not count removed or context lines', () => {
      const file = makeFile({ patch: '@@ -1,3 +1,1 @@\n context\n-removed\n-also removed\n+replacement' });
      expect(assessCodeValue([file], noRanked).linesAdded).toBe(1);
    });

    it('does not count the +++ diff header line', () => {
      const file = makeFile({ patch: '+++ b/src/index.ts\n@@ -1,1 +1,2 @@\n+real line' });
      expect(assessCodeValue([file], noRanked).linesAdded).toBe(1);
    });

    it('sums added lines across multiple files', () => {
      const files = [
        makeFile({ patch: patchWithLines(10) }),
        makeFile({ filename: 'src/b.ts', patch: patchWithLines(5) }),
      ];
      expect(assessCodeValue(files, noRanked).linesAdded).toBe(15);
    });

    it('reports filesChanged equal to the number of files', () => {
      const files = [makeFile(), makeFile({ filename: 'src/b.ts' })];
      expect(assessCodeValue(files, noRanked).filesChanged).toBe(2);
    });
  });

  describe('quantityScore', () => {
    it('is 0 when no lines are added', () => {
      expect(assessCodeValue([makeFile({ patch: '' })], noRanked).quantityScore).toBe(0);
    });

    it('increases with more lines added', () => {
      const small = assessCodeValue([makeFile({ patch: patchWithLines(5) })], noRanked);
      const large = assessCodeValue([makeFile({ patch: patchWithLines(500) })], noRanked);
      expect(large.quantityScore).toBeGreaterThan(small.quantityScore);
    });

    it('caps at 100 for very large diffs', () => {
      const file = makeFile({ patch: patchWithLines(10_000) });
      expect(assessCodeValue([file], noRanked).quantityScore).toBe(100);
    });
  });

  describe('complexityScore — signals', () => {
    const scoreFor = (content: string) =>
      assessCodeValue([makeFile({ content })], noRanked).complexityScore;

    it('is 0 for trivial content', () => {
      expect(scoreFor('const x = 1;')).toBe(0);
    });

    it('detects recursion keywords', () => {
      expect(scoreFor('function f() { return recursive(f); }')).toBeGreaterThan(0);
    });

    it('detects memoization / dynamic programming', () => {
      expect(scoreFor('const memo = memoize(fn); const dp = dp[i];')).toBeGreaterThan(0);
    });

    it('detects binary search / sorting algorithms', () => {
      expect(scoreFor('const idx = binarySearch(arr, val);')).toBeGreaterThan(0);
    });

    it('detects Promise.all concurrency', () => {
      expect(scoreFor('await Promise.all([a, b, c]);')).toBeGreaterThan(0);
    });

    it('detects mutex / concurrency primitives', () => {
      expect(scoreFor('const lock = new Mutex(); await lock.acquire();')).toBeGreaterThan(0);
    });

    it('detects design pattern keywords', () => {
      expect(scoreFor('class ObserverFactory implements Observer {}')).toBeGreaterThan(0);
    });

    it('detects cryptographic primitives', () => {
      expect(scoreFor('const hash = hmac(bcrypt(password));')).toBeGreaterThan(0);
    });

    it('detects parser / AST work', () => {
      expect(scoreFor('const ast = parser.tokenize(source);')).toBeGreaterThan(0);
    });

    it('accumulates multiple signals', () => {
      const single = scoreFor('const lock = new Mutex();');
      const multi = scoreFor('const lock = new Mutex(); function recursive() {} await Promise.all([]);');
      expect(multi).toBeGreaterThan(single);
    });

    it('caps at 100 regardless of signal count', () => {
      const dense = [
        'function recursive() { return recursion(); }',
        'const x = binarySearch(mergeSort(graph));',
        'await Promise.all([mutex, semaphore, atomic]);',
        'interface Factory<T, U, V> extends Observer {}',
        'const enc = encrypt(cipher(hmac(pbkdf(bcrypt()))));',
        'const ast = parser.tokenize(lexer.parse(bytecode));',
        'const m = matrix(tensor(quaternion(fourier())));',
      ].join('\n');
      expect(scoreFor(dense)).toBeLessThanOrEqual(100);
    });

    it('awards spread bonus for multi-directory changes', () => {
      const oneDir = [makeFile({ filename: 'src/a.ts' }), makeFile({ filename: 'src/b.ts' })];
      const multiDir = [
        makeFile({ filename: 'src/a.ts' }),
        makeFile({ filename: 'tests/b.ts' }),
        makeFile({ filename: 'lib/c.ts' }),
      ];
      const r1 = assessCodeValue(oneDir, noRanked);
      const r2 = assessCodeValue(multiDir, noRanked);
      expect(r2.complexityScore).toBeGreaterThan(r1.complexityScore);
    });

    it('awards lang bonus for multi-extension changes', () => {
      const sameExt = [makeFile({ filename: 'a.ts' }), makeFile({ filename: 'b.ts' })];
      const multiExt = [
        makeFile({ filename: 'a.ts' }),
        makeFile({ filename: 'b.py' }),
        makeFile({ filename: 'c.go' }),
      ];
      const r1 = assessCodeValue(sameExt, noRanked);
      const r2 = assessCodeValue(multiExt, noRanked);
      expect(r2.complexityScore).toBeGreaterThan(r1.complexityScore);
    });
  });

  describe('codeValue formula', () => {
    it('equals 40% quantity + 60% complexity (rounded)', () => {
      const files = [makeFile({ patch: patchWithLines(50), content: 'await Promise.all([a]);' })];
      const r = assessCodeValue(files, noRanked);
      expect(r.codeValue).toBe(Math.round(r.quantityScore * 0.4 + r.complexityScore * 0.6));
    });

    it('caps at 100', () => {
      const files = [makeFile({ patch: patchWithLines(10_000), content: 'mutex recursive binarySearch hmac' })];
      expect(assessCodeValue(files, noRanked).codeValue).toBeLessThanOrEqual(100);
    });
  });
});
