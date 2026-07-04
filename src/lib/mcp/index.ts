import { defineMcp } from "@lovable.dev/mcp-js";
import getStandings from "./tools/get-standings";
import listTeams from "./tools/list-teams";
import getTeam from "./tools/get-team";
import getNews from "./tools/get-news";

export default defineMcp({
  name: "eden-league-mcp",
  title: "Eden League Data Hub",
  version: "0.1.0",
  instructions:
    "Read-only access to the Eden League simulation: standings, teams, rosters, managers, and recent newsroom / press-conference entries. Use `get_standings` for the current table, `list_teams` for a league overview, `get_team` for one club's roster and finances, and `get_recent_news` for beat-writer articles and press conferences.",
  tools: [getStandings, listTeams, getTeam, getNews],
});
