-- Add response column to support_tickets for admin replies
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS response text;
