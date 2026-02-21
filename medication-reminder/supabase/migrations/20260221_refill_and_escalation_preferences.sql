-- Refill tracking + escalation preference defaults
-- ==============================================================

ALTER TABLE medications
  ADD COLUMN IF NOT EXISTS refill_remaining_doses INTEGER,
  ADD COLUMN IF NOT EXISTS refill_alert_threshold INTEGER DEFAULT 3,
  ADD COLUMN IF NOT EXISTS last_refill_date DATE;

ALTER TABLE medications
  DROP CONSTRAINT IF EXISTS medications_refill_remaining_doses_check;
ALTER TABLE medications
  ADD CONSTRAINT medications_refill_remaining_doses_check
  CHECK (refill_remaining_doses IS NULL OR refill_remaining_doses >= 0);

ALTER TABLE medications
  DROP CONSTRAINT IF EXISTS medications_refill_alert_threshold_check;
ALTER TABLE medications
  ADD CONSTRAINT medications_refill_alert_threshold_check
  CHECK (refill_alert_threshold IS NULL OR refill_alert_threshold >= 0);

-- Extend notification defaults with escalation threshold controls
ALTER TABLE caregivers
  ALTER COLUMN notification_prefs SET DEFAULT '{
    "sms_alerts": true,
    "escalation_calls": true,
    "first_sms_after_misses": 1,
    "all_sms_after_misses": 2,
    "call_after_misses": 3
  }'::JSONB;

-- Backfill existing rows where these keys are missing
UPDATE caregivers
SET notification_prefs = COALESCE(notification_prefs, '{}'::jsonb)
  || CASE WHEN COALESCE(notification_prefs ? 'first_sms_after_misses', false)
      THEN '{}'::jsonb ELSE '{"first_sms_after_misses":1}'::jsonb END
  || CASE WHEN COALESCE(notification_prefs ? 'all_sms_after_misses', false)
      THEN '{}'::jsonb ELSE '{"all_sms_after_misses":2}'::jsonb END
  || CASE WHEN COALESCE(notification_prefs ? 'call_after_misses', false)
      THEN '{}'::jsonb ELSE '{"call_after_misses":3}'::jsonb END
WHERE notification_prefs IS NULL
   OR NOT (notification_prefs ? 'first_sms_after_misses')
   OR NOT (notification_prefs ? 'all_sms_after_misses')
   OR NOT (notification_prefs ? 'call_after_misses');
