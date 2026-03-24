# Prism AI Reviewer

A GitHub webhook-based application that uses AI to automatically review pull requests.

## About

This project is built by a software engineering student exploring AI tools. It integrates with GitHub webhooks to receive PR events, fetches PR data via the GitHub API, and uses OpenAI's API to generate AI-powered code reviews.

## Features

- Receives GitHub webhook events for pull requests
- Authenticates using a GitHub App
- Fetches PR details, changed files, and existing reviews
- Integrates with OpenAI for AI analysis (placeholder for future implementation)
- Logs PR information for debugging and development

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

5. Create or update a pull request in the repository to trigger the webhook. Check the server logs for PR data processing.

## Configuration

- **GitHub App Setup**: Create an app in GitHub Developer settings. Set permissions for Pull requests (read/write) and Contents (read). Subscribe to "Pull request" events.
- **Environment Variables**: Ensure `.env` is not committed (it's already in `.gitignore`).
- **Webhook Verification**: The app verifies webhook signatures for security.

## Development

- Run linter: `npm run lint`
- The project uses TypeScript with `ts-node-dev` for hot reloading.

## Contributing

As a student project, contributions are welcome! Open issues for bugs or feature requests, or submit pull requests.

## License

This project is licensed under the ISC License.