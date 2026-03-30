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

// Scores the algorithmic and structural complexity of source content on a 0-100 scale.
// Each signal is detected once per file (presence, not frequency) to avoid inflation.
const scoreContentComplexity = (content: string): number => {
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

export const assessCodeValue = (files: ProcessedFile[], _ranked: PassResult[]): CodeValueResult => {
  const filesChanged = files.length;

  // Sum added lines across all file patches.
  const linesAdded = files.reduce((sum, f) => sum + countAddedLines(f.patch), 0);

  // Quantity: log₁₀ scale — 10 lines ≈ 33, 100 lines ≈ 67, 1000 lines = 100.
  const quantityScore = linesAdded === 0
    ? 0
    : Math.min(100, Math.round((Math.log10(linesAdded + 1) / 3) * 100));

  // Complexity: average per-file heuristic score.
  const perFileComplexity = files.map((f) => scoreContentComplexity(f.content));
  const avgComplexity = perFileComplexity.length > 0
    ? perFileComplexity.reduce((a, b) => a + b, 0) / perFileComplexity.length
    : 0;

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

  const complexityScore = Math.min(100, Math.round(avgComplexity + spreadBonus + langBonus));

  // Final code value weights complexity more heavily than raw volume.
  const codeValue = Math.round(quantityScore * 0.4 + complexityScore * 0.6);

  return { quantityScore, complexityScore, codeValue, linesAdded, filesChanged };
};
