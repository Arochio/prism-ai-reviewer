// Normalises raw GitHub file data into a consistent shape for pipeline passes.
import { openAIConfig } from '../config/openai.config';

export interface AnalyzableFile {
  filename: string;
  status: string;
  content?: string | null;
}

export interface ProcessedFile {
  filename: string;
  status: string;
  content: string;
  similarText: string;
  embedding: number[] | null;
}

/*
 * Filters and truncates changed files to fit within configured size limits.
 * Removed files and files exceeding the size limit (when bypass is enabled) are excluded.
 */
export const extractDiff = (files: AnalyzableFile[]): ProcessedFile[] => {
  return files
    .slice(0, openAIConfig.totalFilesLimit)
    .filter((f) => f.status !== 'removed')
    .filter((f) => {
      if (!openAIConfig.bypassLargeFiles) return true;
      return (f.content || '').length <= openAIConfig.fileContentSizeLimit;
    })
    .map((f) => {
      const raw = f.content || '';
      const content =
        raw.slice(0, openAIConfig.fileContentSizeLimit) +
        (raw.length > openAIConfig.fileContentSizeLimit ? '\n\n...truncated...' : '');
      return {
        filename: f.filename,
        status: f.status,
        content,
        similarText: '',
        embedding: null,
      };
    });
};
