// Mirrors settings.aiProvider from LeagueState to localStorage so the
// client-side function middleware (`attachAiProvider`) can attach the
// current hard-pin choice as `X-AI-Provider` on every serverFn RPC.
import { useEffect } from "react";
import { useLeague } from "@/state/league";
import { AI_PROVIDER_STORAGE_KEY } from "@/lib/ai-provider-attacher";

export function AiProviderSyncer() {
  const { state } = useLeague();
  const chosen = state.settings?.aiProvider ?? "auto";
  useEffect(() => {
    try {
      if (typeof window !== "undefined") {
        window.localStorage.setItem(AI_PROVIDER_STORAGE_KEY, chosen);
      }
    } catch { /* ignore */ }
  }, [chosen]);
  return null;
}
