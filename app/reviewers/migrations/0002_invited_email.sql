-- Older links have no recipient and must be replaced. Existing accounts and grants stay valid.
ALTER TABLE invites ADD COLUMN email TEXT;
