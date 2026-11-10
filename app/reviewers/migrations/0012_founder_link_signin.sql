-- A bridge link made from a writing session carries that session's sign-in time (ms since the epoch),
-- so the session it opens ends when that session's year ends: the link cannot restart it.
-- NULL: a link the private server asked for on its founders' own listener; opening it is a new sign-in.
ALTER TABLE onetime ADD COLUMN founderSignedInAt INTEGER;
