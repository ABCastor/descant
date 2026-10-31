-- Separate from readers, survives metadata synchronization's DELETE/INSERT of founders.
-- Bound to the verified email digest so reassignment never transfers a password/session.
CREATE TABLE founder_credentials (
  founderKey TEXT PRIMARY KEY,
  emailSha256 TEXT NOT NULL,
  secret TEXT,
  generation TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
ALTER TABLE founder_email_codes ADD COLUMN generation TEXT NOT NULL DEFAULT 'none';

-- A bridge link cannot upgrade the identity or credential that issued it.
ALTER TABLE onetime ADD COLUMN founderEmailSha256 TEXT;
ALTER TABLE onetime ADD COLUMN founderGeneration TEXT;
