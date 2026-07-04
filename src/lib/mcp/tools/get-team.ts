import { defineTool } from "@lovable.dev/mcp-js";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

const ROW_ID = "main";

export default defineTool({
  name: "get_team",
  title: "Get team details",
  description: "Return roster, manager, budget, payroll, and record for one team by name (case-insensitive).",
  inputSchema: {
    team: z.string().min(1).describe("Team name, e.g. 'Ashford FC'."),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ team }) => {
    const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await supabase.from("league_state").select("data").eq("id", ROW_ID).maybeSingle();
    if (error) return { content: [{ type: "text", text: error.message }], isError: true };
    const state = (data as { data?: Record<string, unknown> } | null)?.data ?? {};
    const teams = (state as { teams?: Record<string, unknown> }).teams ?? {};
    const key = Object.keys(teams).find((k) => k.toLowerCase() === team.toLowerCase());
    if (!key) return { content: [{ type: "text", text: `Team not found: ${team}` }], isError: true };
    const t = teams[key] as Record<string, unknown>;
    const managers = (state as { managers?: Record<string, unknown> }).managers ?? {};
    const summary = { team: key, manager: managers[key] ?? null, ...t };
    return {
      content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
      structuredContent: summary as Record<string, unknown>,
    };
  },
});
