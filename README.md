# PRismAI-Reviewer

A GitHub Marketplace App that performs multi-pass AI code review — posting inline findings with one-click fix suggestions directly on the diff, silently profiling developers, and recommending reviewers based on contribution history.

---

## How It Works

When a PR is opened or updated, PRismAI-Reviewer runs a full analysis pipeline:

1. **Validate installation** — checks the installation is active and within its monthly review limit
2. **Extract diff** — processes changed files and prepares line-numbered source
3. **Retrieve RAG context** — queries Pinecone for similar past code to enrich prompts *(Pro/Team)*
4. **Fetch repo context** — pulls the file tree and related source files from GitHub
5. **Assess risk** — scores the PR using git history (file churn, author spread, PR size, timing) *(Pro/Team)*
6. **Run analysis passes** — Bug & Security (all plans), Design (all plans), Performance *(Pro/Team)*
7. **Validate findings** — a fourth pass removes false positives, duplicates, and speculative issues
8. **Rank and fix** — findings sorted by severity; one-click suggestion blocks generated for eligible findings *(Pro/Team)*
9. **Post results** — inline diff comments (one thread per finding) + a summary comment
10. **Suggest reviewers** — appends reviewer recommendations to the summary based on developer profiles *(Team)*

On first install for a new repo, PRismAI-Reviewer **bootstraps in the background** — scanning up to 100 merged PRs to seed risk data and ingesting key files into the vector DB.

When a PR is **approved**, PRismAI-Reviewer appends an anonymized **review depth report** to the summary: file coverage, inline comment count, quick-approval detection, and risky path flags.

---

## Features

### AI Analysis
- **Multi-pass review** — separate Bug & Security, Design, and Performance passes keep findings focused and reduce cross-contamination
- **Validation pass** — a dedicated LLM call removes false positives before findings are posted
- **Per-pass model routing** — bug pass defaults to a stronger model (`gpt-4.1`); cheaper model used for design, performance, and validation passes; each overridable via env var
- **One-click fix suggestions** — eligible findings generate GitHub suggestion blocks reviewers can apply in one click *(Pro/Team)*
- **RAG enrichment** — Pinecone vector search injects semantically similar past code into every analysis prompt *(Pro/Team)*

### Intelligent Context
- **Git-history risk scoring** — churn rate, author spread, PR size, and commit timing are computed and injected as risk signals *(Pro/Team)*
- **Full repo context** — file tree and related source files fetched from GitHub and included in each pass
- **Custom review rules** — per-repo `.prism-rules` file plus global rules via `PRISM_GLOBAL_RULES` env var; rules injected into every pass as hard constraints *(Pro/Team)*

### Developer Intelligence
- **Silent developer profiling** — every analyzed PR silently updates a Pinecone profile for the author: languages, areas, code value, finding history, complexity trends
- **Code value scoring** — each PR receives a 0–100 code value score combining quantity (log-scaled lines added) and complexity (cyclomatic branch analysis + domain keyword signals + AI finding severity)
- **Reviewer suggestions** — when 2+ other developers have profiles in the repo, PRismAI-Reviewer appends a suggested reviewers section to the summary *(Team)*

### Feedback & Learning
- **Per-finding feedback** — reply `/prism-feedback 👍` or `/prism-feedback 👎 reason` to any finding; feedback is stored as vectors and injected into future reviews as hard DO/DO NOT rules
- **Review depth reporting** — after each PR approval, PRismAI-Reviewer appends anonymized review stats: file coverage ratio, inline comment count, time-to-approval, and flags for risky paths (auth, migrations, crypto, etc.)

### Multi-Tenant SaaS Infrastructure
- **PostgreSQL via Drizzle ORM** — tracks installations, usage periods, review events, and marketplace billing events
- **Plan enforcement** — monthly review limits enforced atomically per installation; posts an in-PR notice when the limit is reached
- **Feature gating** — all analysis features are gated per plan; free users get bug + design passes, Pro/Team unlock the full suite
- **Tenant-scoped isolation** — Redis cache keys and Pinecone vector metadata are prefixed/filtered per `installationId`
- **Per-tenant config** — `installations.settings` column supports per-tenant OpenAI config overrides (model, token limits, etc.)
- **Installation lifecycle** — handles `installation.created/deleted/suspend/unsuspend` and `marketplace_purchase` webhooks

### Infrastructure
- **Deduplicating vector store** — file embeddings use stable per-file IDs (`repo:owner/repo:path`) so repeated PR reviews upsert in place
- **Redis caching** — identical file sets return cached analysis instantly (cache key includes model settings, repo context, and risk signals)
- **Retroactive bootstrap** — new repos are automatically seeded from merged PR history in the background
- **Incremental ingestion** — push events keep the vector DB current as code evolves

---

## Plans

| Feature | Free | Pro | Team |
|---|:---:|:---:|:---:|
| Reviews/month | 50 | 500 | Unlimited |
| Bug & Security pass | ✓ | ✓ | ✓ |
| Design pass | ✓ | ✓ | ✓ |
| Performance pass | | ✓ | ✓ |
| Fix suggestions | | ✓ | ✓ |
| Risk scoring | | ✓ | ✓ |
| RAG context | | ✓ | ✓ |
| Custom rules | | ✓ | ✓ |
| Reviewer recommendations | | | ✓ |

---

## Architecture

```
Webhook (pull_request / push / issue_comment / pull_request_review / installation / marketplace_purchase)
  │
  ├─ pull_request ──► Validate Installation + Usage Limit
  │                     │
  │                     ├─ Extract Diff
  │                     ├─ Retrieve RAG Context (Pinecone) [Pro/Team]
  │                     ├─ Fetch Repo Context (GitHub API)
  │                     ├─ Assess PR Risk (git history) [Pro/Team]
  │                     │
  │                     ├─ Bug & Security Pass  (gpt-4.1)
  │                     ├─ Design Pass          (gpt-4o-mini)
  │                     ├─ Performance Pass     (gpt-4o-mini) [Pro/Team]
  │                     └─ Validation Pass      (gpt-4o-mini)
  │                          │
  │                          ├─ Rank Findings
  │                          ├─ Generate Fix Suggestions [Pro/Team]
  │                          ├─ Split Inline / Summary
  │                          ├─ Post GitHub Comments
  │                          ├─ Update Embeddings (Pinecone)
  │                          ├─ Update Developer Profile (Pinecone)
  │                          └─ Suggest Reviewers [Team]
  │
  ├─ push ──────────────► Ingest Changed Files (Pinecone)
  ├─ issue_comment ─────► Parse /prism-feedback → Store Feedback Vector
  ├─ pull_request_review ► Append Review Depth Report
  ├─ installation ──────► Upsert / Suspend / Delete Installation (PostgreSQL)
  └─ marketplace_purchase ► Update Plan + Billing State (PostgreSQL)
```

---

## Deployment

PRismAI-Reviewer is designed for one-click deployment on [Railway](https://railway.app).

### Railway Setup

1. Fork or clone this repo and push to GitHub
2. Create a new Railway project → **Deploy from GitHub repo**
3. Add a **PostgreSQL** addon — `DATABASE_URL` is injected automatically
4. Add all required environment variables (see below)
5. Railway builds via `Dockerfile` and runs `start.sh`, which runs DB migrations then starts the server
6. Set your GitHub App or repository webhook URL to your Railway public domain: `https://YOUR-DOMAIN/webhook`

The `/health` endpoint (`GET /health`) returns `{ "status": "ok" }` and is used by Railway's healthcheck.

### Local Development

**Prerequisites**
- Node.js 20+
- A [GitHub App](https://docs.github.com/en/apps/creating-github-apps) **or** a [repository/organization webhook](https://docs.github.com/en/webhooks/using-webhooks/creating-webhooks) (see GitHub Configuration below)
- OpenAI API key
- Pinecone index (dimension **1536**, metric **cosine**)
- PostgreSQL database
- Redis (optional — disabling turns off response caching)

```bash
git clone https://github.com/Arochio/prism-ai-reviewer.git
cd prism-ai-reviewer
npm install
cp .env.example .env   # fill in required keys
npm run db:migrate     # run database migrations
npm run dev            # start with hot reload
```

Expose the local server:
```bash
ngrok http 3000
```

Set your GitHub App or repository webhook URL to `https://<ngrok-url>/webhook` with content type `application/json`.

---

## Environment Variables

### Required

| Variable | Description |
|---|---|
| `GITHUB_APP_ID` | GitHub App numeric ID *(GitHub App only)* |
| `GITHUB_PRIVATE_KEY` | PEM private key (use `\n` for newlines in a single-line string) *(GitHub App only)* |
| `GITHUB_WEBHOOK_SECRET` | Webhook secret (set in GitHub App settings or webhook config) |
| `OPENAI_API_KEY` | OpenAI API key |
| `PINECONE_API_KEY` | Pinecone API key |
| `PINECONE_INDEX_NAME` | Pinecone index name (dimension 1536, cosine metric) |
| `DATABASE_URL` | PostgreSQL connection string (auto-injected by Railway) |

### Per-Pass Model Routing

| Variable | Default | Pass |
|---|---|---|
| `OPENAI_BUG_PASS_MODEL` | `gpt-4.1` | Bug & Security |
| `OPENAI_DESIGN_PASS_MODEL` | `gpt-4o-mini` | Design |
| `OPENAI_PERFORMANCE_PASS_MODEL` | `gpt-4o-mini` | Performance |
| `OPENAI_VALIDATION_PASS_MODEL` | `gpt-4o-mini` | Validation (false-positive filter) |
| `OPENAI_MODEL` | `gpt-4o-mini` | Fallback default |

Any model supporting the standard chat completions API can be used (e.g. `gpt-4.1`, `gpt-4.1-mini`, `gpt-4o`). Reasoning models (`o1`, `o3`, `o4-mini`) are not supported — they reject the `temperature`, `top_p`, and penalty parameters.

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

## GitHub Configuration

PRismAI-Reviewer can receive events via a **GitHub App** (recommended — required for Marketplace listing, per-installation auth, and the `installation`/`marketplace_purchase` lifecycle events) or a plain **repository/organization webhook** (simpler self-hosted setup, no Marketplace features).

### Permissions

| Permission | Access |
|---|---|
| Pull requests | Read & Write |
| Contents | Read |
| Issues | Read & Write |
| Metadata | Read |

### Webhook Events

- **Pull requests** — triggers analysis on open/synchronize
- **Push** — keeps vector DB current as code is pushed
- **Issue comments** — handles `/prism-feedback` commands
- **Pull request reviews** — triggers review depth reporting on approval
- **Pull request review comments** — captures inline feedback
- **Installation** — manages installation lifecycle in PostgreSQL
- **Marketplace purchase** — syncs billing plan changes to PostgreSQL

---

## Custom Review Rules

Add a `.prism-rules` file to any repo root to inject project-specific constraints into every analysis pass *(Pro/Team only)*:

```
Do not flag missing error handling in fire-and-forget background tasks.
Always flag direct database access outside of the repository layer.
Treat any use of eval() or Function() constructor as Critical severity.
```

Global rules that apply across all repos can be set via the `PRISM_GLOBAL_RULES` environment variable (newline-separated).

---

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start dev server with hot reload |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run compiled output |
| `npm run db:migrate` | Run database migrations |
| `npm test` | Run test suite (Vitest) |
| `npm run lint` | Lint with ESLint |
| `npm run ingest` | One-time full repo ingestion into Pinecone |
| `npm run dry-run` | Test analysis pipeline without posting GitHub comments (analyzes git-staged files by default) |
| `npm run dry-run -- --all` | Dry run against all tracked code files (respects `.gitignore`) |
| `npm run dry-run -- --files src/foo.ts src/bar.ts` | Dry run against specific files |

---

## Database

PRismAI-Reviewer uses PostgreSQL (via [Drizzle ORM](https://orm.drizzle.team)) with four tables:

| Table | Purpose |
|---|---|
| `installations` | Tracks GitHub App installs, plan slugs, and status |
| `usage_periods` | Monthly review counts per installation |
| `review_events` | Log of every PR review attempted (status, timing) |
| `marketplace_events` | Raw log of all GitHub Marketplace billing events |

Migrations run automatically on deploy via `start.sh`.

---

## Third-Party Services

| Service | Purpose |
|---|---|
| [OpenAI](https://openai.com) | Powers all analysis passes |
| [Pinecone](https://pinecone.io) | Stores code embeddings for RAG and developer profiles |
| [Redis](https://redis.io) | Caches analysis results to reduce latency and cost |
| [Railway](https://railway.app) | Hosting and PostgreSQL |

