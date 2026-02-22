-- Per-Patient Max Call Duration
-- Replaces plan tiers (basic/companionship) with a simple per-patient setting.
-- All calls now deduct credits based on actual duration (no free seconds).

-- 1. Add max_call_duration_seconds column to patients
ALTER TABLE patients
  ADD COLUMN max_call_duration_seconds INTEGER NOT NULL DEFAULT 300;

-- 2. Migrate existing companionship plan patients to 30-minute max
UPDATE patients
SET max_call_duration_seconds = 1800
WHERE id IN (
  SELECT patient_id FROM patient_plans
  WHERE plan_id = 'companionship' AND is_active = true
);

-- 3. Deactivate all patient_plans rows (soft cleanup)
UPDATE patient_plans
SET is_active = false, ended_at = now()
WHERE is_active = true;

-- 4. Replace get_patient_plan() RPC to read from patients.max_call_duration_seconds
CREATE OR REPLACE FUNCTION get_patient_plan(p_patient_id UUID)
RETURNS TABLE (
  plan_id TEXT,
  plan_name TEXT,
  max_call_duration_seconds INTEGER,
  free_seconds_per_call INTEGER,
  caregiver_id UUID,
  balance_minutes NUMERIC
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    'credit'::TEXT AS plan_id,
    'Credit'::TEXT AS plan_name,
    p.max_call_duration_seconds,
    0 AS free_seconds_per_call,
    pc.caregiver_id,
    COALESCE(cb.balance_minutes, 0) AS balance_minutes
  FROM patients p
  JOIN patient_caregivers pc ON pc.patient_id = p.id
  LEFT JOIN credit_balances cb ON cb.caregiver_id = pc.caregiver_id
  WHERE p.id = p_patient_id
  LIMIT 1;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
