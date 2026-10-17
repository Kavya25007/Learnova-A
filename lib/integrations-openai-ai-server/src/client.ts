import OpenAI from "openai";

// Lazy singleton — env vars are checked only on first use, not at import time.
// This allows the API server to start and serve non-AI endpoints (e.g. /youtube/meta)
// even when AI vars are not yet configured.
//
// Supports two modes:
//   1. Standard OpenAI:  set OPENAI_API_KEY=sk-...
//   2. Replit AI Proxy:  set AI_INTEGRATIONS_OPENAI_BASE_URL + AI_INTEGRATIONS_OPENAI_API_KEY

let _client: OpenAI | undefined;

function requireOpenAI(): OpenAI {
  if (!_client) {
    // Mode 1: Replit AI Integrations proxy (takes precedence when both vars are set)
    const replitBaseURL = process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"];
    const replitApiKey = process.env["AI_INTEGRATIONS_OPENAI_API_KEY"];

    // Mode 2: Standard OpenAI API key
    const openaiApiKey = process.env["OPENAI_API_KEY"];

    const geminiApiKey = process.env["GEMINI_API_KEY"];
    
    if (geminiApiKey) {
      _client = new OpenAI({
        apiKey: geminiApiKey,
        baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
      });
    } else if (replitBaseURL && replitApiKey) {
      // Replit managed AI proxy
      _client = new OpenAI({ apiKey: replitApiKey, baseURL: replitBaseURL });
    } else if (openaiApiKey) {
      // Standard OpenAI — no baseURL needed, uses api.openai.com by default
      _client = new OpenAI({ apiKey: openaiApiKey });
    } else {
      throw new Error(
        "OpenAI API key is not configured.\n" +
        "To enable AI note generation:\n" +
        "  1. Get an API key from https://platform.openai.com/api-keys\n" +
        "  2. Set the environment variable: OPENAI_API_KEY=sk-...\n" +
        "  3. Restart the server.\n" +
        "(YouTube processing and local file OCR work without this key.)",
      );
    }
  }
  return _client;
}

export const openai = new Proxy({} as OpenAI, {
  get(_target, prop, receiver) {
    return Reflect.get(requireOpenAI(), prop, receiver);
  },
});
