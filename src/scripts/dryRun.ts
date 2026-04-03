// Runs the full analysis pipeline locally against staged or specified files
// without posting to GitHub. Useful for testing prompts and configuration
//
// Usage:
//   npm run dry-run                          # analyzes all git-staged files
//   npm run dry-run -- --files src/index.ts src/utils/retry.ts
//   npm run dry-run -- --all                 # analyzes all tracked files (up to limit)

import 'dotenv/config';
import * as fs from 'fs';
import { execSync } from 'child_process';
import { extractDiff, type AnalyzableFile } from '../pipeline/extractDiff';
import { runBugPass } from '../pipeline/analyze/bugPass';
import { runDesignPass } from '../pipeline/analyze/designPass';
import { runPerformancePass } from '../pipeline/analyze/performancePass';
import { runValidationPass } from '../pipeline/analyze/validationPass';
import { rankFindings } from '../pipeline/rankFindings';
import { generateSummary } from '../pipeline/generateSummary';
import { callOpenAI } from '../services/openaiService';
import { openAIConfig } from '../config/openai.config';

const SKIP_PATHS = ['node_modules', 'dist', '.git', '.env', 'package-lock.json'];

// File extensions to analyze (skip config files, images, etc.)
const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.java', '.go', '.rs', '.rb', '.php',
  '.cs', '.cpp', '.c', '.h', '.hpp',
  '.sql', '.sh', '.yml', '.yaml', '.json', '.xml',
  '.css', '.scss', '.less', '.html',
]);

const isCodeFile = (filePath: string): boolean => {
  const ext = filePath.substring(filePath.lastIndexOf('.'));
  return CODE_EXTENSIONS.has(ext.toLowerCase());
};

const shouldSkip = (filePath: string): boolean => {
  // Check SKIP_PATHS
  if (SKIP_PATHS.some((skip) => filePath.startsWith(skip) || filePath.includes(`/${skip}`))) {
    return true;
  }

  // Skip non-code files
  if (!isCodeFile(filePath)) {
    return true;
  }

  // Check .gitignore
  try {
    execSync(`git check-ignore "${filePath}"`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'] // silent
    });
    return true; // File is in .gitignore
  } catch {
    return false; // File is not in .gitignore or git not available
  }
};

const readFileSafe = (filePath: string): string | null => {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
};

const parseArgs = (): { files: string[] } => {
  const args = process.argv.slice(2);

  if (args.includes('--all')) {
    const tracked = execSync('git ls-files', { encoding: 'utf-8' })
      .split('\n')
      .map((f) => f.trim())
      .filter((f) => f.length > 0 && !shouldSkip(f));
    return { files: tracked };
  }

  const filesIdx = args.indexOf('--files');
  if (filesIdx !== -1) {
    const files = args.slice(filesIdx + 1).filter((a) => !a.startsWith('--'));
    if (files.length === 0) {
      console.error('Error: --files requires at least one file path');
      process.exit(1);
    }
    return { files };
  }

  // Default: git staged files
  try {
    const staged = execSync('git diff --cached --name-only', { encoding: 'utf-8' })
      .split('\n')
      .map((f) => f.trim())
      .filter((f) => f.length > 0 && !shouldSkip(f));
    if (staged.length > 0) return { files: staged };
  } catch {
    // git not available or not in a repo
  }

  // Fallback: git changed files (unstaged)
  try {
    const changed = execSync('git diff --name-only HEAD', { encoding: 'utf-8' })
      .split('\n')
      .map((f) => f.trim())
      .filter((f) => f.length > 0 && !shouldSkip(f));
    if (changed.length > 0) return { files: changed };
  } catch {
    // not in a git repo
  }

  console.error('No files to analyze. Use --files <paths> or --all, or stage some changes.');
  process.exit(1);
};

const main = async () => {
  console.log('🔍 PRism Dry Run\n');

  if (!process.env.OPENAI_API_KEY) {
    console.error('Error: OPENAI_API_KEY is required in .env');
    process.exit(1);
  }

  const { files: filePaths } = parseArgs();

  console.log(`Model: ${openAIConfig.model}`);
  console.log(`Files: ${filePaths.length}`);
  console.log(`File size limit: ${openAIConfig.fileContentSizeLimit} chars`);
  console.log(`Total files limit: ${openAIConfig.totalFilesLimit}\n`);

  const analyzableFiles: AnalyzableFile[] = filePaths
    .map((filePath) => ({
      filename: filePath,
      status: 'modified' as const,
      content: readFileSafe(filePath),
    }))
    .filter((f) => f.content !== null);

  console.log(`Readable files: ${analyzableFiles.length}`);

  // For dry runs, analyze all files (no limit)
  const processedFiles = extractDiff(analyzableFiles, Infinity);
  console.log(`After filtering: ${processedFiles.length} files\n`);

  if (processedFiles.length === 0) {
    console.log('No files to analyze after filtering.');
    return;
  }

  for (const f of processedFiles) {
    console.log(`  • ${f.filename} (${f.content.length} chars)`);
  }
  console.log();

  // Run analysis without repo context (local-only)
  const repoContext = '';
  const customRules = '';

  console.log('Running bug pass...');
  const bugRaw = await runBugPass(processedFiles, callOpenAI, repoContext, customRules);

  console.log('Running design pass...');
  const designRaw = await runDesignPass(processedFiles, callOpenAI, repoContext, customRules);

  console.log('Running performance pass...');
  const performanceRaw = await runPerformancePass(processedFiles, callOpenAI, repoContext, customRules);

  console.log('Running validation pass...');
  const { bugValidated, designValidated, performanceValidated } = await runValidationPass(
    bugRaw, designRaw, performanceRaw,
    processedFiles, repoContext, customRules, callOpenAI
  );

  const ranked = rankFindings(bugValidated, designValidated, performanceValidated);
  const summary = generateSummary(ranked);

  console.log('\n' + '='.repeat(60));
  console.log('REVIEW OUTPUT');
  console.log('='.repeat(60) + '\n');
  console.log(summary);
  console.log('\n' + '='.repeat(60));

  // Show raw vs validated for debugging
  console.log('\n--- Raw findings (pre-validation) ---');
  console.log('Bugs:', bugRaw);
  console.log('Design:', designRaw);
  console.log('Performance:', performanceRaw);
  console.log('\n--- Validated findings ---');
  console.log('Bugs:', bugValidated);
  console.log('Design:', designValidated);
  console.log('Performance:', performanceValidated);
};

main().catch((err) => {
  console.error('Dry run failed:', err);
  process.exit(1);
});
