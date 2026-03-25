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

const isValidFile = (f: unknown): f is AnalyzableFile =>
  f != null &&
  typeof (f as AnalyzableFile).filename === 'string' && (f as AnalyzableFile).filename.trim().length > 0 &&
  typeof (f as AnalyzableFile).status === 'string' && (f as AnalyzableFile).status.trim().length > 0 &&
  ((f as AnalyzableFile).content === undefined || (f as AnalyzableFile).content === null || typeof (f as AnalyzableFile).content === 'string');

const isIncludedFile = (f: AnalyzableFile): boolean => {
  if (f.status === 'removed') return false;
  if (openAIConfig.bypassLargeFiles && (f.content || '').length > openAIConfig.fileContentSizeLimit) return false;
  return true;
};

const toProcessedFile = (f: AnalyzableFile): ProcessedFile => {
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
};

export const extractDiff = (files: AnalyzableFile[]): ProcessedFile[] => {
  if (!Array.isArray(files)) return [];

  return files
    .filter(isValidFile)
    .slice(0, openAIConfig.totalFilesLimit)
    .filter(isIncludedFile)
    .map(toProcessedFile);
};
