ALTER TABLE email_codes ADD COLUMN recoveryHash TEXT;

CREATE TRIGGER recovery_still_live BEFORE UPDATE OF usedAt ON email_codes
WHEN NEW.usedAt IS NOT NULL AND OLD.recoveryHash IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM onetime WHERE tokenHash=OLD.recoveryHash AND kind='reset' AND subject=OLD.personId
    AND usedAt IS NULL AND expiresAt>strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'recovery link no longer live');
END;
