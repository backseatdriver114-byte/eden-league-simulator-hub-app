// Team branding: default logo assets + default color palette per team.
// Overrides live on LeagueTeam (logo, colors); helpers below prefer overrides
// then fall back to these defaults keyed by team name.

import spams from "@/assets/team-logos/spams.png.asset.json";
import guguTeam from "@/assets/team-logos/gugu-team.png.asset.json";
import vegAndFruits from "@/assets/team-logos/vegetables-and-fruits.png.asset.json";
import kookch from "@/assets/team-logos/kookch-united.png.asset.json";
import cocos from "@/assets/team-logos/cocos.png.asset.json";
import nicoland from "@/assets/team-logos/nicoland-republic.png.asset.json";
import dangerous from "@/assets/team-logos/dangerous-journeys.png.asset.json";
import socks from "@/assets/team-logos/socks.png.asset.json";
import brownies from "@/assets/team-logos/brownies.png.asset.json";
import egypts from "@/assets/team-logos/egypts.png.asset.json";
import grogles from "@/assets/team-logos/grogles-fc.png.asset.json";
import fish from "@/assets/team-logos/fish.png.asset.json";
import chokiChoki from "@/assets/team-logos/choki-choki-baba.png.asset.json";
import lights from "@/assets/team-logos/lights.png.asset.json";
import eut2 from "@/assets/team-logos/eden-ultimate-team-2.png.asset.json";
import creams from "@/assets/team-logos/creams.png.asset.json";
import wondo from "@/assets/team-logos/wondo-condo.png.asset.json";
import vipers from "@/assets/team-logos/vipers.png.asset.json";
import edeks from "@/assets/team-logos/edeks.png.asset.json";
import scoops from "@/assets/team-logos/scoops.png.asset.json";
import grampatomnon from "@/assets/team-logos/grampatomnon.png.asset.json";
import shocShoc from "@/assets/team-logos/shoc-shoc.png.asset.json";
import isaiahs from "@/assets/team-logos/isaiahs.png.asset.json";
import edenaks from "@/assets/team-logos/edenaks.png.asset.json";

import type { LeagueTeam } from "@/state/league";

export interface TeamColors {
  primary?: string | null;
  secondary?: string | null;
  tertiary?: string | null;
}

interface BrandSeed { logo: string; colors: TeamColors; }

// Normalize a team name for lookup (case + punctuation insensitive) so
// "Edenak's" matches "Edenaks", extra spaces don't matter, etc.
function norm(n: string): string {
  return n.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

const SEED_RAW: Record<string, BrandSeed> = {
  "Spams":                  { logo: spams.url,        colors: { primary: "#0080FF", secondary: "#FAFC00" } },
  "Gugu Team":              { logo: guguTeam.url,     colors: { primary: "#FA0000", secondary: "#FFFFFF" } },
  "Vegetables and Fruits":  { logo: vegAndFruits.url, colors: { primary: "#A80000", secondary: "#005C00" } },
  "Kookch United":          { logo: kookch.url,       colors: { primary: "#5800DB", secondary: "#A66BFF" } },
  "Cocos":                  { logo: cocos.url,        colors: { primary: "#00DB00", secondary: "#DBDB00" } },
  "Nicoland Republic":      { logo: nicoland.url,     colors: { primary: "#FF880F", secondary: "#FFFFFF" } },
  "Dangerous Journeys":     { logo: dangerous.url,    colors: { primary: "#5C0000", secondary: "#A80000" } },
  "Socks":                  { logo: socks.url,        colors: { primary: "#00A300", secondary: "#FFFF00", tertiary: "#003161" } },
  "Brownies":               { logo: brownies.url,     colors: { primary: "#5C2E00", secondary: "#000000" } },
  "Egypts":                 { logo: egypts.url,       colors: { primary: "#FF880F", secondary: "#FFD4A8" } },
  "Grogles FC":             { logo: grogles.url,      colors: { primary: "#5800DB", secondary: "#000000" } },
  "Fish":                   { logo: fish.url,         colors: { primary: "#6BB5FF", secondary: "#66FFA3" } },
  "Choki Choki Baba":       { logo: chokiChoki.url,   colors: { primary: "#999999", secondary: "#FAFA00", tertiary: "#FF3D3D" } },
  "Lights":                 { logo: lights.url,       colors: { primary: "#FFFF66", secondary: "#FFFFFF" } },
  "Eden Ultimate Team 2":   { logo: eut2.url,         colors: { primary: "#FA0000", secondary: "#FAFA00", tertiary: "#00DB00" } },
  "Creams":                 { logo: creams.url,       colors: { primary: "#FFD4A8", secondary: "#6BB5FF", tertiary: "#FFFFFF" } },
  "Wondo Condo":            { logo: wondo.url,        colors: { primary: "#FA0000", secondary: "#0000FA" } },
  "Vipers":                 { logo: vipers.url,       colors: { primary: "#00FA00", secondary: "#5800DB", tertiary: "#DBDB00" } },
  "Edeks":                  { logo: edeks.url,        colors: { primary: "#A80000", secondary: "#000000", tertiary: "#FFFFFF" } },
  "Scoops":                 { logo: scoops.url,       colors: { primary: "#FFFFFF", secondary: "#0000A8", tertiary: "#FFD4A8" } },
  "Grampatomnon":           { logo: grampatomnon.url, colors: { primary: "#0054A8", secondary: "#828282" } },
  "Shoc Shoc":              { logo: shocShoc.url,     colors: { primary: "#00FA00" } },
  "Isaiahs":                { logo: isaiahs.url,      colors: { primary: "#389CFF", secondary: "#FFFFFF" } },
  "Edenaks":                { logo: edenaks.url,      colors: { primary: "#DBDB00", secondary: "#00A300" } },
};

const SEED_BY_NORM: Record<string, BrandSeed> = Object.fromEntries(
  Object.entries(SEED_RAW).map(([k, v]) => [norm(k), v]),
);

export function defaultBrandFor(teamName: string): BrandSeed | undefined {
  return SEED_BY_NORM[norm(teamName)];
}

// Prefer per-team override on LeagueTeam; fall back to seed.
export function getTeamLogo(team: Pick<LeagueTeam, "name" | "logo"> | undefined | null): string | undefined {
  if (!team) return undefined;
  if (team.logo && team.logo.trim()) return team.logo;
  return defaultBrandFor(team.name)?.logo;
}

export function getTeamColors(team: Pick<LeagueTeam, "name" | "colors"> | undefined | null): TeamColors {
  const seed = team ? defaultBrandFor(team.name)?.colors : undefined;
  const over = team?.colors ?? undefined;
  return {
    primary:   over?.primary   ?? seed?.primary   ?? null,
    secondary: over?.secondary ?? seed?.secondary ?? null,
    tertiary:  over?.tertiary  ?? seed?.tertiary  ?? null,
  };
}

// Parse a hex string; treat blank / "NONE" (any case) as null.
export function normalizeHex(input: string): string | null {
  const raw = (input ?? "").trim();
  if (!raw) return null;
  if (raw.toUpperCase() === "NONE") return null;
  const bare = raw.startsWith("#") ? raw.slice(1) : raw;
  if (!/^[0-9a-fA-F]{6}$/.test(bare) && !/^[0-9a-fA-F]{3}$/.test(bare)) return null;
  return `#${bare.toUpperCase()}`;
}

export function hexOrNoneDisplay(v: string | null | undefined): string {
  return v && v.trim() ? v.toUpperCase() : "NONE";
}
