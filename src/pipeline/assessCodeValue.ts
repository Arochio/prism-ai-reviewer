// Computes a composite "code value" score per PR from quantity and complexity signals.
// Used silently to build developer profiles — not surfaced in review comments.

import type { ProcessedFile } from './extractDiff';
import type { PassResult } from './rankFindings';

export interface CodeValueResult {
  quantityScore: number;   // 0-100: normalized lines-added volume
  complexityScore: number; // 0-100: heuristic complexity of changed code
  codeValue: number;       // 0-100: combined score (40% quantity + 60% complexity)
  linesAdded: number;      // raw count of added lines across all file patches
  filesChanged: number;    // number of files in the analysis set
}

// Counts lines added in a unified diff patch (+ lines, excluding +++ header).
const countAddedLines = (patch: string): number =>
  patch.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;

// Scores cyclomatic-style complexity from added diff lines only.
// Counts branch/decision points actually introduced by the change, not pre-existing code.
const scoreCyclomaticFromPatch = (patch: string): number => {
  const addedLines = patch
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'));

  let points = 0;
  const branchRe = /\b(if|for|foreach|while|do|switch|case|catch)\b/gi;
  const logicalRe = /&&|\|\||\?\?/g;

  for (const line of addedLines) {
    points += (line.match(branchRe) ?? []).length;
    points += (line.match(logicalRe) ?? []).length;
  }

  // 30 decision points ≈ ceiling; above that is still very high complexity.
  return Math.min(100, Math.round((points / 30) * 100));
};

// Scores keyword-based domain complexity signals against file content.
// Covers algorithmic, concurrency, type-level, and domain patterns.
const scoreKeywordComplexity = (content: string): number => {
  const lower = content.toLowerCase();
  let score = 0;

  const signals: Array<[RegExp, number]> = [
    // Recursive / divide-and-conquer patterns
    [/\b(recursion|recursive|recurse)\b/, 12],
    [/\b(memoiz|dynamic.{0,5}programming|dp\[)/, 12],
    [/\b(binary.?search|quicksort|merge.?sort|heap.?sort|topolog\w+)\b/, 10],
    [/\b(graph|trie|avl|red.?black|b.?tree)\b/, 10],

    // Async / concurrency primitives
    [/\bpromise\.(all|race|allsettled|any)\b/, 8],
    [/\b(mutex|semaphore|atomic|rwlock|spin.?lock)\b/, 10],
    [/\b(worker_thread|cluster\.fork|child_process)\b/, 8],

    // Sophisticated error handling (catch + rethrow or wrap)
    [/catch\s*\([^)]*\)[^{]*\{[^}]*throw\b/, 5],

    // Type-level complexity (generics with multiple params)
    [/<[A-Z][A-Za-z]*(?:,\s*[A-Za-z]+){1,}>/, 8],
    [/\b(abstract\s+class|interface\s+\w|protocol\s+\w|trait\s+\w)\b/, 5],

    // Design patterns
    [/\b(observer|factory|singleton|decorator|adapter|strategy|proxy|command|visitor)\b/, 8],

    // Parsing / compiler / protocol work
    [/\b(parser|tokenize|lexer|ast\b|bytecode|serialize|deserialize|codec)\b/, 10],

    // Mathematical / scientific
    [/\b(matrix|tensor|quaternion|fourier|integral|eigenvalu)\b/, 10],

    // Cryptography / security primitives
    [/\b(cipher|encrypt|decrypt|hmac|pbkdf|bcrypt|argon|ecdsa|rsa\b)\b/, 10],

    // Observability instrumentation
    [/\b(metric|trace|telemetry|instrumentation|opentelemetry)\b/, 5],
  ];

  for (const [regex, points] of signals) {
    if (regex.test(lower)) score += points;
  }

  return Math.min(100, score);
};

// Severity weights used to convert AI findings into a complexity proxy.
const SEVERITY_WEIGHTS: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

// Derives a complexity bonus (0-20) from AI pass findings.
// More severe and numerous findings indicate harder-to-review code.
const scoreFindingsSeverity = (ranked: PassResult[]): number => {
  let total = 0;
  for (const pass of ranked) {
    for (const finding of pass.findings) {
      const match = finding.match(/^\s*-\s*\[(\w+)\]/i);
      total += SEVERITY_WEIGHTS[match?.[1]?.toLowerCase() ?? ''] ?? 0;
    }
  }
  // 20 cumulative severity points → max bonus (e.g. 5 High findings = 15 pts).
  return Math.min(20, Math.round((total / 20) * 20));
};

export const assessCodeValue = (files: ProcessedFile[], ranked: PassResult[]): CodeValueResult => {
  const filesChanged = files.length;

  // Sum added lines across all file patches.
  const linesAdded = files.reduce((sum, f) => sum + countAddedLines(f.patch), 0);

  // Quantity: log₁₀ scale — 10 lines ≈ 33, 100 lines ≈ 67, 1000 lines = 100.
  const quantityScore = linesAdded === 0
    ? 0
    : Math.min(100, Math.round((Math.log10(linesAdded + 1) / 3) * 100));

  // Complexity: line-weighted per-file average so large files dominate over trivial ones.
  // Each file blends cyclomatic (diff-accurate, 60%) + keyword signals (domain, 40%).
  const lineWeights = files.map((f) => Math.max(1, countAddedLines(f.patch)));
  const totalWeight = lineWeights.reduce((a, b) => a + b, 0);
  const perFileBase = files.length === 0 ? 0 : Math.round(
    files.reduce((sum, f, i) => {
      const cyclomatic = scoreCyclomaticFromPatch(f.patch);
      const keyword = scoreKeywordComplexity(f.content);
      return sum + (cyclomatic * 0.6 + keyword * 0.4) * lineWeights[i];
    }, 0) / totalWeight
  );

  // Bonus for changes spanning multiple directories (cross-cutting work).
  const dirs = new Set(
    files.map((f) => {
      const idx = f.filename.lastIndexOf('/');
      return idx > 0 ? f.filename.slice(0, idx) : '(root)';
    })
  );
  const spreadBonus = Math.max(0, Math.min(20, (dirs.size - 1) * 5));

  // Bonus for multi-language changes.
  const exts = new Set(files.map((f) => f.filename.split('.').pop()?.toLowerCase() ?? ''));
  const langBonus = exts.size > 1 ? Math.min(10, (exts.size - 1) * 5) : 0;

  // Bonus from AI finding severity — harder code tends to attract more severe findings.
  const findingsBonus = scoreFindingsSeverity(ranked);

  const complexityScore = Math.min(100, Math.round(perFileBase + spreadBonus + langBonus + findingsBonus));

  // Final code value weights complexity more heavily than raw volume.
  const codeValue = Math.round(quantityScore * 0.4 + complexityScore * 0.6);

  return { quantityScore, complexityScore, codeValue, linesAdded, filesChanged };
};
