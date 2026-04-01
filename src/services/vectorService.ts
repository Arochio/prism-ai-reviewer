import { Pinecone, RecordMetadata } from '@pinecone-database/pinecone';
import OpenAI from 'openai';
import { openAIConfig } from '../config/openai.config';
import { logger } from './logger';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY! });

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  return 'Unknown error';
};

export const createEmbedding = async (text: string): Promise<number[]> => {
  try {
    const response = await openai.embeddings.create({
      model: process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small',
      input: text,
    });
    return response.data[0].embedding;
  } catch (err: unknown) {
    logger.error({
      model: process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small',
      message: getErrorMessage(err),
    }, 'Failed to create embedding');
    throw err;
  }
};

// Persists embedding vectors for similarity lookups.
// Storage failures are non-blocking and logged only.
// When installationId is provided, it is stored as metadata for tenant isolation.
export const storeEmbedding = async (id: string, vector: number[], metadata: RecordMetadata, installationId?: number): Promise<void> => {
  try {
    const enrichedMetadata = installationId
      ? { ...metadata, installationId }
      : metadata;
    const index = pinecone.index(process.env.PINECONE_INDEX_NAME!);
    await index.upsert({ records: [{ id, values: vector, metadata: enrichedMetadata }] });
  } catch (err: unknown) {
    logger.error({
      id,
      message: getErrorMessage(err),
    }, 'Failed to store embedding — analysis will continue');
  }
};

// Queries nearest vectors for contextual similarity.
// Query failures return an empty result to avoid blocking analysis.
// When installationId is provided, results are filtered to that tenant.
export const querySimilar = async (vector: number[], topK: number = openAIConfig.vectorDbTopK, installationId?: number): Promise<{ metadata?: RecordMetadata }[]> => {
  try {
    const index = pinecone.index(process.env.PINECONE_INDEX_NAME!);
    const filter = installationId
      ? { installationId: { $eq: installationId } }
      : undefined;
    const queryResponse = await index.query({ vector, topK, includeMetadata: true, filter });
    return queryResponse.matches;
  } catch (err: unknown) {
    logger.error({
      message: getErrorMessage(err),
    }, 'Failed to query similar embeddings — continuing without similarity context');
    return [];
  }
};