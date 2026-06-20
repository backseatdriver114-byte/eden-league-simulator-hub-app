CREATE TABLE public.manager_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_team text NOT NULL,
  counterpart_kind text NOT NULL CHECK (counterpart_kind IN ('manager','player')),
  counterpart_team text NOT NULL,
  counterpart_name text NOT NULL,
  role text NOT NULL CHECK (role IN ('user','ai')),
  content text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX manager_messages_thread_idx
  ON public.manager_messages (user_team, counterpart_kind, counterpart_team, counterpart_name, created_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.manager_messages TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.manager_messages TO authenticated;
GRANT ALL ON public.manager_messages TO service_role;

ALTER TABLE public.manager_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read manager messages"
  ON public.manager_messages FOR SELECT USING (true);
CREATE POLICY "Anyone can insert manager messages"
  ON public.manager_messages FOR INSERT WITH CHECK (true);
CREATE POLICY "Anyone can update manager messages"
  ON public.manager_messages FOR UPDATE USING (true) WITH CHECK (true);
CREATE POLICY "Anyone can delete manager messages"
  ON public.manager_messages FOR DELETE USING (true);