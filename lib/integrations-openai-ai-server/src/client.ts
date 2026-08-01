import OpenAI from "openai";

// Lazy singleton — env vars are checked only on first use, not at import time.
// This allows the API server to start and serve non-AI endpoints (e.g. /youtube/meta)
// even when AI_INTEGRATIONS_OPENAI_* vars are not yet configured.

let _client: OpenAI | undefined;

function requireOpenAI(): OpenAI {
  if (!_client) {
    const baseURL = process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"];
    const apiKey = process.env["AI_INTEGRATIONS_OPENAI_API_KEY"];
    if (!baseURL) {
      throw new Error(
        "AI_INTEGRATIONS_OPENAI_BASE_URL must be set. Did you forget to provision the OpenAI AI integration?",
      );
    }
    if (!apiKey) {
      throw new Error(
        "AI_INTEGRATIONS_OPENAI_API_KEY must be set. Did you forget to provision the OpenAI AI integration?",
      );
    }
    _client = new OpenAI({ apiKey, baseURL });
  }
  return _client;
}

export const openai = new Proxy({} as OpenAI, {
  get(_target, prop, receiver) {
    return Reflect.get(requireOpenAI(), prop, receiver);
  },
});
