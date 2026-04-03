import { openAIConfig } from "./openai.config";
import type { OpenAIConfig } from "./openai.config";
import type { Installation } from "../db/schema";

// Keys in installations.settings that can override the global OpenAI config
// Only a safe, explicitly allow-listed subset of fields is honoured
const ALLOWED_OVERRIDES: ReadonlyArray<keyof OpenAIConfig> = [
  "model",
  "maxTokens",
  "temperature",
  "repoContextFileLimit",
  "repoContextSizeLimit",
  "fileContentSizeLimit",
  "totalFilesLimit",
];

// Returns the effective OpenAI config for a tenant
//
// Falls back to the global `openAIConfig` when:
// - The installation row is null (no DB / not yet stored)
// - The `settings` column is empty ({})
//
// This is the single place to add future per-tenant customizations such as
// BYOK (bring-your-own-key), custom model selection, or increased token limits
export const resolveTenantConfig = (installation: Installation | null): OpenAIConfig => {
  if (!installation?.settings) return openAIConfig;

  const settings = installation.settings as Record<string, unknown>;
  if (Object.keys(settings).length === 0) return openAIConfig;

  const overrides: Partial<OpenAIConfig> = {};
  for (const key of ALLOWED_OVERRIDES) {
    if (key in settings) {
      // Type narrowing: only copy values whose runtime type matches the default
      const defaultVal = openAIConfig[key];
      const incoming = settings[key];
      if (typeof incoming === typeof defaultVal) {
        (overrides as Record<string, unknown>)[key] = incoming;
      }
    }
  }

  if (Object.keys(overrides).length === 0) return openAIConfig;
  return { ...openAIConfig, ...overrides };
};
