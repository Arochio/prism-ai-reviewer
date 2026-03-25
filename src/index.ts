import dotenv from "dotenv";
// Loads environment variables before any service initialization.
dotenv.config();

import express from "express";
import { handleWebhook } from "./controllers/webhookController";
import { openAIConfig } from "./config/openai.config";
import { logger } from "./services/logger";
const app = express();
const PORT = process.env.PORT || 3000;

// Validates required OpenAI configuration at application startup.
const validateOpenAIConfig = () => {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required");
  }
  if (isNaN(openAIConfig.maxTokens) || openAIConfig.maxTokens <= 0) {
    throw new Error("OPENAI_MAX_TOKENS must be a positive integer");
  }
};

validateOpenAIConfig();

// Parses incoming webhook JSON payloads.
app.use(express.json());

app.get("/", (req, res) => {
  res.send("AI PR Reviewer is running");
});

app.listen(PORT, () => {
  logger.info({ port: PORT }, "Server running");
});

// GitHub webhook endpoint.
app.post("/webhook", handleWebhook);