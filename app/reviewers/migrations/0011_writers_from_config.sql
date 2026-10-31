-- The writers come from the WRITERS var (src/worker/writers.ts), so the database names none:
-- founder_email_codes and founder_credentials are rebuilt as plain tables keyed by any writer key.
-- Every row, the index and the claim trigger are kept.

CREATE TABLE founder_email_codes_next (
  tokenHash TEXT PRIMARY KEY,
  codeHash TEXT NOT NULL,
  founderKey TEXT,
  emailSha256 TEXT NOT NULL,
  expiresAt TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  usedAt TEXT,
  generation TEXT NOT NULL DEFAULT 'none'
);
INSERT INTO founder_email_codes_next (tokenHash, codeHash, founderKey, emailSha256, expiresAt, attempts, usedAt, generation)
  SELECT tokenHash, codeHash, founderKey, emailSha256, expiresAt, attempts, usedAt, generation FROM founder_email_codes;
DROP TABLE founder_email_codes;
ALTER TABLE founder_email_codes_next RENAME TO founder_email_codes;
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

CREATE TABLE founder_credentials_next (
  founderKey TEXT PRIMARY KEY,
  emailSha256 TEXT NOT NULL,
  secret TEXT,
  generation TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
INSERT INTO founder_credentials_next (founderKey, emailSha256, secret, generation, updatedAt)
  SELECT founderKey, emailSha256, secret, generation, updatedAt FROM founder_credentials;
DROP TABLE founder_credentials;
ALTER TABLE founder_credentials_next RENAME TO founder_credentials;
