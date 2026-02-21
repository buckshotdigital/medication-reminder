-- Fix dispatch-pending-calls cron configuration
-- ==============================================================
-- Replaces fragile URL derivation with explicit Vault-backed secrets.
--
-- Required Vault secrets:
--   1) service_role_key
--   2) supabase_functions_base_url
--      e.g. https://<project-ref>.supabase.co/functions/v1
--
-- Example setup:
--   SELECT vault.create_secret('YOUR_SERVICE_ROLE_KEY', 'service_role_key');
--   SELECT vault.create_secret('https://YOUR_PROJECT.supabase.co/functions/v1', 'supabase_functions_base_url');

SELECT cron.unschedule('dispatch-pending-calls');

DO $$
DECLARE
  v_service_role_key TEXT;
  v_functions_base_url TEXT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_extension WHERE extname = 'supabase_vault'
  ) THEN
    RAISE WARNING 'supabase_vault extension not available. dispatch-pending-calls cron was unscheduled and must be recreated manually.';
    RETURN;
  END IF;

  SELECT decrypted_secret INTO v_service_role_key
  FROM vault.decrypted_secrets
  WHERE name = 'service_role_key'
  LIMIT 1;

  SELECT decrypted_secret INTO v_functions_base_url
  FROM vault.decrypted_secrets
  WHERE name = 'supabase_functions_base_url'
  LIMIT 1;

  IF v_service_role_key IS NULL OR v_functions_base_url IS NULL THEN
    RAISE WARNING 'Missing vault secret(s): service_role_key and/or supabase_functions_base_url. dispatch-pending-calls cron was unscheduled and must be recreated after secrets are set.';
    RETURN;
  END IF;

  PERFORM cron.schedule(
    'dispatch-pending-calls',
    '* * * * *',
    format(
      $cron$
      SELECT net.http_post(
        url := %L,
        headers := jsonb_build_object(
          'Authorization', 'Bearer ' || %L,
          'Content-Type', 'application/json'
        ),
        body := '{}'::jsonb
      )
      $cron$,
      rtrim(v_functions_base_url, '/') || '/schedule-reminder',
      v_service_role_key
    )
  );
END
$$;
