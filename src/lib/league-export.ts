// League data export + version-snapshot helpers.
// Exports produce downloadable JSON; version snapshots capture all league data
// EXCEPT Team Editor data (rosters, budgets, formations/lineups, player attrs).
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

// Generic browser download for plain text / markdown content.
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
// Mirrors the `manager_messages` Supabase table. Included in the full export so
// async messaging history (DMs with AI managers and own players) survives a
// re-import / cross-project copy.
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

// Wipe the manager_messages table and re-insert the rows from an import.
// Called after a successful league import so DM history matches the snapshot.
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

// ---------------- Full league export ----------------
// Everything in LeagueState plus the Cloud-only DM history.
export function buildLeagueExport(
  state: LeagueState,
  standings: StandingRow[],
  leaderboards: Leaderboards,
  messages: ManagerMessageRow[] = [],
) {
  return {
    exportedAt: new Date().toISOString(),
    kind: "eden-league-full-export",
    season: state.season,
    currentWeek: state.currentWeek,
    salaryCap: state.salaryCap,
    teamOrder: state.teamOrder,
    teams: state.teams,
    fixtures: state.fixtures,
    results: state.results,
    matchCommentary: state.payloads,
    playoffs: state.playoffs ?? null,
    tradeProposals: state.tradeProposals,
    freeAgents: state.freeAgents,
    contractsInitialized: state.contractsInitialized,
    // --- newer state slices (managers + respect/harshness, relations,
    //     editable engine settings, draft picks & live draft) ---
    managers: state.managers,
    relations: state.relations ?? {},
    settings: state.settings ?? null,
    draftPicks: state.draftPicks,
    draft: state.draft ?? null,
    // --- DM history (lives in Cloud, not in LeagueState) ---
    messages,
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
// Results + match commentary for one week, plus a snapshot of all current
// Team Editor data (rosters/budgets/lineups) at the moment of export.
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

// ---------------- Version snapshots (Team Editor data EXCLUDED) ----------------
export interface VersionData {
  currentWeek: number;
  season: number;
  fixtures: LeagueState["fixtures"];
  results: LeagueState["results"];
  payloads: LeagueState["payloads"];
  playoffs: LeagueState["playoffs"];
  tradeProposals: LeagueState["tradeProposals"];
  freeAgents: LeagueState["freeAgents"];
  contractsInitialized: boolean;
  // NOTE: salaryCap is an app setting (Settings suite), NOT league data, so it
  // is intentionally excluded from snapshots — reverting never changes it.
}

export function extractVersionData(state: LeagueState): VersionData {
  return {
    currentWeek: state.currentWeek,
    season: state.season,
    fixtures: state.fixtures,
    results: state.results,
    payloads: state.payloads,
    playoffs: state.playoffs,
    tradeProposals: state.tradeProposals,
    freeAgents: state.freeAgents,
    contractsInitialized: state.contractsInitialized,
  };
}
