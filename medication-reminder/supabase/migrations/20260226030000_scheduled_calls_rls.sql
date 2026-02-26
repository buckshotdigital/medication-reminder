-- Allow caregivers to INSERT scheduled calls for their linked patients
CREATE POLICY "Caregivers insert scheduled calls for linked patients"
  ON scheduled_reminder_calls FOR INSERT
  WITH CHECK (
    patient_id IN (
      SELECT patient_id FROM patient_caregivers
      WHERE caregiver_id = (
        SELECT id FROM caregivers WHERE auth_user_id = auth.uid()
      )
    )
  );

-- Allow caregivers to DELETE scheduled calls for their linked patients
CREATE POLICY "Caregivers delete scheduled calls for linked patients"
  ON scheduled_reminder_calls FOR DELETE
  USING (
    patient_id IN (
      SELECT patient_id FROM patient_caregivers
      WHERE caregiver_id = (
        SELECT id FROM caregivers WHERE auth_user_id = auth.uid()
      )
    )
  );
