ALTER TABLE public.manager_messages
  DROP CONSTRAINT IF EXISTS manager_messages_counterpart_kind_check;

ALTER TABLE public.manager_messages
  ADD CONSTRAINT manager_messages_counterpart_kind_check
  CHECK (counterpart_kind IN ('manager','player','group'));
