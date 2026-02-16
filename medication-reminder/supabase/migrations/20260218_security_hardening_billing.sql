-- Security Hardening for Billing System
-- Fixes: RPC access control, RLS policies, input validation, Stripe column protection

-- ============================================================
-- 1. REVOKE public access to billing RPC functions
--    Only service_role (edge functions) should call these
-- ============================================================

REVOKE EXECUTE ON FUNCTION add_credits FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION add_credits TO service_role;

REVOKE EXECUTE ON FUNCTION deduct_credits FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION deduct_credits TO service_role;

REVOKE EXECUTE ON FUNCTION get_patient_plan FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION get_patient_plan TO service_role;

-- ============================================================
-- 2. Fix credit_balances RLS: SELECT only (no client writes)
--    All balance mutations go through SECURITY DEFINER functions
-- ============================================================

DROP POLICY IF EXISTS "Caregivers view their credit balance" ON credit_balances;

CREATE POLICY "Caregivers view their credit balance"
  ON credit_balances FOR SELECT
  USING (
    caregiver_id IN (
      SELECT id FROM caregivers WHERE auth_user_id = auth.uid()
    )
  );

-- ============================================================
-- 3. Enable RLS on plans table (prevent client modification)
-- ============================================================

ALTER TABLE plans ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Plans are readable by everyone"
  ON plans FOR SELECT
  USING (true);

-- ============================================================
-- 4. Restrict auto_topup_settings to safe columns
--    Only enabled + threshold should be freely editable
--    Pack values must match allowed packs
-- ============================================================

DROP POLICY IF EXISTS "Caregivers manage their auto-topup settings" ON auto_topup_settings;

-- Allow SELECT for all own settings
CREATE POLICY "Caregivers view their auto-topup settings"
  ON auto_topup_settings FOR SELECT
  USING (
    caregiver_id IN (
      SELECT id FROM caregivers WHERE auth_user_id = auth.uid()
    )
  );

-- Allow INSERT/UPDATE but validate pack values via CHECK constraint
CREATE POLICY "Caregivers manage their auto-topup settings"
  ON auto_topup_settings FOR INSERT
  WITH CHECK (
    caregiver_id IN (
      SELECT id FROM caregivers WHERE auth_user_id = auth.uid()
    )
  );

CREATE POLICY "Caregivers update their auto-topup settings"
  ON auto_topup_settings FOR UPDATE
  USING (
    caregiver_id IN (
      SELECT id FROM caregivers WHERE auth_user_id = auth.uid()
    )
  )
  WITH CHECK (
    caregiver_id IN (
      SELECT id FROM caregivers WHERE auth_user_id = auth.uid()
    )
  );

-- Add CHECK constraint to only allow valid pack combinations
ALTER TABLE auto_topup_settings DROP CONSTRAINT IF EXISTS valid_topup_pack;
ALTER TABLE auto_topup_settings ADD CONSTRAINT valid_topup_pack
  CHECK (
    (pack_minutes = 60 AND pack_price_cents = 1200)
    OR (pack_minutes = 150 AND pack_price_cents = 2500)
    OR (pack_minutes = 500 AND pack_price_cents = 7000)
  );

-- ============================================================
-- 5. Protect Stripe columns on caregivers from client writes
--    Uses a trigger to prevent direct modification
-- ============================================================

CREATE OR REPLACE FUNCTION protect_stripe_columns()
RETURNS TRIGGER AS $$
BEGIN
  -- Allow service_role to modify anything
  IF current_setting('role', true) = 'service_role' THEN
    RETURN NEW;
  END IF;

  -- For non-service-role users, prevent Stripe column modification
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
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS protect_caregiver_stripe_columns ON caregivers;
CREATE TRIGGER protect_caregiver_stripe_columns
  BEFORE UPDATE ON caregivers
  FOR EACH ROW
  EXECUTE FUNCTION protect_stripe_columns();

-- ============================================================
-- 6. Add input validation to add_credits()
-- ============================================================

CREATE OR REPLACE FUNCTION add_credits(
  p_caregiver_id UUID,
  p_minutes NUMERIC,
  p_price_cents INTEGER,
  p_pack_label TEXT,
  p_source TEXT DEFAULT 'stripe',
  p_stripe_session_id TEXT DEFAULT NULL,
  p_stripe_payment_intent_id TEXT DEFAULT NULL
) RETURNS NUMERIC AS $$
DECLARE
  v_new_balance NUMERIC(10, 2);
BEGIN
  -- Input validation
  IF p_minutes <= 0 THEN
    RAISE EXCEPTION 'minutes must be positive';
  END IF;
  IF p_price_cents < 0 THEN
    RAISE EXCEPTION 'price_cents cannot be negative';
  END IF;

  -- Upsert credit_balances (increment balance)
  INSERT INTO credit_balances (caregiver_id, balance_minutes, updated_at)
  VALUES (p_caregiver_id, p_minutes, now())
  ON CONFLICT (caregiver_id)
  DO UPDATE SET
    balance_minutes = credit_balances.balance_minutes + p_minutes,
    updated_at = now();

  -- Get new balance
  SELECT balance_minutes INTO v_new_balance
  FROM credit_balances
  WHERE caregiver_id = p_caregiver_id;

  -- Insert audit trail
  INSERT INTO credit_purchases (
    caregiver_id, minutes_purchased, price_cents, pack_label,
    source, stripe_session_id, stripe_payment_intent_id
  ) VALUES (
    p_caregiver_id, p_minutes, p_price_cents, p_pack_label,
    p_source, p_stripe_session_id, p_stripe_payment_intent_id
  );

  RETURN v_new_balance;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Re-apply the REVOKE after replacing the function
REVOKE EXECUTE ON FUNCTION add_credits FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION add_credits TO service_role;

-- ============================================================
-- 7. Add input validation + search_path to deduct_credits()
-- ============================================================

CREATE OR REPLACE FUNCTION deduct_credits(
  p_caregiver_id UUID,
  p_patient_id UUID,
  p_call_log_id UUID,
  p_call_sid TEXT,
  p_total_duration_seconds INTEGER,
  p_free_seconds INTEGER
) RETURNS TABLE (
  minutes_deducted NUMERIC,
  balance_after NUMERIC
) AS $$
DECLARE
  v_billable_seconds INTEGER;
  v_minutes_to_deduct NUMERIC(10, 2);
  v_balance_before NUMERIC(10, 2);
  v_balance_after NUMERIC(10, 2);
BEGIN
  -- Input validation
  IF p_total_duration_seconds < 0 THEN
    RAISE EXCEPTION 'total_duration_seconds cannot be negative';
  END IF;
  IF p_free_seconds < 0 THEN
    RAISE EXCEPTION 'free_seconds cannot be negative';
  END IF;

  -- Calculate billable seconds (total minus free, minimum 0)
  v_billable_seconds := GREATEST(0, p_total_duration_seconds - p_free_seconds);

  -- If no billable seconds, nothing to deduct
  IF v_billable_seconds = 0 THEN
    SELECT COALESCE(cb.balance_minutes, 0) INTO v_balance_before
    FROM credit_balances cb WHERE cb.caregiver_id = p_caregiver_id;
    v_balance_before := COALESCE(v_balance_before, 0);

    INSERT INTO credit_usage (
      caregiver_id, patient_id, call_log_id, call_sid,
      total_duration_seconds, free_seconds, billable_seconds,
      minutes_deducted, balance_before, balance_after
    ) VALUES (
      p_caregiver_id, p_patient_id, p_call_log_id, p_call_sid,
      p_total_duration_seconds, p_free_seconds, 0,
      0, v_balance_before, v_balance_before
    );

    RETURN QUERY SELECT 0::NUMERIC, v_balance_before;
    RETURN;
  END IF;

  -- Round up to nearest minute
  v_minutes_to_deduct := CEIL(v_billable_seconds::NUMERIC / 60);

  -- Lock the balance row and read current balance
  SELECT cb.balance_minutes INTO v_balance_before
  FROM credit_balances cb
  WHERE cb.caregiver_id = p_caregiver_id
  FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO credit_balances (caregiver_id, balance_minutes)
    VALUES (p_caregiver_id, 0);
    v_balance_before := 0;
  END IF;

  -- Deduct (floor at 0)
  v_balance_after := GREATEST(0, v_balance_before - v_minutes_to_deduct);

  UPDATE credit_balances
  SET balance_minutes = v_balance_after, updated_at = now()
  WHERE caregiver_id = p_caregiver_id;

  -- Record usage
  INSERT INTO credit_usage (
    caregiver_id, patient_id, call_log_id, call_sid,
    total_duration_seconds, free_seconds, billable_seconds,
    minutes_deducted, balance_before, balance_after
  ) VALUES (
    p_caregiver_id, p_patient_id, p_call_log_id, p_call_sid,
    p_total_duration_seconds, p_free_seconds, v_billable_seconds,
    v_minutes_to_deduct, v_balance_before, v_balance_after
  );

  RETURN QUERY SELECT v_minutes_to_deduct, v_balance_after;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Re-apply the REVOKE after replacing the function
REVOKE EXECUTE ON FUNCTION deduct_credits FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION deduct_credits TO service_role;

-- ============================================================
-- 8. Add search_path to get_patient_plan()
-- ============================================================

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
    p.id AS plan_id,
    p.name AS plan_name,
    p.max_call_duration_seconds,
    p.free_seconds_per_call,
    pp.caregiver_id,
    COALESCE(cb.balance_minutes, 0) AS balance_minutes
  FROM patient_plans pp
  JOIN plans p ON p.id = pp.plan_id
  LEFT JOIN credit_balances cb ON cb.caregiver_id = pp.caregiver_id
  WHERE pp.patient_id = p_patient_id
    AND pp.is_active = true
  LIMIT 1;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Re-apply the REVOKE after replacing the function
REVOKE EXECUTE ON FUNCTION get_patient_plan FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION get_patient_plan TO service_role;

-- ============================================================
-- 9. Add UNIQUE index on stripe_session_id for idempotency
-- ============================================================

CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_purchases_stripe_session
  ON credit_purchases(stripe_session_id)
  WHERE stripe_session_id IS NOT NULL;
