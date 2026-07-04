import { defineTool } from "@lovable.dev/mcp-js";
import { createClient } from "@supabase/supabase-js";


const ROW_ID = "main";

function client() {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export default defineTool({
  name: "get_standings",
  title: "Get league standings",
  description:
    "Return the current Eden League standings (team, W-L-D, points, goal diff) sorted from first to last.",
  inputSchema: {},
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async () => {
    const { data, error } = await client()
      .from("league_state")
      .select("data")
      .eq("id", ROW_ID)
      .maybeSingle();
    if (error) return { content: [{ type: "text", text: error.message }], isError: true };
    const state = (data as { data?: Record<string, unknown> } | null)?.data ?? {};
    const teams = (state as { teams?: Record<string, { record?: { wins?: number; losses?: number; draws?: number; goalsFor?: number; goalsAgainst?: number; points?: number } }> }).teams ?? {};
    const rows = Object.entries(teams).map(([name, t]) => {
      const r = t.record ?? {};
      const w = r.wins ?? 0, l = r.losses ?? 0, d = r.draws ?? 0;
      const gf = r.goalsFor ?? 0, ga = r.goalsAgainst ?? 0;
      return { team: name, wins: w, losses: l, draws: d, points: r.points ?? w * 3 + d, goalDiff: gf - ga, gf, ga };
    }).sort((a, b) => b.points - a.points || b.goalDiff - a.goalDiff);
    const text = rows.map((r, i) => `${i + 1}. ${r.team} — ${r.wins}-${r.losses}-${r.draws}, ${r.points} pts, GD ${r.goalDiff > 0 ? "+" : ""}${r.goalDiff}`).join("\n");
    return { content: [{ type: "text", text: text || "No standings available." }], structuredContent: { standings: rows } };
  },
});
