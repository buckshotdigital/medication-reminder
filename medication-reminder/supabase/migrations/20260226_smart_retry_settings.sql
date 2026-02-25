-- Replace simple auto_retry toggle with smart retry settings
ALTER TABLE medications ADD COLUMN IF NOT EXISTS max_retries INTEGER DEFAULT 2;
ALTER TABLE medications ADD COLUMN IF NOT EXISTS retry_delay_minutes INTEGER DEFAULT 30;
ALTER TABLE medications ADD COLUMN IF NOT EXISTS retry_until TIME DEFAULT NULL;

-- Drop the simple toggle (just added, no data to preserve)
ALTER TABLE medications DROP COLUMN IF EXISTS auto_retry;
