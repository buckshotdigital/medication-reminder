-- Stripe Billing Integration
-- Adds Stripe payment processing columns, add_credits() function,
-- auto-topup settings, and subscription fields

-- Step 1: Stripe columns on caregivers
ALTER TABLE caregivers ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;

-- Step 1: Stripe columns on credit_purchases
ALTER TABLE credit_purchases
  ADD COLUMN IF NOT EXISTS stripe_session_id TEXT,
  ADD COLUMN IF NOT EXISTS stripe_payment_intent_id TEXT;

-- Step 5: Subscription fields on caregivers
ALTER TABLE caregivers
  ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT,
  ADD COLUMN IF NOT EXISTS subscription_status TEXT DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS subscription_current_period_end TIMESTAMPTZ;

-- Atomic add_credits() function for webhook and manual provisioning
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
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Step 3: Auto-topup settings
CREATE TABLE IF NOT EXISTS auto_topup_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  caregiver_id UUID NOT NULL REFERENCES caregivers(id) ON DELETE CASCADE UNIQUE,
  enabled BOOLEAN NOT NULL DEFAULT false,
  threshold_minutes NUMERIC(10,2) NOT NULL DEFAULT 10,
  pack_minutes INTEGER NOT NULL DEFAULT 150,
  pack_price_cents INTEGER NOT NULL DEFAULT 2500,
  pack_label TEXT NOT NULL DEFAULT '150 minutes',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RLS for auto_topup_settings
ALTER TABLE auto_topup_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Caregivers manage their auto-topup settings"
  ON auto_topup_settings FOR ALL
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
