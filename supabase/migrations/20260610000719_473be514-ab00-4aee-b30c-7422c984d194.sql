CREATE TABLE public.league_state (
  id text PRIMARY KEY DEFAULT 'main',
  data jsonb NOT NULL,
  version bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.league_state TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.league_state TO authenticated;
GRANT ALL ON public.league_state TO service_role;

ALTER TABLE public.league_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read the shared league" ON public.league_state
  FOR SELECT USING (true);
CREATE POLICY "Anyone can insert the shared league" ON public.league_state
  FOR INSERT WITH CHECK (true);
CREATE POLICY "Anyone can update the shared league" ON public.league_state
  FOR UPDATE USING (true) WITH CHECK (true);

ALTER PUBLICATION supabase_realtime ADD TABLE public.league_state;