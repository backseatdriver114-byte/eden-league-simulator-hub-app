// Client-side function middleware that attaches the user's chosen AI
// provider to every serverFn RPC as `X-AI-Provider`. Server-side
// `chatCompletion` reads it to hard-pin (or defaults to auto-fallback).
//
// The selection lives in localStorage (mirrored from LeagueState.settings.aiProvider
// by AiProviderSyncer) so this middleware can read it synchronously without
// touching React state.
import { createMiddleware } from "@tanstack/react-start";

export const AI_PROVIDER_STORAGE_KEY = "eden_ai_provider";

export const attachAiProvider = createMiddleware({ type: "function" }).client(
  async ({ next }) => {
    let name = "";
    try {
      if (typeof window !== "undefined") {
        name = (window.localStorage.getItem(AI_PROVIDER_STORAGE_KEY) ?? "").trim();
      }
    } catch { /* ignore */ }
    return next({
      headers: name && name !== "auto" ? { "X-AI-Provider": name } : {},
    });
  },
);
