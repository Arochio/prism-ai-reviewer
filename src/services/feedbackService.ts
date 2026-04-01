// Stores and retrieves user feedback on AI review comments for prompt refinement.
import { createEmbedding, storeEmbedding, querySimilar } from './vectorService';
import { logger } from './logger';

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  return 'Unknown error';
};

export type FeedbackSentiment = 'positive' | 'negative';

export interface FeedbackRecord {
  commentId: number;
  prNumber: number;
  repo: string;
  sentiment: FeedbackSentiment;
  userFeedback: string;
  aiReviewSnippet: string;
}

// Matches `/prism-feedback 👍 optional explanation` or `/prism-feedback 👎 optional explanation`.
const FEEDBACK_PATTERN = /^\/prism-feedback\s+(👍|👎|\+1|-1|positive|negative)(?:\s+(.+))?$/im;

/*
 * Parses a comment body for a feedback command.
 * Returns null if the comment is not a feedback command.
 */
export const parseFeedbackCommand = (body: string): { sentiment: FeedbackSentiment; explanation: string } | null => {
  const match = body.trim().match(FEEDBACK_PATTERN);
  if (!match) return null;

  const raw = match[1].toLowerCase();
  const sentiment: FeedbackSentiment =
    raw === '👍' || raw === '+1' || raw === 'positive' ? 'positive' : 'negative';
  const explanation = (match[2] || '').trim();

  return { sentiment, explanation };
};

/*
 * Embeds and stores a feedback record in Pinecone for future retrieval.
 * The embedding is based on the AI review snippet so similar future reviews
 * can retrieve relevant past feedback.
 */
export const storeFeedback = async (record: FeedbackRecord, installationId?: number): Promise<void> => {
  try {
    const textToEmbed = `${record.aiReviewSnippet}\n\nUser feedback (${record.sentiment}): ${record.userFeedback}`;
    const embedding = await createEmbedding(textToEmbed);

    await storeEmbedding(`feedback-${record.commentId}`, embedding, {
      type: 'feedback',
      sentiment: record.sentiment,
      prNumber: record.prNumber,
      repo: record.repo,
      aiReviewSnippet: record.aiReviewSnippet.slice(0, 1500),
      userFeedback: record.userFeedback.slice(0, 500),
      timestamp: new Date().toISOString(),
    }, installationId);

    logger.info({
      commentId: record.commentId,
      prNumber: record.prNumber,
      sentiment: record.sentiment,
    }, 'Feedback stored');
  } catch (err: unknown) {
    logger.error({
      commentId: record.commentId,
      message: getErrorMessage(err),
    }, 'Failed to store feedback — continuing without persistence');
  }
};

/*
 * Queries Pinecone for past feedback that is semantically similar to the given
 * code snippet. Returns a formatted block of explicit rules derived from feedback.
 */
export const retrieveFeedback = async (codeSnippet: string, topK = 3, installationId?: number): Promise<string> => {
  try {
    const embedding = await createEmbedding(codeSnippet);
    const results = await querySimilar(embedding, topK, installationId);

    const feedbackItems = results
      .filter((r) => r.metadata?.['type'] === 'feedback')
      .map((r) => {
        const sentiment = String(r.metadata!['sentiment']);
        const review = String(r.metadata!['aiReviewSnippet'] || '').trim();
        const feedback = String(r.metadata!['userFeedback'] || '').trim();
        return { sentiment, review, feedback };
      });

    if (feedbackItems.length === 0) return '';

    // Distill raw feedback into explicit do/don't rules.
    const rules = feedbackItems.map((item) => {
      if (item.sentiment === 'negative') {
        if (item.feedback) {
          return `- DO NOT: ${item.feedback} (The reviewer previously flagged: "${item.review.slice(0, 120)}" and the user rejected it.)`;
        }
        return `- DO NOT flag issues similar to: "${item.review.slice(0, 150)}" (user marked as unhelpful)`;
      }
      if (item.feedback) {
        return `- DO: ${item.feedback} (The reviewer previously flagged: "${item.review.slice(0, 120)}" and the user valued it.)`;
      }
      return `- DO continue flagging issues similar to: "${item.review.slice(0, 150)}" (user marked as helpful)`;
    });

    return `\n\n<feedback_rules>\nThe following rules are derived from real user feedback on similar past reviews. These are mandatory — follow them strictly.\n\n${rules.join('\n')}\n</feedback_rules>`;
  } catch (err: unknown) {
    logger.error({
      message: getErrorMessage(err),
    }, 'Failed to retrieve feedback — continuing without feedback context');
    return '';
  }
};
