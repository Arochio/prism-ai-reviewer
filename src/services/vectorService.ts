import { Pinecone, RecordMetadata } from '@pinecone-database/pinecone';
import OpenAI from 'openai';
import { openAIConfig } from '../config/openai.config';

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
    console.error('Failed to create embedding', {
      model: process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small',
      message: getErrorMessage(err),
    });
    throw err;
  }
};

// Non-critical: storage failures are logged but do not throw
export const storeEmbedding = async (id: string, vector: number[], metadata: RecordMetadata): Promise<void> => {
  try {
    const index = pinecone.index(process.env.PINECONE_INDEX_NAME!);
    await index.upsert({ records: [{ id, values: vector, metadata }] });
  } catch (err: unknown) {
    console.error('Failed to store embedding — analysis will continue', {
      id,
      message: getErrorMessage(err),
    });
  }
};

// Non-critical: returns empty array on failure so analysis is not blocked
export const querySimilar = async (vector: number[], topK: number = openAIConfig.vectorDbTopK): Promise<{ metadata?: RecordMetadata }[]> => {
  try {
    const index = pinecone.index(process.env.PINECONE_INDEX_NAME!);
    const queryResponse = await index.query({ vector, topK, includeMetadata: true });
    return queryResponse.matches;
  } catch (err: unknown) {
    console.error('Failed to query similar embeddings — continuing without similarity context', {
      message: getErrorMessage(err),
    });
    return [];
  }
};