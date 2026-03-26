# PRism AI Reviewer

A GitHub webhook-based application that uses AI to automatically review pull requests.

## About

This project is built by a software engineering student exploring AI tools. It integrates with GitHub webhooks to receive PR events, fetches PR data via the GitHub API, and performs repo-aware AI code reviews using OpenAI. Reviews are posted as comments directly on the PR.

## Features

- Receives GitHub webhook events for pull requests
- Authenticates using a GitHub App
- Fetches PR details, changed files, and existing reviews
- **Repo-aware analysis** — fetches the full repository file tree and content of related source files so the AI understands how changes fit the wider codebase
- Runs three parallel analysis passes: Bugs & Security, Design, and Performance
- Posts AI-generated reviews as PR comments with inline suggestions
- User feedback loop (`/prism-feedback 👍` / `👎`) stored as embeddings to calibrate future reviews
- Configurable OpenAI settings (model, tokens, caching, file limits)
- Bypasses large files to avoid token limits
- Caches OpenAI responses via Redis for identical file sets
- Generates OpenAI embeddings for each changed file
- Stores embeddings in Pinecone vector database per PR and file
- Queries for similar files from previous PRs and includes them in the AI prompt for richer, context-aware reviews

## Prerequisites

- Node.js (v18 or higher)
- npm
- A GitHub App with private key
- OpenAI API key
- Pinecone account and API key (for vector database)
- ngrok or similar tool for webhook tunneling

## Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/Arochio/prism-ai-reviewer.git
   cd prism-ai-reviewer
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Create a `.env` file based on the example:
   ```bash
   cp .env.example .env
   ```
   Then fill in the required values. See [`.env.example`](.env.example) for every available variable with defaults.

   **Required variables:**
   | Variable | Description |
   |---|---|
   | `GITHUB_APP_ID` | Your GitHub App's numeric ID |
   | `GITHUB_PRIVATE_KEY` | PEM private key (use literal `\n` for newlines) |
   | `GITHUB_WEBHOOK_SECRET` | Secret configured in GitHub webhook settings |
   | `OPENAI_API_KEY` | OpenAI API key |
   | `PINECONE_API_KEY` | Pinecone API key |
   | `PINECONE_INDEX_NAME` | Pinecone index name (dimension **1536**, metric **cosine**) |

   **Redis cache** (needed when `OPENAI_ENABLE_CACHE=true`):<br>
   Set `REDIS_URL` (e.g. `redis://localhost:6379`) **or** `REDIS_HOST` + `REDIS_PORT` with optional `REDIS_USERNAME` / `REDIS_PASSWORD`. If both are set, `REDIS_URL` takes precedence. Use `rediss://` for TLS endpoints.

   **Optional tuning variables** (all have sensible defaults in `.env.example`):
   | Variable | Default | Description |
   |---|---|---|
   | `PORT` | `3000` | Server listen port |
   | `OPENAI_MODEL` | `gpt-4o-mini` | OpenAI model ID |
   | `OPENAI_MAX_TOKENS` | `1200` | Max tokens per completion |
   | `OPENAI_TEMPERATURE` | `0.2` | Sampling temperature |
   | `OPENAI_TOP_P` | `1` | Nucleus sampling |
   | `OPENAI_N` | `1` | Number of completions |
   | `OPENAI_FREQUENCY_PENALTY` | `0` | Frequency penalty |
   | `OPENAI_PRESENCE_PENALTY` | `0` | Presence penalty |
   | `OPENAI_FILE_CONTENT_SIZE_LIMIT` | `16000` | Max chars sent per file |
   | `OPENAI_TOTAL_FILES_LIMIT` | `8` | Max changed files to analyze |
   | `OPENAI_BYPASS_LARGE_FILES` | `true` | Skip files exceeding size limit |
   | `OPENAI_ENABLE_CACHE` | `true` | Cache OpenAI responses in Redis |
   | `OPENAI_CACHE_TTL_SECONDS` | `3600` | Redis cache TTL |
   | `OPENAI_ENABLE_EMBEDDINGS` | `true` | Generate embeddings for RAG |
   | `OPENAI_EMBEDDING_MODEL` | `text-embedding-3-small` | Embedding model |
   | `OPENAI_VECTOR_DB_TOP_K` | `5` | Similar vectors to retrieve |
   | `REPO_CONTEXT_FILE_LIMIT` | `15` | Max related repo files fetched for context |
   | `REPO_CONTEXT_SIZE_LIMIT` | `32000` | Max total chars of repo context |

> **Pinecone setup**: Create a Pinecone index with **dimension 1536** and metric **cosine** (required for `text-embedding-3-small`). Any other dimension will cause a `PineconeBadRequestError` at runtime.

## Usage

1. Start the development server:
   ```bash
   npm run dev
   ```

2. Expose the local server to the internet using ngrok:
   ```bash
   ngrok http 3000
   ```

3. In your GitHub repository settings, add a webhook:
   - Payload URL: `https://your-ngrok-url.ngrok.io/webhook`
   - Content type: `application/json`
   - Secret: Your `GITHUB_WEBHOOK_SECRET`
   - Events: Select "Pull requests"

4. Install the GitHub App on your repository.

5. Create or update a pull request in the repository to trigger the webhook. The app will automatically analyze the changed files and post an AI-generated review comment on the PR.

## Configuration

- **GitHub App Setup**: Create an app in GitHub Developer settings. Set permissions for Pull requests (read/write), Contents (read), and Issues (read/write). Subscribe to "Pull request" events.
- **Environment Variables**: Copy `.env.example` to `.env` and fill in secrets. Ensure `.env` is not committed (it's already in `.gitignore`).
- **Webhook Verification**: The app verifies webhook signatures for security.
- **OpenAI Configuration**: Customize AI behavior via env vars (e.g., model selection, token limits, caching). Defaults are optimized for cost and performance.
- **Repo Context**: The AI receives the full repository file tree and the content of the most relevant related source files alongside the changed files. Tune breadth with `REPO_CONTEXT_FILE_LIMIT` and total size with `REPO_CONTEXT_SIZE_LIMIT`.
- **Redis Cache**: `OPENAI_ENABLE_CACHE=true` uses Redis. Configure with either `REDIS_URL` or `REDIS_HOST` + `REDIS_PORT` (with optional `REDIS_USERNAME`/`REDIS_PASSWORD`). Use `redis://` for non-TLS and `rediss://` for TLS. If Redis is unavailable, caching is automatically disabled and analysis still runs.
- **Embeddings & Vector DB**: Set `OPENAI_ENABLE_EMBEDDINGS=true` to enable embedding generation and Pinecone storage. Each analyzed file's embedding is stored under the key `pr-{prNumber}-{filename}`. On subsequent PRs, similar files from past PRs are retrieved and included in the AI prompt. `OPENAI_VECTOR_DB_TOP_K` controls how many similar results are returned (default: 5).
- **Feedback Loop**: Reply to any AI review comment with `/prism-feedback 👍` or `/prism-feedback 👎 explanation` to store feedback. Feedback is embedded and retrieved on future reviews of similar code to calibrate severity and focus.

## Development

- Run linter: `npm run lint`
- The project uses TypeScript with `ts-node-dev` for hot reloading.

## Contributing

As a student project, contributions are welcome! Open issues for bugs or feature requests, or submit pull requests.

## License

This project is licensed under the ISC License.
