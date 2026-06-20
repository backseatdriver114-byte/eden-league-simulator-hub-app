
CREATE TABLE public.league_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  season integer NOT NULL,
  champion text,
  summary text NOT NULL DEFAULT '',
  standings jsonb NOT NULL DEFAULT '[]'::jsonb,
  leaderboards jsonb NOT NULL DEFAULT '{}'::jsonb,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE (season)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.league_history TO anon, authenticated;
GRANT ALL ON public.league_history TO service_role;

ALTER TABLE public.league_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read league history" ON public.league_history FOR SELECT USING (true);
CREATE POLICY "Anyone can insert league history" ON public.league_history FOR INSERT WITH CHECK (true);
CREATE POLICY "Anyone can update league history" ON public.league_history FOR UPDATE USING (true) WITH CHECK (true);
CREATE POLICY "Anyone can delete league history" ON public.league_history FOR DELETE USING (true);
