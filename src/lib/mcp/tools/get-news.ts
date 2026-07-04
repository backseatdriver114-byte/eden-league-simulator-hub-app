import { defineTool } from "@lovable.dev/mcp-js";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

const ROW_ID = "main";

export default defineTool({
  name: "get_recent_news",
  title: "Get recent league news",
  description: "Return recent beat-writer articles and press-conference summaries from the league newsroom archive.",
  inputSchema: {
    limit: z.number().int().min(1).max(50).optional().describe("Max entries to return (default 10)."),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ limit }) => {
    const n = limit ?? 10;
    const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await supabase.from("league_state").select("data").eq("id", ROW_ID).maybeSingle();
    if (error) return { content: [{ type: "text", text: error.message }], isError: true };
    const state = (data as { data?: Record<string, unknown> } | null)?.data ?? {};
    const articles = ((state as { articleArchive?: unknown[] }).articleArchive ?? []).slice(-n).reverse();
    const press = ((state as { pressArchive?: unknown[] }).pressArchive ?? []).slice(-n).reverse();
    return {
      content: [{ type: "text", text: `Returning ${articles.length} articles and ${press.length} press entries.` }],
      structuredContent: { articles, pressConferences: press },
    };
  },
});
