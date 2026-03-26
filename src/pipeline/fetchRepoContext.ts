// Builds repository-wide context for analysis passes by fetching the file tree
// and the content of files most relevant to the changed set.
import { openAIConfig } from '../config/openai.config';
import { fetchRepoTree, fetchRepoFileContents, type GitHubTreeEntry } from '../services/githubService';
import { logger } from '../services/logger';
import type { ProcessedFile } from './extractDiff';

export interface RepoInfo {
  owner: string;
  repo: string;
  headSha: string;
  installationId: number;
}

// Extensions considered source code for context fetching.
const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.rb', '.go', '.rs', '.java', '.kt',
  '.cs', '.cpp', '.c', '.h', '.hpp',
  '.swift', '.vue', '.svelte',
  '.json', '.yaml', '.yml', '.toml',
]);

// Paths that should never be fetched for context.
const SKIP_PATHS = ['node_modules', 'dist', '.git', '.env', 'vendor', '__pycache__'];

const isSourceFile = (entry: GitHubTreeEntry): boolean => {
  if (entry.type !== 'blob') return false;
  const dotIndex = entry.path.lastIndexOf('.');
  if (dotIndex === -1) return false;
  const ext = entry.path.slice(dotIndex).toLowerCase();
  return SOURCE_EXTENSIONS.has(ext);
};

const isSkippedPath = (filePath: string): boolean =>
  SKIP_PATHS.some((skip) =>
    filePath.startsWith(skip + '/') || filePath.includes('/' + skip + '/')
  );

// Scores a repo file by how closely related it is to the changed files.
// Higher score = more relevant.
const scoreRelevance = (repoPath: string, changedFiles: ProcessedFile[]): number => {
  let score = 0;
  for (const changed of changedFiles) {
    // Same directory gets a high score.
    const changedDir = changed.filename.includes('/')
      ? changed.filename.slice(0, changed.filename.lastIndexOf('/'))
      : '';
    const repoDir = repoPath.includes('/')
      ? repoPath.slice(0, repoPath.lastIndexOf('/'))
      : '';
    if (changedDir && repoDir === changedDir) score += 10;

    // Shared parent directory.
    const changedParts = changed.filename.split('/');
    const repoParts = repoPath.split('/');
    let commonDepth = 0;
    for (let i = 0; i < Math.min(changedParts.length, repoParts.length) - 1; i++) {
      if (changedParts[i] === repoParts[i]) commonDepth++;
      else break;
    }
    score += commonDepth * 3;

    // File is imported / referenced in the changed file's content.
    const baseName = repoPath.includes('/')
      ? repoPath.slice(repoPath.lastIndexOf('/') + 1)
      : repoPath;
    const nameNoExt = baseName.includes('.')
      ? baseName.slice(0, baseName.lastIndexOf('.'))
      : baseName;
    if (nameNoExt && changed.content.includes(nameNoExt)) score += 15;
  }
  return score;
};

// Formats the tree listing as a compact directory structure.
const formatTreeListing = (entries: GitHubTreeEntry[]): string => {
  const paths = entries
    .filter((e) => e.type === 'blob' && !isSkippedPath(e.path))
    .map((e) => e.path);
  return paths.join('\n');
};

/*
 * Fetches the repo tree and content of the most relevant source files,
 * returning a context block ready for injection into analysis prompts.
 */
export const fetchRepoContext = async (
  repoInfo: RepoInfo,
  changedFiles: ProcessedFile[]
): Promise<string> => {
  const { owner, repo, headSha, installationId } = repoInfo;

  const tree = await fetchRepoTree(owner, repo, headSha, installationId);
  if (tree.length === 0) {
    logger.warn({ owner, repo }, "Empty repo tree — skipping repo context");
    return '';
  }

  const treeListing = formatTreeListing(tree);

  // Identify and rank source files not already in the changed set.
  const changedPaths = new Set(changedFiles.map((f) => f.filename));
  const candidates = tree
    .filter((e) => isSourceFile(e) && !isSkippedPath(e.path) && !changedPaths.has(e.path))
    .map((entry) => ({
      path: entry.path,
      score: scoreRelevance(entry.path, changedFiles),
    }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, openAIConfig.repoContextFileLimit);

  let repoFilesContext = '';
  if (candidates.length > 0) {
    const fetched = await fetchRepoFileContents(
      owner, repo, headSha,
      candidates.map((c) => c.path),
      installationId
    );

    let totalChars = 0;
    const blocks: string[] = [];
    for (const file of fetched) {
      if (!file.content) continue;
      const truncated = file.content.slice(0, openAIConfig.fileContentSizeLimit);
      if (totalChars + truncated.length > openAIConfig.repoContextSizeLimit) break;
      totalChars += truncated.length;
      blocks.push(`// ${file.path}\n${truncated}`);
    }

    if (blocks.length > 0) {
      repoFilesContext = `\n\n<related_repo_files>\n${blocks.join('\n\n---\n\n')}\n</related_repo_files>`;
    }
  }

  return `<repo_file_tree>\n${treeListing}\n</repo_file_tree>${repoFilesContext}`;
};
