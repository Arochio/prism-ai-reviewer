import { Request, Response } from "express";

export const handleWebhook = (req: Request, res: Response) => {
  console.log("Webhook received:", req.body.action);
  res.sendStatus(200);
};