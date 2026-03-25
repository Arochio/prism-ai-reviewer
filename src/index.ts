import dotenv from "dotenv";
dotenv.config();
console.log("Env loaded:", { OPENAI_API_KEY: process.env.OPENAI_API_KEY ? "set" : "not set" });

import express from "express";
import { handleWebhook } from "./controllers/webhookController";
import { openAIConfig } from "./config/openai.config";
const app = express();
const PORT = process.env.PORT || 3000;

//validate dotenv config on startup
const validateOpenAIConfig = () => {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required");
  }
  if (isNaN(openAIConfig.maxTokens) || openAIConfig.maxTokens <= 0) {
    throw new Error("OPENAI_MAX_TOKENS must be a positive integer");
  }
};

validateOpenAIConfig();

app.use(express.json());

app.get("/", (req, res) => {
  res.send("AI PR Reviewer is running");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

app.post("/webhook", handleWebhook);