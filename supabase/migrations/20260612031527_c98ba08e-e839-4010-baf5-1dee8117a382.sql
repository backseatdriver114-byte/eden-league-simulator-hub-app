UPDATE public.league_state
SET data = jsonb_set(data, '{salaryCap}', '140'::jsonb),
    version = version + 1,
    updated_at = now()
WHERE id = 'main';