-- Trial Credits: Grant 15 free minutes to every new caregiver on signup
-- Uses a trigger on caregivers table so it works regardless of signup path

CREATE OR REPLACE FUNCTION grant_trial_credits()
RETURNS TRIGGER AS $$
BEGIN
  -- Seed credit balance with 15 free minutes
  INSERT INTO credit_balances (caregiver_id, balance_minutes, updated_at)
  VALUES (NEW.id, 15, now())
  ON CONFLICT (caregiver_id) DO NOTHING;

  -- Record in purchase history for audit trail
  INSERT INTO credit_purchases (
    caregiver_id, minutes_purchased, price_cents, pack_label, source
  ) VALUES (
    NEW.id, 15, 0, 'Free trial (15 min)', 'trial'
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Fire after a new caregiver row is inserted
CREATE TRIGGER trg_grant_trial_credits
  AFTER INSERT ON caregivers
  FOR EACH ROW
  EXECUTE FUNCTION grant_trial_credits();
