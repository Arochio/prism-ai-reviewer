# PRism AI Reviewer

A GitHub App that uses AI to review pull requests — posting inline findings with fix suggestions directly on the diff.

## How It Works

When a PR is opened or updated, PRism:

1. **Extracts the diff** and fetches related repo files for context
2. **Assesses risk** using git history (file churn, author spread, PR size, timing)
3. **Runs three analysis passes** — Bugs & Security, Design, Performance — then validates findings to remove false positives
4. **Ranks findings** by severity and generates one-click fix suggestions
5. **Posts results** as inline diff comments (each in its own thread) plus a summary comment

On first PR for a new repo, PRism **bootstraps in the background** — scanning ~100 merged PRs to seed risk data and ingesting key files into the vector DB for RAG context.

## Key Features

- **Multi-pass AI analysis** with false positive validation
- **Git-history risk scoring** — churn, size, spread, timing signals injected into prompts
- **Inline diff comments** with severity icons and threaded feedback
- **One-click fix suggestions** as GitHub suggestion blocks
- **RAG context** via Pinecone — similar code from past reviews enriches prompts
- **Per-finding feedback** — reply `/prism-feedback 👍` or `/prism-feedback 👎 reason`
- **Custom rules** via `.prism-rules` file in repo root
- **Incremental ingestion** — push events update the vector DB automatically
- **Redis caching** of AI responses for identical file sets
- **Retroactive bootstrap** — seeds knowledge base from merged PR history

## Setup

### Prerequisites

- Node.js v18+
- A [GitHub App](https://docs.github.com/en/apps/creating-github-apps) with PR read/write, Contents read, Issues read/write permissions
- OpenAI API key
- Pinecone index (dimension **1536**, metric **cosine**)
- Redis (optional, for caching)

### Install

```bash
git clone https://github.com/Arochio/prism-ai-reviewer.git
cd prism-ai-reviewer
npm install
cp .env.example .env  # fill in your keys
```

### Required Environment Variables

| Variable | Description |
|---|---|
| `GITHUB_APP_ID` | GitHub App numeric ID |
| `GITHUB_PRIVATE_KEY` | PEM private key (use `\n` for newlines) |
| `GITHUB_WEBHOOK_SECRET` | Webhook secret from GitHub App settings |
| `OPENAI_API_KEY` | OpenAI API key |
| `PINECONE_API_KEY` | Pinecone API key |
| `PINECONE_INDEX_NAME` | Pinecone index name |

For Redis, set `REDIS_URL` or `REDIS_HOST` + `REDIS_PORT`. See [`.env.example`](.env.example) for all optional tuning variables.

### Run

```bash
npm run dev          # start dev server (hot reload)
ngrok http 3000      # expose to internet
```

Then configure your GitHub App webhook to point at `https://<ngrok-url>/webhook` with content type `application/json`.

### GitHub App Events

Subscribe to: **Pull requests**, **Push**, **Issue comments**, **Pull request review comments**

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Dev server with hot reload |
| `npm run build` | Compile TypeScript |
| `npm start` | Run compiled output |
| `npm test` | Run tests (Vitest) |
| `npm run lint` | Lint with ESLint |
| `npm run ingest` | One-time full repo ingestion into Pinecone |

## Architecture

```
Webhook → Extract Diff → Retrieve RAG Context → Fetch Repo Context
  → Assess PR Risk → [Bug Pass, Design Pass, Performance Pass]
  → Validation Pass → Rank Findings → Generate Fixes
  → Split Findings → Post Inline Comments + Summary
```

## License

ISC
