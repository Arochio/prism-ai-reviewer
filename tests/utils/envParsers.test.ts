import { describe, it, expect } from 'vitest';
import { parseNum, parseNumClamped, parseIntClamped, parseBool, sanitizeModel } from '../../src/utils/envParsers';

describe('parseNum', () => {
  it('returns undefined for undefined', () => {
    expect(parseNum(undefined)).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(parseNum('')).toBeUndefined();
    expect(parseNum('   ')).toBeUndefined();
  });

  it('parses valid integers', () => {
    expect(parseNum('42')).toBe(42);
    expect(parseNum('0')).toBe(0);
    expect(parseNum('-5')).toBe(-5);
  });

  it('parses valid floats', () => {
    expect(parseNum('0.5')).toBe(0.5);
    expect(parseNum('3.14')).toBe(3.14);
  });

  it('trims whitespace', () => {
    expect(parseNum('  42  ')).toBe(42);
  });

  it('returns undefined for NaN values', () => {
    expect(parseNum('abc')).toBeUndefined();
    expect(parseNum('NaN')).toBeUndefined();
  });

  it('returns undefined for Infinity', () => {
    expect(parseNum('Infinity')).toBeUndefined();
    expect(parseNum('-Infinity')).toBeUndefined();
  });
});

describe('parseNumClamped', () => {
  it('returns undefined for missing input', () => {
    expect(parseNumClamped(undefined, 0, 100)).toBeUndefined();
  });

  it('clamps to min', () => {
    expect(parseNumClamped('-10', 0, 100)).toBe(0);
  });

  it('clamps to max', () => {
    expect(parseNumClamped('200', 0, 100)).toBe(100);
  });

  it('passes through values in range', () => {
    expect(parseNumClamped('50', 0, 100)).toBe(50);
  });

  it('handles float clamping', () => {
    expect(parseNumClamped('0.5', 0, 2)).toBe(0.5);
  });
});

describe('parseIntClamped', () => {
  it('returns undefined for missing input', () => {
    expect(parseIntClamped(undefined, 1, 10)).toBeUndefined();
  });

  it('returns undefined for floats', () => {
    expect(parseIntClamped('3.5', 1, 10)).toBeUndefined();
  });

  it('clamps integers to range', () => {
    expect(parseIntClamped('0', 1, 10)).toBe(1);
    expect(parseIntClamped('50', 1, 10)).toBe(10);
    expect(parseIntClamped('5', 1, 10)).toBe(5);
  });

  it('returns undefined for non-numeric', () => {
    expect(parseIntClamped('abc', 1, 10)).toBeUndefined();
  });
});

describe('parseBool', () => {
  it('returns undefined for undefined', () => {
    expect(parseBool(undefined)).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(parseBool('')).toBeUndefined();
  });

  it('parses true (case-insensitive)', () => {
    expect(parseBool('true')).toBe(true);
    expect(parseBool('TRUE')).toBe(true);
    expect(parseBool('True')).toBe(true);
    expect(parseBool('  true  ')).toBe(true);
  });

  it('parses false (case-insensitive)', () => {
    expect(parseBool('false')).toBe(false);
    expect(parseBool('FALSE')).toBe(false);
  });

  it('throws for invalid boolean values', () => {
    expect(() => parseBool('yes')).toThrow('Invalid boolean value');
    expect(() => parseBool('1')).toThrow('Invalid boolean value');
    expect(() => parseBool('no')).toThrow('Invalid boolean value');
  });
});

describe('sanitizeModel', () => {
  it('returns undefined for undefined', () => {
    expect(sanitizeModel(undefined)).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(sanitizeModel('')).toBeUndefined();
    expect(sanitizeModel('   ')).toBeUndefined();
  });

  it('passes through valid model names', () => {
    expect(sanitizeModel('gpt-4o-mini')).toBe('gpt-4o-mini');
    expect(sanitizeModel('gpt-4.1-mini')).toBe('gpt-4.1-mini');
    expect(sanitizeModel('text-embedding-3-small')).toBe('text-embedding-3-small');
  });

  it('strips invalid characters', () => {
    expect(sanitizeModel('gpt-4o; rm -rf /')).toBe('gpt-4orm-rf');
    expect(sanitizeModel('model<script>')).toBe('modelscript');
  });

  it('trims whitespace', () => {
    expect(sanitizeModel('  gpt-4o  ')).toBe('gpt-4o');
  });

  it('returns undefined if only invalid chars', () => {
    expect(sanitizeModel('!@#$%')).toBeUndefined();
  });
});
