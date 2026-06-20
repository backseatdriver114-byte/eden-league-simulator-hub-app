// Cloud-backed version archive. Stores league snapshots (Team Editor data
// excluded) so the league can be reverted if the live Cloud row glitches.
import { supabase } from "@/integrations/supabase/client";
import type { VersionData } from "@/lib/league-export";

export interface LeagueVersion {
  id: string;
  title: string;
  created_at: string;
  data: VersionData;
}

export async function saveVersion(title: string, data: VersionData): Promise<void> {
  const { error } = await supabase
    .from("league_versions")
    .insert({ title: title.trim() || "Untitled save", data: data as unknown as Record<string, unknown> } as never);
  if (error) throw new Error(error.message);
}

export async function listVersions(): Promise<LeagueVersion[]> {
  const { data, error } = await supabase
    .from("league_versions")
    .select("id, title, created_at, data")
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as LeagueVersion[];
}

export async function deleteVersion(id: string): Promise<void> {
  const { error } = await supabase.from("league_versions").delete().eq("id", id);
  if (error) throw new Error(error.message);
}
