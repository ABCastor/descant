-- The raw code and challenge never reach the database. A pending signup has no account yet.
ALTER TABLE people ADD COLUMN emailVerifiedAt TEXT;

CREATE TABLE email_codes (
  tokenHash TEXT PRIMARY KEY,
  codeHash TEXT NOT NULL,
  email TEXT NOT NULL,
  personId TEXT,
  inviteId TEXT,
  name TEXT NOT NULL,
  secret TEXT NOT NULL,
  sessionsFrom INTEGER NOT NULL DEFAULT 0,
  expiresAt TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  usedAt TEXT
);

-- Claiming a link checks its current state inside the grant transaction, after password work.
CREATE TRIGGER invite_still_live BEFORE UPDATE OF usesLeft ON invites
WHEN NEW.usesLeft < OLD.usesLeft AND
  (OLD.revokedAt IS NOT NULL OR OLD.expiresAt <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN
  SELECT RAISE(ABORT, 'invitation no longer live');
END;

-- All effects of a correct code commit together, or none do. Account state is a snapshot of
-- the exact account that requested it; an old typed email alone cannot claim its grants.
CREATE TRIGGER email_code_still_live BEFORE UPDATE OF usedAt ON email_codes
WHEN NEW.usedAt IS NOT NULL AND (
  OLD.usedAt IS NOT NULL OR OLD.expiresAt <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now') OR OLD.attempts > 5 OR
  (OLD.personId IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM people WHERE id=OLD.personId AND email=OLD.email AND secret=OLD.secret AND sessionsFrom=OLD.sessionsFrom
  )) OR
  (OLD.inviteId IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM invites WHERE id=OLD.inviteId AND email=OLD.email AND revokedAt IS NULL AND usesLeft>0 AND expiresAt>strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  ))
)
BEGIN
  SELECT RAISE(ABORT, 'email code no longer live');
END;
