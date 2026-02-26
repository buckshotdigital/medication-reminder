-- Track whether user has read admin responses on their support tickets
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS response_read boolean NOT NULL DEFAULT false;

-- Allow users to update response_read on their own tickets
CREATE POLICY "Users can mark own tickets as read"
  ON support_tickets FOR UPDATE
  TO authenticated
  USING (
    caregiver_id = (
      SELECT id FROM caregivers WHERE auth_user_id = auth.uid() LIMIT 1
    )
  )
  WITH CHECK (
    caregiver_id = (
      SELECT id FROM caregivers WHERE auth_user_id = auth.uid() LIMIT 1
    )
  );
