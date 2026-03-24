import express from "express";
import dotenv from "dotenv";
import { handleWebhook } from "./controllers/webhookController";

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get("/", (req, res) => {
  res.send("AI PR Reviewer is running");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

app.post("/webhook", handleWebhook);

//test
