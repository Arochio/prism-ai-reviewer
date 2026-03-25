// Enriches processed files with embedding-based similarity context from the vector store.
import { openAIConfig } from '../config/openai.config';
import { createEmbedding, querySimilar } from '../services/vectorService';
import { retrieveFeedback } from '../services/feedbackService';
import { logger } from '../services/logger';
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
  // Retrieve feedback once using a combined snippet of all file contents.
  const combinedSnippet = files.map((f) => f.content.slice(0, 500)).join('\n');
  const feedbackContext = await retrieveFeedback(combinedSnippet);

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
            .filter((s) => s.metadata?.['filename'] && s.metadata?.['type'] !== 'feedback')
            .map((s) => {
              const name = String(s.metadata!['filename']);
              const snippet = String(s.metadata!['content'] || '').trim();
              return snippet
                ? `// ${name}\n${snippet}`
                : `// ${name} (no content stored)`;
            })
            .join('\n\n---\n\n');
          similarText = contextBlocks
            ? `\n\n<similar_codebase_files>\n${contextBlocks}\n</similar_codebase_files>`
            : '';
        }
        // Append shared feedback context to each file's similar text.
        similarText += feedbackContext;
      } catch (err: unknown) {
        logger.error({
          message: getErrorMessage(err),
        }, `Context retrieval skipped for ${file.filename}`);
      }
      return { ...file, embedding, similarText };
    })
  );
};
