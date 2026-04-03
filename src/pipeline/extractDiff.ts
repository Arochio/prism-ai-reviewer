// Normalises raw GitHub file data into a consistent shape for pipeline passes
import { openAIConfig } from '../config/openai.config';

export interface AnalyzableFile {
  filename: string;
  status: string;
  content?: string | null;
  patch?: string;
}

export interface ProcessedFile {
  filename: string;
  status: string;
  content: string;
  patch: string;
  similarText: string;
  embedding: number[] | null;
}

// Filters and truncates changed files to fit within configured size limits
// Removed files and files exceeding the size limit (when bypass is enabled) are excluded

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

// Adds 1-based line numbers to source content for precise line references
const addLineNumbers = (source: string): string =>
  source
    .split('\n')
    .map((line, i) => `${i + 1} | ${line}`)
    .join('\n');

const toProcessedFile = (f: AnalyzableFile): ProcessedFile => {
  const raw = f.content || '';
  const truncated =
    raw.slice(0, openAIConfig.fileContentSizeLimit) +
    (raw.length > openAIConfig.fileContentSizeLimit ? '\n\n...truncated...' : '');
  return {
    filename: f.filename,
    status: f.status,
    content: addLineNumbers(truncated),
    patch: f.patch || '',
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
