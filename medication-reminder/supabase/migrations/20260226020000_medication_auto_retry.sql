-- Per-medication toggle for automatic follow-up calls
-- When false: no retry on voicemail/no-answer, no callback on "not taken"
ALTER TABLE medications ADD COLUMN IF NOT EXISTS auto_retry BOOLEAN DEFAULT true;
