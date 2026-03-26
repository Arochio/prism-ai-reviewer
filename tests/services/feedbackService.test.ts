import { describe, it, expect, vi } from 'vitest';

// Mock vectorService to avoid OpenAI/Pinecone client initialization
vi.mock('../../src/services/vectorService', () => ({
  createEmbedding: vi.fn(),
  storeEmbedding: vi.fn(),
  querySimilar: vi.fn().mockResolvedValue([]),
}));

import { parseFeedbackCommand } from '../../src/services/feedbackService';

describe('parseFeedbackCommand', () => {
  it('returns null for non-feedback comments', () => {
    expect(parseFeedbackCommand('just a regular comment')).toBeNull();
    expect(parseFeedbackCommand('LGTM!')).toBeNull();
    expect(parseFeedbackCommand('')).toBeNull();
  });

  it('parses thumbs up emoji', () => {
    const result = parseFeedbackCommand('/prism-feedback 👍');
    expect(result).toEqual({ sentiment: 'positive', explanation: '' });
  });

  it('parses thumbs down emoji', () => {
    const result = parseFeedbackCommand('/prism-feedback 👎');
    expect(result).toEqual({ sentiment: 'negative', explanation: '' });
  });

  it('parses +1 as positive', () => {
    const result = parseFeedbackCommand('/prism-feedback +1');
    expect(result).toEqual({ sentiment: 'positive', explanation: '' });
  });

  it('parses -1 as negative', () => {
    const result = parseFeedbackCommand('/prism-feedback -1');
    expect(result).toEqual({ sentiment: 'negative', explanation: '' });
  });

  it('parses "positive" keyword', () => {
    const result = parseFeedbackCommand('/prism-feedback positive');
    expect(result).toEqual({ sentiment: 'positive', explanation: '' });
  });

  it('parses "negative" keyword', () => {
    const result = parseFeedbackCommand('/prism-feedback negative');
    expect(result).toEqual({ sentiment: 'negative', explanation: '' });
  });

  it('extracts explanation text', () => {
    const result = parseFeedbackCommand('/prism-feedback 👎 this is a false positive');
    expect(result).toEqual({
      sentiment: 'negative',
      explanation: 'this is a false positive',
    });
  });

  it('extracts explanation with positive feedback', () => {
    const result = parseFeedbackCommand('/prism-feedback 👍 good catch, thanks');
    expect(result).toEqual({
      sentiment: 'positive',
      explanation: 'good catch, thanks',
    });
  });

  it('is case-insensitive for the command', () => {
    const result = parseFeedbackCommand('/PRISM-FEEDBACK 👍');
    expect(result).toEqual({ sentiment: 'positive', explanation: '' });
  });

  it('handles leading/trailing whitespace', () => {
    const result = parseFeedbackCommand('  /prism-feedback 👍  ');
    expect(result).toEqual({ sentiment: 'positive', explanation: '' });
  });

  it('returns null for partial command', () => {
    expect(parseFeedbackCommand('/prism-feedback')).toBeNull();
    expect(parseFeedbackCommand('/prism-feedback ')).toBeNull();
  });

  it('returns null for wrong command name', () => {
    expect(parseFeedbackCommand('/feedback 👍')).toBeNull();
    expect(parseFeedbackCommand('/prism 👍')).toBeNull();
  });
});
