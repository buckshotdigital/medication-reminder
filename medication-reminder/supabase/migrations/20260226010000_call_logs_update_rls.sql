-- Allow caregivers to update call logs for their linked patients
-- Needed for stale call cleanup from the dashboard
DROP POLICY IF EXISTS "Caregivers update linked patient call logs" ON reminder_call_logs;
CREATE POLICY "Caregivers update linked patient call logs"
  ON reminder_call_logs FOR UPDATE
  USING (
    patient_id IN (
      SELECT patient_id FROM patient_caregivers
      WHERE caregiver_id = (
        SELECT id FROM caregivers WHERE auth_user_id = auth.uid()
      )
    )
  );
