-- Add is_admin column to caregivers
ALTER TABLE caregivers ADD COLUMN IF NOT EXISTS is_admin boolean NOT NULL DEFAULT false;

-- Set admin for vik.j17@gmail.com
UPDATE caregivers SET is_admin = true WHERE email = 'vik.j17@gmail.com';

-- Create support_tickets table
CREATE TABLE support_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  caregiver_id uuid NOT NULL REFERENCES caregivers(id) ON DELETE CASCADE,
  email text,
  subject text NOT NULL,
  message text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- RLS
ALTER TABLE support_tickets ENABLE ROW LEVEL SECURITY;

-- Authenticated users can insert their own tickets
CREATE POLICY "Users can insert own tickets"
  ON support_tickets FOR INSERT
  TO authenticated
  WITH CHECK (
    caregiver_id = (
      SELECT id FROM caregivers WHERE auth_user_id = auth.uid() LIMIT 1
    )
  );

-- Admin users can read all tickets
CREATE POLICY "Admins can read all tickets"
  ON support_tickets FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM caregivers
      WHERE auth_user_id = auth.uid() AND is_admin = true
    )
  );

-- Admin users can update all tickets (for resolving)
CREATE POLICY "Admins can update all tickets"
  ON support_tickets FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM caregivers
      WHERE auth_user_id = auth.uid() AND is_admin = true
    )
  );

-- Users can read their own tickets (so insert returns data)
CREATE POLICY "Users can read own tickets"
  ON support_tickets FOR SELECT
  TO authenticated
  USING (
    caregiver_id = (
      SELECT id FROM caregivers WHERE auth_user_id = auth.uid() LIMIT 1
    )
  );
