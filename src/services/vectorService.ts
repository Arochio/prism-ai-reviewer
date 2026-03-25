import { Pinecone } from '@pinecone-database/pinecone';
import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY! });

export const createEmbedding = async (text: string) => {
  const response = await openai.embeddings.create({
    model: process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small',
    input: text,
  });
  return response.data[0].embedding;
};

export const storeEmbedding = async (id: string, vector: number[], metadata: any) => {
  const index = pinecone.index(process.env.PINECONE_INDEX_NAME!);
  await index.upsert({ records: [{ id, values: vector, metadata }] });
};

export const querySimilar = async (vector: number[], topK: number = 5) => {
  const index = pinecone.index(process.env.PINECONE_INDEX_NAME!);
  const queryResponse = await index.query({ vector, topK, includeMetadata: true });
  return queryResponse.matches;
};