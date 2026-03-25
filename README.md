# PRism AI Reviewer

A GitHub webhook-based application that uses AI to automatically review pull requests.

## About

This project is built by a software engineering student exploring AI tools. It integrates with GitHub webhooks to receive PR events, fetches PR data via the GitHub API, analyzes changed files using OpenAI's API, and posts AI-generated code reviews as comments on the PR.

## Features

- Receives GitHub webhook events for pull requests
- Authenticates using a GitHub App
- Fetches PR details, changed files, and existing reviews
- Analyzes file contents with OpenAI for code review suggestions
- Posts AI-generated reviews as comments on the PR
- Configurable OpenAI settings (model, tokens, caching, file limits)
- Bypasses large files to avoid token limits
- Caches OpenAI responses for identical file sets
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

3. Create a `.env` file in the root directory with the following variables:
   ```
   PORT=3000
   GITHUB_APP_ID=your_github_app_id
   GITHUB_PRIVATE_KEY=-----BEGIN RSA PRIVATE KEY-----\n...your_private_key...\n-----END RSA PRIVATE KEY-----
   GITHUB_WEBHOOK_SECRET=your_webhook_secret
   OPENAI_API_KEY=your_openai_api_key
   # Pinecone vector database
   PINECONE_API_KEY=your_pinecone_api_key
   PINECONE_INDEX_NAME=your_pinecone_index_name
   # Optional OpenAI configs (defaults provided)
   OPENAI_MODEL=gpt-4o-mini
   OPENAI_MAX_TOKENS=1200
   OPENAI_TEMPERATURE=0.2
   OPENAI_BYPASS_LARGE_FILES=true
   OPENAI_ENABLE_CACHE=true
   REDIS_URL=redis://localhost:6379
   # Alternative to REDIS_URL (object-style config)
   REDIS_HOST=localhost
   REDIS_PORT=6379
   REDIS_USERNAME=default
   REDIS_PASSWORD=your_redis_password
   OPENAI_CACHE_TTL_SECONDS=3600
   OPENAI_FILE_CONTENT_SIZE_LIMIT=16000
   OPENAI_TOTAL_FILES_LIMIT=8
   OPENAI_PROMPT_PREFIX="You are an expert code reviewer..."
   OPENAI_EMBEDDING_MODEL=text-embedding-3-small
   OPENAI_ENABLE_EMBEDDINGS=true
   OPENAI_VECTOR_DB_TOP_K=5
   ```

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
- **Environment Variables**: Ensure `.env` is not committed (it's already in `.gitignore`).
- **Webhook Verification**: The app verifies webhook signatures for security.
- **OpenAI Configuration**: Customize AI behavior via env vars (e.g., model selection, token limits, caching). Defaults are optimized for cost and performance.
- **Redis Cache**: `OPENAI_ENABLE_CACHE=true` now uses Redis instead of in-memory cache. Configure with either `REDIS_URL` or (`REDIS_HOST` + `REDIS_PORT` with optional `REDIS_USERNAME`/`REDIS_PASSWORD`). `OPENAI_CACHE_TTL_SECONDS` defaults to 3600. If Redis is unavailable, caching is automatically disabled and analysis still runs.
- **Embeddings & Vector DB**: Set `OPENAI_ENABLE_EMBEDDINGS=true` to enable embedding generation and Pinecone storage. Each analyzed file's embedding is stored under the key `pr-{prNumber}-{filename}`. On subsequent PRs, similar files from past PRs are retrieved and included in the AI prompt. The `OPENAI_VECTOR_DB_TOP_K` variable controls how many similar results are returned (default: 5).

## Development

- Run linter: `npm run lint`
- The project uses TypeScript with `ts-node-dev` for hot reloading.

## Contributing

As a student project, contributions are welcome! Open issues for bugs or feature requests, or submit pull requests.

## License

This project is licensed under the ISC License.
test
