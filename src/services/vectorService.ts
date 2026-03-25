import { Pinecone } from '@pinecone-database/pinecone';
import OpenAI from 'openai';
import { openAIConfig } from '../config/openai.config';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY! });

export const createEmbedding = async (text: string): Promise<number[]> => {
  try {
    const response = await openai.embeddings.create({
      model: process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small',
      input: text,
    });
    return response.data[0].embedding;
  } catch (err: any) {
    console.error('Failed to create embedding', {
      model: process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small',
      status: err.status,
      message: err.message,
    });
    throw err;
  }
};

// Non-critical: storage failures are logged but do not throw
export const storeEmbedding = async (id: string, vector: number[], metadata: any): Promise<void> => {
  try {
    const index = pinecone.index(process.env.PINECONE_INDEX_NAME!);
    await index.upsert({ records: [{ id, values: vector, metadata }] });
  } catch (err: any) {
    console.error('Failed to store embedding — analysis will continue', {
      id,
      message: err.message,
    });
  }
};

// Non-critical: returns empty array on failure so analysis is not blocked
export const querySimilar = async (vector: number[], topK: number = openAIConfig.vectorDbTopK): Promise<{ metadata?: Record<string, any> }[]> => {
  try {
    const index = pinecone.index(process.env.PINECONE_INDEX_NAME!);
    const queryResponse = await index.query({ vector, topK, includeMetadata: true });
    return queryResponse.matches;
  } catch (err: any) {
    console.error('Failed to query similar embeddings — continuing without similarity context', {
      message: err.message,
    });
    return [];
  }
};