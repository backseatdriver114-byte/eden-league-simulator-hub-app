CREATE TABLE public.league_versions (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  title text NOT NULL DEFAULT 'Untitled save',
  data jsonb NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.league_versions TO anon, authenticated;
GRANT ALL ON public.league_versions TO service_role;

ALTER TABLE public.league_versions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read league versions"
  ON public.league_versions FOR SELECT USING (true);
CREATE POLICY "Anyone can create league versions"
  ON public.league_versions FOR INSERT WITH CHECK (true);
CREATE POLICY "Anyone can delete league versions"
  ON public.league_versions FOR DELETE USING (true);