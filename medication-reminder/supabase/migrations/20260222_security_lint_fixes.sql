-- Fix Supabase database linter warnings and errors
-- 1. Recreate SECURITY DEFINER views as SECURITY INVOKER (2 errors)
-- 2. Set search_path on 4 functions missing it (4 warnings)

-- ============================================================
-- 1. Fix SECURITY DEFINER views → SECURITY INVOKER
--    These views should respect the querying user's RLS policies
-- ============================================================

DROP VIEW IF EXISTS daily_adherence_summary;
CREATE VIEW daily_adherence_summary
WITH (security_invoker = true)
AS
SELECT
  p.id AS patient_id,
  p.name AS patient_name,
  m.id AS medication_id,
  m.name AS medication_name,
  m.dosage,
  m.reminder_time,
  cl.call_sid,
  cl.status AS call_status,
  cl.medication_taken,
  cl.patient_response,
  cl.duration_seconds,
  cl.created_at AS call_time,
  CASE
    WHEN cl.medication_taken = true THEN 'taken'
    WHEN cl.medication_taken = false THEN 'missed'
    WHEN cl.status IN ('initiated', 'answered') THEN 'pending'
    WHEN cl.status IN ('no_answer', 'failed', 'voicemail') THEN 'unreached'
    WHEN sc.status = 'pending' THEN 'scheduled'
    ELSE 'no_call'
  END AS adherence_status
FROM medications m
JOIN patients p ON p.id = m.patient_id
LEFT JOIN LATERAL (
  SELECT * FROM reminder_call_logs
  WHERE patient_id = p.id
    AND medication_id = m.id
    AND created_at::DATE = CURRENT_DATE
  ORDER BY created_at DESC
  LIMIT 1
) cl ON true
LEFT JOIN LATERAL (
  SELECT * FROM scheduled_reminder_calls
  WHERE patient_id = p.id
    AND medication_id = m.id
    AND scheduled_for::DATE = CURRENT_DATE
    AND status = 'pending'
  ORDER BY scheduled_for
  LIMIT 1
) sc ON cl.id IS NULL
WHERE m.is_active = true;

DROP VIEW IF EXISTS weekly_adherence_rate;
CREATE VIEW weekly_adherence_rate
WITH (security_invoker = true)
AS
SELECT
  p.id AS patient_id,
  p.name AS patient_name,
  DATE_TRUNC('week', cl.created_at)::DATE AS week_start,
  COUNT(*) FILTER (WHERE cl.medication_taken IS NOT NULL) AS total_calls,
  COUNT(*) FILTER (WHERE cl.medication_taken = true) AS taken_count,
  COUNT(*) FILTER (WHERE cl.medication_taken = false) AS missed_count,
  CASE
    WHEN COUNT(*) FILTER (WHERE cl.medication_taken IS NOT NULL) > 0
    THEN ROUND(
      100.0 * COUNT(*) FILTER (WHERE cl.medication_taken = true)
      / COUNT(*) FILTER (WHERE cl.medication_taken IS NOT NULL),
      1
    )
    ELSE 0
  END AS adherence_percentage
FROM patients p
JOIN reminder_call_logs cl ON cl.patient_id = p.id
WHERE cl.created_at >= NOW() - INTERVAL '12 weeks'
GROUP BY p.id, p.name, DATE_TRUNC('week', cl.created_at)::DATE
ORDER BY p.name, week_start DESC;

-- ============================================================
-- 2. Fix mutable search_path on functions
-- ============================================================

-- 2a. update_updated_at_column
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

-- 2b. get_consecutive_misses
CREATE OR REPLACE FUNCTION get_consecutive_misses(p_patient_id UUID)
RETURNS INTEGER AS $$
DECLARE
  miss_count INTEGER := 0;
  rec RECORD;
BEGIN
  FOR rec IN
    SELECT medication_taken
    FROM reminder_call_logs
    WHERE patient_id = p_patient_id
      AND medication_taken IS NOT NULL
    ORDER BY created_at DESC
    LIMIT 10
  LOOP
    IF rec.medication_taken = false THEN
      miss_count := miss_count + 1;
    ELSE
      EXIT;
    END IF;
  END LOOP;

  RETURN miss_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 2c. generate_daily_reminder_calls (latest version with bundling)
CREATE OR REPLACE FUNCTION generate_daily_reminder_calls()
RETURNS TABLE(patient_name TEXT, medication_count INT, scheduled_time TIMESTAMPTZ) AS $$
DECLARE
  rec RECORD;
  today_dow INT;
  call_time TIMESTAMPTZ;
  existing_count INT;
BEGIN
  today_dow := EXTRACT(ISODOW FROM NOW());

  CREATE TEMP TABLE IF NOT EXISTS _daily_meds (
    patient_id UUID,
    p_name TEXT,
    timezone TEXT,
    medication_id UUID,
    call_time TIMESTAMPTZ
  ) ON COMMIT DROP;

  DELETE FROM _daily_meds;

  FOR rec IN
    SELECT
      m.id AS medication_id,
      m.patient_id,
      m.reminder_time,
      p.name AS p_name,
      p.timezone
    FROM medications m
    JOIN patients p ON p.id = m.patient_id
    WHERE m.is_active = true
      AND today_dow = ANY(m.reminder_days)
  LOOP
    call_time := (
      (NOW() AT TIME ZONE rec.timezone)::DATE || ' ' || rec.reminder_time::TEXT
    )::TIMESTAMP AT TIME ZONE rec.timezone;

    SELECT COUNT(*) INTO existing_count
    FROM scheduled_reminder_calls
    WHERE patient_id = rec.patient_id
      AND (medication_id = rec.medication_id OR rec.medication_id = ANY(medication_ids))
      AND scheduled_for::DATE = call_time::DATE
      AND status IN ('pending', 'in_progress', 'completed');

    IF existing_count = 0 THEN
      INSERT INTO _daily_meds VALUES (rec.patient_id, rec.p_name, rec.timezone, rec.medication_id, call_time);
    END IF;
  END LOOP;

  FOR rec IN
    SELECT
      dm.patient_id,
      dm.p_name,
      MIN(dm.call_time) AS earliest_time,
      ARRAY_AGG(dm.medication_id) AS med_ids
    FROM _daily_meds dm
    GROUP BY dm.patient_id, dm.p_name,
      DATE_TRUNC('hour', dm.call_time) + INTERVAL '30 min' * FLOOR(EXTRACT(MINUTE FROM dm.call_time) / 30)
  LOOP
    INSERT INTO scheduled_reminder_calls (
      patient_id,
      medication_id,
      medication_ids,
      scheduled_for,
      attempt_number,
      status
    ) VALUES (
      rec.patient_id,
      rec.med_ids[1],
      rec.med_ids,
      rec.earliest_time,
      1,
      'pending'
    );

    patient_name := rec.p_name;
    medication_count := ARRAY_LENGTH(rec.med_ids, 1);
    scheduled_time := rec.earliest_time;
    RETURN NEXT;
  END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 2d. protect_stripe_columns
CREATE OR REPLACE FUNCTION protect_stripe_columns()
RETURNS TRIGGER AS $$
BEGIN
  IF current_setting('role', true) = 'service_role' THEN
    RETURN NEW;
  END IF;

  IF NEW.stripe_customer_id IS DISTINCT FROM OLD.stripe_customer_id THEN
    RAISE EXCEPTION 'Cannot modify stripe_customer_id';
  END IF;
  IF NEW.stripe_subscription_id IS DISTINCT FROM OLD.stripe_subscription_id THEN
    RAISE EXCEPTION 'Cannot modify stripe_subscription_id';
  END IF;
  IF NEW.subscription_status IS DISTINCT FROM OLD.subscription_status THEN
    RAISE EXCEPTION 'Cannot modify subscription_status';
  END IF;
  IF NEW.subscription_current_period_end IS DISTINCT FROM OLD.subscription_current_period_end THEN
    RAISE EXCEPTION 'Cannot modify subscription_current_period_end';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

-- 2e. grant_trial_credits (from previous migration, also needs search_path)
CREATE OR REPLACE FUNCTION grant_trial_credits()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO credit_balances (caregiver_id, balance_minutes, updated_at)
  VALUES (NEW.id, 15, now())
  ON CONFLICT (caregiver_id) DO NOTHING;

  INSERT INTO credit_purchases (
    caregiver_id, minutes_purchased, price_cents, pack_label, source
  ) VALUES (
    NEW.id, 15, 0, 'Free trial (15 min)', 'trial'
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
