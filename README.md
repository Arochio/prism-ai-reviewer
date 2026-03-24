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

## Prerequisites

- Node.js (v18 or higher)
- npm
- A GitHub App with private key
- OpenAI API key
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
   # Optional OpenAI configs (defaults provided)
   OPENAI_MODEL=gpt-4o-mini
   OPENAI_MAX_TOKENS=1200
   OPENAI_TEMPERATURE=0.2
   OPENAI_BYPASS_LARGE_FILES=true
   OPENAI_ENABLE_CACHE=true
   OPENAI_FILE_CONTENT_SIZE_LIMIT=16000
   OPENAI_TOTAL_FILES_LIMIT=8
   OPENAI_PROMPT_PREFIX="You are an expert code reviewer..."
   ```

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

## Development

- Run linter: `npm run lint`
- The project uses TypeScript with `ts-node-dev` for hot reloading.

## Contributing

As a student project, contributions are welcome! Open issues for bugs or feature requests, or submit pull requests.

## License

This project is licensed under the ISC License.
