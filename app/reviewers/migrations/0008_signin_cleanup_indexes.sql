-- Bound expiry cleanup to expired rows instead of scanning the entire table.
CREATE INDEX IF NOT EXISTS signin_failures_lastMs ON signin_failures(lastMs);
CREATE INDEX IF NOT EXISTS email_codes_expiresAt ON email_codes(expiresAt);
