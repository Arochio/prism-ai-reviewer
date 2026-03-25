// Enriches processed files with embedding-based similarity context from the vector store.
import { openAIConfig } from '../config/openai.config';
import { createEmbedding, querySimilar } from '../services/vectorService';
import type { ProcessedFile } from './extractDiff';

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  return 'Unknown error';
};

/*
 * Generates embeddings for each file and attaches semantically similar filenames
 * previously stored in the vector index. Failures are non-blocking per file.
 */
export const retrieveContext = async (files: ProcessedFile[]): Promise<ProcessedFile[]> => {
  return Promise.all(
    files.map(async (file) => {
      let embedding: number[] | null = null;
      let similarText = '';
      try {
        embedding = await createEmbedding(file.content);
        const similar = await querySimilar(embedding, openAIConfig.vectorDbTopK);
        if (similar.length > 0) {
          // Builds a RAG context block from stored filename + content snippets.
          const contextBlocks = similar
            .filter((s) => s.metadata?.['filename'])
            .map((s) => {
              const name = String(s.metadata!['filename']);
              const snippet = String(s.metadata!['content'] || '').trim();
              return snippet
                ? `// ${name}\n${snippet}`
                : `// ${name} (no content stored)`;
            })
            .join('\n\n---\n\n');
          similarText = `\n\n<similar_codebase_files>\n${contextBlocks}\n</similar_codebase_files>`;
        }
      } catch (err: unknown) {
        console.error(`Context retrieval skipped for ${file.filename}`, {
          message: getErrorMessage(err),
        });
      }
      return { ...file, embedding, similarText };
    })
  );
};
