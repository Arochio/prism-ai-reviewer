# PRism AI Reviewer

An autonomous GitHub App that performs multi-pass AI code review — posting inline findings with one-click fix suggestions directly on the diff, silently profiling your developers, and recommending reviewers based on contribution history.

---

## How It Works

When a PR is opened or updated, PRism runs a full analysis pipeline:

1. **Extract diff** — processes changed files and prepares line-numbered source
2. **Retrieve RAG context** — queries Pinecone for similar past code to enrich prompts
3. **Fetch repo context** — pulls the file tree and related source files from GitHub
4. **Assess risk** — scores the PR using git history (file churn, author spread, PR size, timing)
5. **Run three analysis passes** — Bug & Security, Design, Performance — each with its own model
6. **Validate findings** — a fourth pass removes false positives, duplicates, and speculative issues
7. **Rank and fix** — findings sorted by severity; one-click suggestion blocks generated for eligible findings
8. **Post results** — inline diff comments (one thread per finding) + a summary comment
9. **Suggest reviewers** — appends reviewer recommendations to the summary based on developer profiles

On first install for a new repo, PRism **bootstraps in the background** — scanning up to 100 merged PRs to seed risk data and ingesting key files into the vector DB.

When a PR is **approved**, PRism appends an anonymized **review depth report** to the summary: file coverage, inline comment count, quick-approval detection, and risky path flags.

---

## Features

### AI Analysis
- **Multi-pass review** — separate Bug & Security, Design, and Performance passes keep findings focused and reduce cross-contamination
- **Validation pass** — a dedicated LLM call removes false positives before findings are posted
- **Per-pass model routing** — bug pass defaults to a stronger model (`gpt-4.1`); cheaper model used for design, performance, and validation passes; each overridable via env var
- **One-click fix suggestions** — eligible findings generate GitHub suggestion blocks reviewers can apply in one click
- **RAG enrichment** — Pinecone vector search injects semantically similar past code into every analysis prompt

### Intelligent Context
- **Git-history risk scoring** — churn rate, author spread, PR size, and commit timing are computed and injected as risk signals
- **Full repo context** — file tree and related source files fetched from GitHub and included in each pass
- **Custom review rules** — per-repo `.prism-rules` file plus global rules via `PRISM_GLOBAL_RULES` env var; rules injected into every pass as hard constraints

### Developer Intelligence
- **Silent developer profiling** — every analyzed PR silently updates a Pinecone profile for the author: languages, areas, code value, finding history, complexity trends
- **Code value scoring** — each PR receives a 0–100 code value score combining quantity (log-scaled lines added) and complexity (cyclomatic branch analysis + domain keyword signals + AI finding severity)
- **Reviewer suggestions** — when 2+ other developers have profiles in the repo, PRism appends a suggested reviewers section to the summary; selection blends relevance (semantic match to the PR's files/areas) with a growth boost so review load spreads across the team

### Feedback & Learning
- **Per-finding feedback** — reply `/prism-feedback 👍` or `/prism-feedback 👎 reason` to any finding; feedback is stored as vectors and injected into future reviews as hard DO/DO NOT rules
- **Review depth reporting** — after each PR approval, PRism appends anonymized review stats: file coverage ratio, inline comment count, time-to-approval, and flags for risky paths (auth, migrations, crypto, etc.)

### Infrastructure
- **Deduplicating vector store** — file embeddings use stable per-file IDs (`repo:owner/repo:path`) so repeated PR reviews upsert in place rather than accumulating vectors
- **Redis caching** — identical file sets return cached analysis instantly (cache key includes model settings, repo context, and risk signals)
- **Retroactive bootstrap** — new repos are automatically seeded from merged PR history in the background without blocking review delivery
- **Incremental ingestion** — push events keep the vector DB current as code evolves

---

## Architecture

```
Webhook (pull_request / push / issue_comment / pull_request_review)
  │
  ├─ pull_request ──► Extract Diff
  │                     │
  │                     ├─ Retrieve RAG Context (Pinecone)
  │                     ├─ Fetch Repo Context (GitHub API)
  │                     ├─ Assess PR Risk (git history)
  │                     │
  │                     ├─ Bug & Security Pass  (gpt-4.1)
  │                     ├─ Design Pass          (gpt-4o-mini)
  │                     ├─ Performance Pass     (gpt-4o-mini)
  │                     └─ Validation Pass      (gpt-4o-mini)
  │                          │
  │                          ├─ Rank Findings
  │                          ├─ Generate Fix Suggestions
  │                          ├─ Split Inline / Summary
  │                          ├─ Post GitHub Comments
  │                          ├─ Update Embeddings (Pinecone)
  │                          ├─ Update Developer Profile (Pinecone)
  │                          └─ Suggest Reviewers
  │
  ├─ push ──────────► Ingest Changed Files (Pinecone)
  ├─ issue_comment ─► Parse /prism-feedback → Store Feedback Vector
  └─ pull_request_review ─► Append Review Depth Report
```

---

## Setup

### Prerequisites

- Node.js 18+
- A [GitHub App](https://docs.github.com/en/apps/creating-github-apps) (see permissions below)
- OpenAI API key
- Pinecone index (dimension **1536**, metric **cosine**)
- Redis (optional — disabling just turns off response caching)

### Install

```bash
git clone https://github.com/Arochio/prism-ai-reviewer.git
cd prism-ai-reviewer
npm install
cp .env.example .env   # fill in required keys
npm run dev            # start with hot reload
```

Expose the server:
```bash
ngrok http 3000
```

Set your GitHub App webhook URL to `https://<ngrok-url>/webhook` with content type `application/json`.

---

## Environment Variables

### Required

| Variable | Description |
|---|---|
| `GITHUB_APP_ID` | GitHub App numeric ID |
| `GITHUB_PRIVATE_KEY` | PEM private key (use `\n` for newlines in a single-line string) |
| `GITHUB_WEBHOOK_SECRET` | Webhook secret set in GitHub App settings |
| `OPENAI_API_KEY` | OpenAI API key |
| `PINECONE_API_KEY` | Pinecone API key |
| `PINECONE_INDEX_NAME` | Pinecone index name (dimension 1536, cosine metric) |

### Per-Pass Model Routing

Each analysis pass can be pointed at a different model. Defaults favour accuracy on the bug pass where it matters most and cost efficiency on the others.

| Variable | Default | Pass |
|---|---|---|
| `OPENAI_BUG_PASS_MODEL` | `gpt-4.1` | Bug & Security |
| `OPENAI_DESIGN_PASS_MODEL` | `gpt-4o-mini` | Design |
| `OPENAI_PERFORMANCE_PASS_MODEL` | `gpt-4o-mini` | Performance |
| `OPENAI_VALIDATION_PASS_MODEL` | `gpt-4o-mini` | Validation (false-positive filter) |
| `OPENAI_MODEL` | `gpt-4o-mini` | Fallback default for anything not listed above |

### Optional Tuning

| Variable | Default | Description |
|---|---|---|
| `OPENAI_MAX_TOKENS` | `1200` | Max tokens per API call |
| `OPENAI_TEMPERATURE` | `0.2` | Sampling temperature |
| `OPENAI_EMBEDDING_MODEL` | `text-embedding-3-small` | Embedding model |
| `OPENAI_FILE_CONTENT_SIZE_LIMIT` | `16000` | Max chars per file sent to the model |
| `OPENAI_TOTAL_FILES_LIMIT` | `8` | Max files analyzed per PR |
| `OPENAI_BYPASS_LARGE_FILES` | `true` | Skip files exceeding the size limit |
| `OPENAI_ENABLE_CACHE` | `true` | Enable Redis response caching |
| `OPENAI_ENABLE_EMBEDDINGS` | `true` | Enable Pinecone embedding storage and retrieval |
| `OPENAI_VECTOR_DB_TOP_K` | `5` | Similar vectors returned per RAG query |
| `REPO_CONTEXT_FILE_LIMIT` | `15` | Max related repo files included in prompts |
| `REPO_CONTEXT_SIZE_LIMIT` | `32000` | Max total chars of repo context per prompt |
| `PRISM_GLOBAL_RULES` | *(see .env.example)* | Newline-separated rules injected into every pass |
| `REDIS_URL` | — | Redis connection URL (or use `REDIS_HOST` + `REDIS_PORT`) |
| `PORT` | `3000` | HTTP server port |

---

## GitHub App Configuration

### Permissions

| Permission | Access |
|---|---|
| Pull requests | Read & Write |
| Contents | Read |
| Issues | Read & Write |
| Metadata | Read |

### Webhook Events

Subscribe to all of the following:

- **Pull requests** — triggers analysis on open/synchronize/reopen
- **Push** — keeps vector DB current as code is pushed
- **Issue comments** — handles `/prism-feedback` commands
- **Pull request reviews** — triggers review depth reporting on approval
- **Pull request review comments** — captures inline feedback

---

## Custom Review Rules

Add a `.prism-rules` file to any repo root to inject project-specific constraints into every analysis pass:

```
Do not flag missing error handling in fire-and-forget background tasks.
Always flag direct database access outside of the repository layer.
Treat any use of eval() or Function() constructor as Critical severity.
```

Global rules that apply across all repos can be set via the `PRISM_GLOBAL_RULES` environment variable (newline-separated). Per-repo rules take priority.

---

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start dev server with hot reload |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run compiled output |
| `npm test` | Run test suite (Vitest) |
| `npm run lint` | Lint with ESLint |
| `npm run ingest` | One-time full repo ingestion into Pinecone |
