import { describe, it, expect } from 'vitest';
import { getDiffEligibleLines } from '../../src/pipeline/generateFixes';

describe('getDiffEligibleLines', () => {
  it('returns added lines from a simple hunk', () => {
    const patch = [
      '@@ -10,3 +10,5 @@',
      ' context line',
      '+added line 1',
      '+added line 2',
      ' context line',
      '+added line 3',
    ].join('\n');
    const eligible = getDiffEligibleLines(patch);
    // Line 10 = context, 11 = added, 12 = added, 13 = context, 14 = added
    expect(eligible).toEqual(new Set([10, 11, 12, 13, 14]));
  });

  it('skips removed lines', () => {
    const patch = [
      '@@ -5,4 +5,3 @@',
      ' context',
      '-removed',
      ' context',
      ' context',
    ].join('\n');
    const eligible = getDiffEligibleLines(patch);
    // 5 = context, removed skipped, 6 = context, 7 = context
    expect(eligible).toEqual(new Set([5, 6, 7]));
  });

  it('handles multiple hunks', () => {
    const patch = [
      '@@ -1,3 +1,3 @@',
      ' line1',
      '-old',
      '+new',
      ' line3',
      '@@ -20,3 +20,4 @@',
      ' ctx',
      '+added',
      ' ctx',
      '+added2',
    ].join('\n');
    const eligible = getDiffEligibleLines(patch);
    // Hunk 1: 1=context, 2=added(+), 3=context
    // Hunk 2: 20=context, 21=added, 22=context, 23=added
    expect(eligible).toEqual(new Set([1, 2, 3, 20, 21, 22, 23]));
  });

  it('returns empty set for empty patch', () => {
    expect(getDiffEligibleLines('')).toEqual(new Set());
  });

  it('handles hunk header with function context', () => {
    const patch = '@@ -10,3 +10,4 @@ function foo() {\n context\n+added\n context\n+added2';
    const eligible = getDiffEligibleLines(patch);
    expect(eligible).toEqual(new Set([10, 11, 12, 13]));
  });
});
