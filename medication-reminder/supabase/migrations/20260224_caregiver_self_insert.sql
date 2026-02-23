-- Allow authenticated users to insert their own caregiver record on first signup
-- Without this, RLS blocks the auth callback from creating the caregiver row

CREATE POLICY "Users can create own caregiver record"
  ON caregivers FOR INSERT
  WITH CHECK (auth_user_id = auth.uid());
