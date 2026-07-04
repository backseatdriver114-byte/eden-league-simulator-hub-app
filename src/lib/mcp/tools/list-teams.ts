import { defineTool } from "@lovable.dev/mcp-js";
import { createClient } from "@supabase/supabase-js";

const ROW_ID = "main";

export default defineTool({
  name: "list_teams",
  title: "List teams",
  description: "List every team in the Eden League with roster size, average rating, and manager name.",
  inputSchema: {},
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async () => {
    const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await supabase.from("league_state").select("data").eq("id", ROW_ID).maybeSingle();
    if (error) return { content: [{ type: "text", text: error.message }], isError: true };
    const state = (data as { data?: Record<string, unknown> } | null)?.data ?? {};
    const teams = (state as { teams?: Record<string, { players?: Array<{ rating?: number }> }>; managers?: Record<string, { name?: string }> }).teams ?? {};
    const managers = (state as { managers?: Record<string, { name?: string }> }).managers ?? {};
    const rows = Object.entries(teams).map(([name, t]) => {
      const players = t.players ?? [];
      const avg = players.length ? players.reduce((s, p) => s + (p.rating ?? 0), 0) / players.length : 0;
      return { team: name, roster: players.length, avgRating: Math.round(avg * 10) / 10, manager: managers[name]?.name ?? "Unknown" };
    }).sort((a, b) => a.team.localeCompare(b.team));
    const text = rows.map((r) => `${r.team} — mgr ${r.manager}, ${r.roster} players, avg OVR ${r.avgRating}`).join("\n");
    return { content: [{ type: "text", text: text || "No teams found." }], structuredContent: { teams: rows } };
  },
});
