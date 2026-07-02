// League data export + version-snapshot helpers.
//
// PHILOSOPHY: "save everything". Rather than hand-listing which slices of
// LeagueState to snapshot, we serialize the WHOLE state (minus session-only
// undo/redo stacks). New league features automatically flow through the
// export/import/version-restore pipeline without any change to this file.
import type {
  LeagueState, StandingRow, Leaderboards, FixtureEntry,
} from "@/state/league";
import { supabase } from "@/integrations/supabase/client";

// ---------------- Generic browser download ----------------
export function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename.endsWith(".json") ? filename : `${filename}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function downloadText(filename: string, content: string, mime = "text/markdown") {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");

// ---------------- Private DM row shape ----------------
export interface ManagerMessageRow {
  user_team: string;
  counterpart_kind: string;
  counterpart_team: string;
  counterpart_name: string;
  role: string;
  content: string;
  created_at: string;
}

export async function fetchManagerMessages(): Promise<ManagerMessageRow[]> {
  const { data, error } = await supabase
    .from("manager_messages")
    .select("user_team, counterpart_kind, counterpart_team, counterpart_name, role, content, created_at")
    .order("created_at", { ascending: true });
  if (error) {
    console.warn("[export] failed to fetch manager_messages", error.message);
    return [];
  }
  return ((data as unknown) as ManagerMessageRow[]) ?? [];
}

export async function restoreManagerMessages(rows: ManagerMessageRow[]): Promise<void> {
  await supabase.from("manager_messages").delete().neq("user_team", "__none__");
  if (!rows.length) return;
  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK).map((r) => ({
      user_team: r.user_team,
      counterpart_kind: r.counterpart_kind,
      counterpart_team: r.counterpart_team,
      counterpart_name: r.counterpart_name,
      role: r.role,
      content: r.content,
      created_at: r.created_at,
    }));
    const { error } = await supabase.from("manager_messages").insert(slice as never);
    if (error) console.warn("[import] failed to restore manager_messages chunk", error.message);
  }
}

// ---------------- Full league export ("save everything") ----------------
// Serializes the ENTIRE LeagueState (minus undo/redo) plus Cloud-only DM
// history. Any new state slice is automatically included without editing
// this function.
export function buildLeagueExport(
  state: LeagueState,
  standings: StandingRow[],
  leaderboards: Leaderboards,
  messages: ManagerMessageRow[] = [],
) {
  // Strip session-only stacks; keep everything else verbatim.
  const { undoStack: _u, redoStack: _r, ...persistable } = state;
  void _u; void _r;
  return {
    exportedAt: new Date().toISOString(),
    kind: "eden-league-full-export",
    // Full state snapshot — the primary payload used on import.
    state: persistable,
    // Convenience mirrors of common fields at the top level for older tooling.
    season: state.season,
    currentWeek: state.currentWeek,
    // DM history (lives in Cloud, not in LeagueState).
    messages,
    // Derived views (not restored on import, useful for external readers).
    standings,
    goldenBoot: leaderboards.scorers,
    assistLeaders: leaderboards.assists,
    goldenGlove: leaderboards.keepers,
  };
}

export async function downloadLeagueExport(
  state: LeagueState,
  standings: StandingRow[],
  leaderboards: Leaderboards
) {
  const messages = await fetchManagerMessages();
  downloadJson(
    `eden-league-S${state.season}-W${state.currentWeek}-${stamp()}`,
    buildLeagueExport(state, standings, leaderboards, messages)
  );
}

// ---------------- Single-week export ----------------
export function buildWeekExport(state: LeagueState, week: number) {
  const weekFixtures = state.fixtures.filter((f) => f.week === week);
  const matches = weekFixtures.map((f: FixtureEntry) => ({
    fixtureId: f.id,
    week: f.week,
    home: f.home,
    away: f.away,
    result: state.results[f.id] ?? null,
    commentary: state.payloads[f.id]?.log ?? null,
    playerStats: state.payloads[f.id]?.players ?? null,
    goalkeeperStats: state.payloads[f.id]?.goalkeepers ?? null,
    injuries: state.payloads[f.id]?.injuries ?? null,
  }));
  return {
    exportedAt: new Date().toISOString(),
    kind: "eden-league-week-export",
    season: state.season,
    week,
    matches,
    teamEditorSnapshot: {
      teamOrder: state.teamOrder,
      teams: state.teams,
      salaryCap: state.salaryCap,
      freeAgents: state.freeAgents,
    },
  };
}

export function downloadWeekExport(state: LeagueState, week: number) {
  downloadJson(`eden-league-S${state.season}-week-${week}-${stamp()}`, buildWeekExport(state, week));
}

// ---------------- Version snapshots ----------------
// A saved version is now a FULL LeagueState snapshot (minus undo/redo).
// Reverting restores the entire league exactly as it was.
export type VersionData = Omit<LeagueState, "undoStack" | "redoStack">;

export function extractVersionData(state: LeagueState): VersionData {
  const { undoStack: _u, redoStack: _r, ...rest } = state;
  void _u; void _r;
  return rest;
}
