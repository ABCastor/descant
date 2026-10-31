-- Founder inbox proof has its own challenge table. No reader account, invitation
-- or grant is created, and only the digest of the submitted address is stored.
CREATE TABLE founder_email_codes (
  tokenHash TEXT PRIMARY KEY,
  codeHash TEXT NOT NULL,
  founderKey TEXT,
  emailSha256 TEXT NOT NULL,
  expiresAt TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  usedAt TEXT
);

CREATE INDEX founder_email_codes_expiresAt ON founder_email_codes(expiresAt);

-- The claim and the live, unambiguous founder mapping are checked inside the
-- same write. A synchronization replacing founders never cascades away copies.
CREATE TRIGGER founder_email_code_still_live BEFORE UPDATE OF usedAt ON founder_email_codes
WHEN NEW.usedAt IS NOT NULL AND (
  OLD.usedAt IS NOT NULL OR OLD.expiresAt <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now') OR OLD.attempts > 5 OR
  OLD.founderKey IS NULL OR NOT EXISTS (
    SELECT 1 FROM founders WHERE key=OLD.founderKey AND emailSha256=OLD.emailSha256
  ) OR (SELECT COUNT(*) FROM founders WHERE emailSha256=OLD.emailSha256) != 1
)
BEGIN
  SELECT RAISE(ABORT, 'founder email code no longer live');
END;
