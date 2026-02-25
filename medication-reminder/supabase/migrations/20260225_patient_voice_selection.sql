-- Add preferred ElevenLabs voice per patient
ALTER TABLE patients ADD COLUMN IF NOT EXISTS preferred_voice_id TEXT;

COMMENT ON COLUMN patients.preferred_voice_id IS 'ElevenLabs voice_id to use for this patient. NULL = use agent default voice.';
